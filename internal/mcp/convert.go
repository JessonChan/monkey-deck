// Package mcp 把 monkey-deck 的 MCP server 配置(store.McpServer)转成 ACP 线上的
// acp.McpServer,并提供从 harness 配置文件(opencode opencode.json / OMP .mcp.json)
// 一次性导入的解析器。
//
// 设计边界(AGENTS.md §2.1):本包是「配置 ↔ ACP 线格式」的纯转换层,不碰 harness 子进程、
// 不碰 SQLite 连接(只依赖 store 的数据类型)。注入实际发生在 internal/acp(NewSession/Resume)。
package mcp

import (
	"fmt"

	"github.com/coder/acp-go-sdk"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// ToAcpServers 把 catalog 里选中的 server 转成 ACP 注入用的 []acp.McpServer。
//
// 传输协商:stdio 是协议基线(所有 agent MUST 支持),免协商直接转;
// http/sse 需 agent 在 Initialize 声明对应 mcpCapability,不支持就丢弃并在 skipped 里记名
// (调用方可据此提示用户「X 因 harness 不支持 http 已跳过」)。返回的切片非 nil(空也合法)。
func ToAcpServers(servers []store.McpServer, caps acp.McpCapabilities) ([]acp.McpServer, []string) {
	out := make([]acp.McpServer, 0, len(servers))
	skipped := []string{}
	for _, s := range servers {
		switch s.Transport {
		case "stdio":
			out = append(out, acp.McpServer{Stdio: &acp.McpServerStdio{
				Name:    s.Name,
				Command: s.Command,
				Args:    s.Args,
				Env:     toEnvVars(s.Env),
			}})
		case "http":
			if !caps.Http {
				skipped = append(skipped, s.Name+" (http unsupported by harness)")
				continue
			}
			out = append(out, acp.McpServer{Http: &acp.McpServerHttpInline{
				Name: s.Name, Type: "http", Url: s.URL, Headers: toHeaders(s.Headers),
			}})
		case "sse":
			if !caps.Sse {
				skipped = append(skipped, s.Name+" (sse unsupported by harness)")
				continue
			}
			out = append(out, acp.McpServer{Sse: &acp.McpServerSseInline{
				Name: s.Name, Type: "sse", Url: s.URL, Headers: toHeaders(s.Headers),
			}})
		default:
			// 防御:store 层已校验 transport,到不了这里;到了就跳过不中断其余。
			skipped = append(skipped, fmt.Sprintf("%s (unknown transport %q)", s.Name, s.Transport))
		}
	}
	return out, skipped
}

func toEnvVars(env map[string]string) []acp.EnvVariable {
	out := make([]acp.EnvVariable, 0, len(env))
	for k, v := range env {
		out = append(out, acp.EnvVariable{Name: k, Value: v})
	}
	return out
}

func toHeaders(headers map[string]string) []acp.HttpHeader {
	out := make([]acp.HttpHeader, 0, len(headers))
	for k, v := range headers {
		out = append(out, acp.HttpHeader{Name: k, Value: v})
	}
	return out
}
