package mcp

// import.go:从 harness 的 MCP 配置 JSON 一次性导入 catalog。
//
// 支持两种方言(字段差异见 docs/worklog;简表):
//   - opencode (opencode.json 的 "mcp" 段):type "local"|"remote";local 的 command 是数组、
//     环境变量键是 "environment";remote 用 url+headers。
//   - OMP (.mcp.json 的 "mcpServers" 段):type "stdio"|"http"|"sse";command 是字符串 + args 数组、
//     环境变量键是 "env";http/sse 用 url+headers;另有 cwd/timeout/auth/oauth(ACP 不承载,丢弃/告警)。
//
// 这是「导入」不是「发现」:一次性解析进 store.McpServer(无 id,由 store.CreateMcpServer 生成),
// 文件即弃。去重(name 已在 catalog)由 store 的 UNIQUE 约束在调用方逐条 Create 时处理。

import (
	"encoding/json"
	"fmt"

	"github.com/jessonchan/monkey-deck/internal/store"
)

// ImportReport 汇总一次导入的结果(给人话呈现,§4.4)。
type ImportReport struct {
	Imported []string // 成功解析的 server 名(待 Create;是否真入库看调用方去重)
	Warnings []string // 字段丢失 / 可能失败的告警(per-server)
	Errors   []string // 完全无法解析的 server(per-server + 原因)
}

// ImportAuto 自动识别格式并解析。顶层有 "mcp" → opencode;有 "mcpServers" → OMP;都没有 → 报错。
func ImportAuto(data []byte) ([]store.McpServer, ImportReport, error) {
	var top struct {
		Mcp        map[string]json.RawMessage `json:"mcp"`
		McpServers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &top); err != nil {
		return nil, ImportReport{}, fmt.Errorf("parse mcp json: %w", err)
	}
	switch {
	case len(top.Mcp) > 0:
		return parseOpencode(top.Mcp)
	case len(top.McpServers) > 0:
		return parseOmp(top.McpServers)
	default:
		return nil, ImportReport{}, fmt.Errorf(`no "mcp" or "mcpServers" key found (not an opencode/OMP MCP config)`)
	}
}

// parseOpencode 解析 opencode 方言。
func parseOpencode(servers map[string]json.RawMessage) ([]store.McpServer, ImportReport, error) {
	out := []store.McpServer{}
	var rep ImportReport
	for name, raw := range servers {
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			rep.Errors = append(rep.Errors, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		typ, _ := obj["type"].(string) // opencode local 是默认(省略 type)
		if typ == "" {
			typ = "local"
		}
		switch typ {
		case "local":
			cmdArr, _ := obj["command"].([]any)
			if len(cmdArr) == 0 {
				rep.Errors = append(rep.Errors, fmt.Sprintf("%s: local server missing command", name))
				continue
			}
			command, args := splitCommand(cmdArr)
			out = append(out, store.McpServer{
				Name: name, Transport: "stdio", Command: command, Args: args,
				Env: strMap(obj["environment"]), DefaultEnabled: true,
			})
			rep.Imported = append(rep.Imported, name)
		case "remote":
			url, _ := obj["url"].(string)
			if url == "" {
				rep.Errors = append(rep.Errors, fmt.Sprintf("%s: remote server missing url", name))
				continue
			}
			out = append(out, store.McpServer{
				Name: name, Transport: "http", URL: url,
				Headers: strMap(obj["headers"]), DefaultEnabled: true,
			})
			rep.Imported = append(rep.Imported, name)
		default:
			rep.Errors = append(rep.Errors, fmt.Sprintf("%s: unknown opencode type %q", name, typ))
		}
	}
	return out, rep, nil
}

// parseOmp 解析 OMP .mcp.json 方言。cwd/timeout 静默丢弃;auth/oauth 告警(ACP 鉴权不了)。
func parseOmp(servers map[string]json.RawMessage) ([]store.McpServer, ImportReport, error) {
	out := []store.McpServer{}
	var rep ImportReport
	for name, raw := range servers {
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			rep.Errors = append(rep.Errors, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		typ, _ := obj["type"].(string) // OMP stdio 是默认(省略 type)
		if typ == "" {
			typ = "stdio"
		}
		enabled := true
		if e, ok := obj["enabled"].(bool); ok {
			enabled = e
		}
		switch typ {
		case "stdio":
			command, _ := obj["command"].(string)
			if command == "" {
				rep.Errors = append(rep.Errors, fmt.Sprintf("%s: stdio server missing command", name))
				continue
			}
			out = append(out, store.McpServer{
				Name: name, Transport: "stdio", Command: command,
				Args: strSlice(obj["args"]), Env: strMap(obj["env"]), DefaultEnabled: enabled,
			})
			rep.Imported = append(rep.Imported, name)
		case "http", "sse":
			url, _ := obj["url"].(string)
			if url == "" {
				rep.Errors = append(rep.Errors, fmt.Sprintf("%s: %s server missing url", name, typ))
				continue
			}
			m := store.McpServer{
				Name: name, Transport: typ, URL: url,
				Headers: strMap(obj["headers"]), DefaultEnabled: enabled,
			}
			out = append(out, m)
			rep.Imported = append(rep.Imported, name)
		default:
			rep.Errors = append(rep.Errors, fmt.Sprintf("%s: unknown OMP type %q", name, typ))
			continue
		}
		// 字段丢失告警:auth/oauth 走 ACP 鉴权不了,cwd/timeout 协议无对应。
		if _, ok := obj["auth"]; ok {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("%s: uses auth/oauth (not supported by ACP; may fail to connect)", name))
		} else if _, ok := obj["oauth"]; ok {
			rep.Warnings = append(rep.Warnings, fmt.Sprintf("%s: uses oauth (not supported by ACP; may fail to connect)", name))
		}
	}
	return out, rep, nil
}

// splitCommand 把 opencode 的 command 数组拆成 [可执行文件, ...args]。
func splitCommand(arr []any) (string, []string) {
	if len(arr) == 0 {
		return "", nil
	}
	first, _ := arr[0].(string)
	rest := make([]string, 0, len(arr)-1)
	for _, a := range arr[1:] {
		s, _ := a.(string)
		rest = append(rest, s)
	}
	return first, rest
}

func strSlice(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, a := range arr {
		s, _ := a.(string)
		out = append(out, s)
	}
	return out
}

func strMap(v any) map[string]string {
	m, _ := v.(map[string]any)
	out := make(map[string]string, len(m))
	for k, val := range m {
		s, _ := val.(string)
		out[k] = s
	}
	return out
}
