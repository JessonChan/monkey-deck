// Package permissions 实现分级访问控制(AGENTS.md §3.4:有人在场,可交互)。
//
// 在 ACP 的 RequestPermission 回调里(工具执行前),按规则集路由裁决:
//
//   - allow → 自动放行(不弹窗)
//   - deny  → 自动拒绝(不弹窗)
//   - ask   → 弹前端确认(当前默认行为)
//
// 规则维度(命中 = 全部非空约束同时满足,空约束 = 通配):
//   - ToolName:ACP ToolKind 字符串(read/edit/execute/...)
//   - ActionType:动作分组(read/write/exec),由 ToolKind 派生
//   - PathPattern:glob,对 ToolCall 的任一 location 命中即算命中
//   - CommandPattern:正则,对从 RawInput 抽取的命令(bash 等)匹配
//
// 本包是纯逻辑(无 DB / 无 ACP 依赖),单测注入规则即可(§5.1)。
package permissions

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// 决策档位(§3.4)。
const (
	LevelAllow = "allow" // 自动放行
	LevelAsk   = "ask"   // 弹前端确认
	LevelDeny  = "deny"  // 自动拒绝
)

// 动作分组(由 ToolKind 派生,§3.4「按动作类型 read/write/exec」)。
const (
	ActionRead = "read" // read/search/think/fetch
	ActionWrite = "write" // edit/delete/move
	ActionExec  = "exec"  // execute
	ActionOther = "other" // switch_mode/other/未知
	ActionAny   = "any"   // 通配:规则不限动作
)

// Rule 一条权限规则。空约束字段 = 通配。
//
// 命中语义:一条规则命中,当且仅当它的所有非空约束同时被满足(AND)。
// 规则集按 SortOrder 升序逐条判定,首条命中者决定裁决;无命中 → fallback。
type Rule struct {
	ID             string `json:"id"`
	ToolName       string `json:"toolName"`       // 匹配 ACP ToolKind;"" = 任意工具
	ActionType     string `json:"actionType"`     // read/write/exec/other/any;"" 视作 any
	PathPattern    string `json:"pathPattern"`    // glob(对任一 location);"" = 任意路径
	CommandPattern string `json:"commandPattern"` // 正则(对抽取的命令);仅 exec 相关;"" = 任意命令
	Level          string `json:"level"`          // allow | ask | deny
	SortOrder      int    `json:"sortOrder"`      // 优先级:小者先判定
	Enabled        bool   `json:"enabled"`
}

// MatchRequest 一次权限判定的输入(从 acp.RequestPermissionRequest 提取)。
type MatchRequest struct {
	ToolKind  string         // req.ToolCall.Kind
	Locations []string       // req.ToolCall.Locations[].Path(已展平)
	RawInput  any            // req.ToolCall.RawInput(用于抽命令)
}

// Engine 规则匹配器(不可变快照,便于并发读)。零值可用(无规则 → 一律 fallback)。
type Engine struct {
	rules []Rule
	// 编译缓存(避免每次 match 重编译正则)。key = 规则下标。
	compiled []*regexp.Regexp
	bad      []bool // 编译失败的规则(匹配时跳过)
}

// NewEngine 构造一个规则匹配器。传入的 rules 按给定 SortOrder 判定(调用方负责排序)。
func NewEngine(rules []Rule) *Engine {
	e := &Engine{
		rules:    rules,
		compiled: make([]*regexp.Regexp, len(rules)),
		bad:      make([]bool, len(rules)),
	}
	for i, r := range rules {
		if r.CommandPattern == "" {
			continue
		}
		re, err := regexp.Compile(r.CommandPattern)
		if err != nil {
			e.bad[i] = true // 非法正则:跳过该规则(不致整引擎崩)
			continue
		}
		e.compiled[i] = re
	}
	return e
}

// Decide 返回裁决(allow/ask/deny)。无规则命中时返回 fallback(默认 ask)。
func (e *Engine) Decide(req MatchRequest, fallback string) string {
	action := ActionOfKind(req.ToolKind)
	cmd := ExtractCommand(req.RawInput)
	for i, r := range e.rules {
		if !r.Enabled || e.bad[i] {
			continue
		}
		if !matchTool(r.ToolName, req.ToolKind) {
			continue
		}
		if !matchAction(r.ActionType, action) {
			continue
		}
		if !matchPaths(r.PathPattern, req.Locations) {
			continue
		}
		if !matchCommand(e.compiled[i], r.CommandPattern, cmd) {
			continue
		}
		return normalizeLevel(r.Level)
	}
	return normalizeLevel(fallback)
}

// ActionOfKind 把 ACP ToolKind 派生为动作分组(§3.4 read/write/exec)。
// 未知/空 kind 归 other。
func ActionOfKind(kind string) string {
	switch strings.ToLower(kind) {
	case "read", "search", "think", "fetch":
		return ActionRead
	case "edit", "delete", "move":
		return ActionWrite
	case "execute":
		return ActionExec
	default:
		return ActionOther
	}
}

// ExtractCommand 从工具 RawInput 抽取命令字符串(镜像前端 extractBashCommand,§4.4)。
// 覆盖:字符串原样返回;对象取 command/cmd/line;argv 数组拼回单行。抽不到返回空。
func ExtractCommand(raw any) string {
	switch v := raw.(type) {
	case string:
		return v
	case map[string]any:
		for _, k := range []string{"command", "cmd", "line"} {
			if s, ok := v[k].(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
		if argv, ok := v["argv"].([]any); ok && len(argv) > 0 {
			parts := make([]string, 0, len(argv))
			for _, a := range argv {
				parts = append(parts, fmt.Sprint(a))
			}
			return strings.Join(parts, " ")
		}
	}
	return ""
}

func matchTool(ruleTool, reqTool string) bool {
	if ruleTool == "" {
		return true
	}
	return strings.EqualFold(ruleTool, reqTool)
}

func matchAction(ruleAction, reqAction string) bool {
	a := strings.ToLower(strings.TrimSpace(ruleAction))
	if a == "" || a == ActionAny {
		return true
	}
	return a == reqAction
}

func matchPaths(pattern string, locs []string) bool {
	if pattern == "" {
		return true
	}
	if len(locs) == 0 {
		return false // 规则限定了路径,但本次请求无 location → 不命中
	}
	for _, p := range locs {
		if matchPath(pattern, p) {
			return true // 任一 location 命中即算命中(工具触及多路径,只要有一个落在规则范围)
		}
	}
	return false
}

// matchPath 单条路径匹配。支持多种语义(贴近用户直觉,参考 .gitignore 约定):
//   - "**" 或 "" → 通配(由调用方在 matchPaths 处理,这里恒 true)
//   - "dir/**" → dir 及其子树(前缀,含 dir 自身)
//   - 不含 "/" 的 pattern(如 "*.go"、"Makefile")→ 对完整路径与 basename 各 Match 一次
//     (用户写 *.go 通常希望匹配任意目录下的 .go 文件)
//   - 含 "/" 的 glob → filepath.Match(单层 *,不跨 /)
//   - 无元字符 → 路径等于或位于该目录前缀下
func matchPath(pattern, path string) bool {
	if pattern == "" || pattern == "**" {
		return true
	}
	sep := string(os.PathSeparator)
	// "dir/**" → 前缀(包含 dir 自身)
	if strings.HasSuffix(pattern, "/**") {
		dir := strings.TrimSuffix(pattern, "/**")
		return path == dir || strings.HasPrefix(path, dir+sep) || strings.HasPrefix(path, dir+"/")
	}
	// 无 "/" 的 pattern:对全路径与 basename 各试一次(贴近 .gitignore)
	if !strings.Contains(pattern, "/") {
		if ok, err := filepath.Match(pattern, path); err == nil && ok {
			return true
		}
		if base := filepath.Base(path); base != "" {
			if ok, err := filepath.Match(pattern, base); err == nil && ok {
				return true
			}
		}
		// 无元字符且无 /:视作 basename 精确匹配
		if !hasGlobMeta(pattern) {
			return filepath.Base(path) == pattern
		}
		return false
	}
	if ok, err := filepath.Match(pattern, path); err == nil && ok {
		return true
	}
	// 无 glob 元字符 → 目录前缀匹配(规则写成目录,覆盖其下所有文件)
	if !hasGlobMeta(pattern) {
		return path == pattern || strings.HasPrefix(path, pattern+sep) || strings.HasPrefix(path, pattern+"/")
	}
	return false
}

func hasGlobMeta(s string) bool {
	return strings.ContainsAny(s, "*?[")
}

func matchCommand(re *regexp.Regexp, pattern, cmd string) bool {
	if pattern == "" {
		return true // 未限定命令 = 通配
	}
	if cmd == "" {
		return false // 规则限定了命令,但本次请求抽不到命令 → 不命中
	}
	if re == nil {
		return false // 编译失败的正则,构造时已标记跳过;兜底不命中
	}
	return re.MatchString(cmd)
}

func normalizeLevel(s string) string {
	switch strings.ToLower(s) {
	case LevelAllow, LevelDeny:
		return strings.ToLower(s)
	default:
		return LevelAsk // 未知/空 → ask(最安全,保留人工裁决)
	}
}

// ExactMatchRule 根据一次权限请求构造「准确匹配」的 allow 规则(§3.4「全局允许」决策用)。
//
// 用户在前端选「全局允许」(onRespond("global"))时,把当前请求的标识固化成一条
// level=allow 的规则,使后续「同工具 + 同命令」或「同工具 + 同路径」的请求被规则引擎
// 自动放行——跨 session / 跨 project 全局生效(区别于 session/project 仅内存记忆、随
// session 生灭)。规则经 service 持久化进 DB,刷新全部活跃 session 的规则快照后即刻生效。
//
// 标识选取(「准确匹配」= 复现当前请求所需的全部非空约束,AND 语义):
//   - ToolName = req.ToolKind(精确工具,主判别项;不同 kind 不会误命中)
//   - ActionType = ActionOfKind(ToolKind)(与 kind 一致,供分组/展示)
//   - 有命令(exec 类):CommandPattern = ^转义命令$(锚定 + 转义元字符,严格全等)
//   - 无命令有路径(fs 类):PathPattern = 首个 location 原值(引擎按「任一 location 命中」
//     判定,当前请求含该路径 → 自身可复现;多路径请求只能取其一,见下方注释)
//   - 无命令无路径:仅按工具+动作匹配(可表达的最窄「同工具」语义)
//
// 纯逻辑、无副作用,单测直接验证输入→规则形状(§5.1)。
func ExactMatchRule(req MatchRequest) Rule {
	rule := Rule{
		ToolName:   req.ToolKind,
		ActionType: ActionOfKind(req.ToolKind),
		Level:      LevelAllow,
		Enabled:    true,
	}
	if cmd := ExtractCommand(req.RawInput); cmd != "" {
		// 锚定 + 转义:命令作为正则全等匹配,避免元字符/前缀误命中。
		rule.CommandPattern = "^" + regexp.QuoteMeta(cmd) + "$"
		return rule
	}
	if len(req.Locations) > 0 {
		// 取首个 location:引擎 matchPaths 对「任一 location 命中」算命中,当前请求必含
		// 该路径故自身可复现。多路径请求的完整集合无法用单条 glob 表达(取首个为最佳近似)。
		rule.PathPattern = req.Locations[0]
		return rule
	}
	return rule
}
