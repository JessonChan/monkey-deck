package acp

// resume_patch.go —— 临时兜底:补 acp-go-sdk 的 ResumeSessionRequest.McpServers omitempty bug。
//
// ┌────────────────────────────────────────────────────────────────────────────┐
// │ ⚠️ 这是一个 WORKAROUND,上游修了就要删。删除步骤见本文件底部。                  │
// └────────────────────────────────────────────────────────────────────────────┘
//
// 背景(根因,2026-07-28 排查):
// acp-go-sdk v0.13.5 的 types_gen.go 里,三个 session 请求类型的 McpServers json tag 不一致:
//   - NewSessionRequest.McpServers   → `json:"mcpServers"`            (无 omitempty ✓)
//   - LoadSessionRequest.McpServers  → `json:"mcpServers"`            (无 omitempty ✓)
//   - ResumeSessionRequest.McpServers → `json:"mcpServers,omitempty"` ← 唯一有 omitempty ✗
// 我们恢复 session 时传空 McpServers([]acp.McpServer{},monkey-deck 不配 MCP server),
// omitempty 把空切片整体丢掉 → 出站的 session/resume JSON 里没有 mcpServers 字段 →
// 严格 harness(如 junie,Kotlin kotlinx.serialization @Required)反序列化失败:
//   {"code":-32700,"message":"Field 'mcpServers' is required ... but it was missing"}
// ACP 规范要求 session/resume 带 mcpServers,所以是 SDK 的 bug(NewSession/LoadSession 都没加 omitempty,
// 且它们的 Validate() 强制 McpServers!=nil,唯独 ResumeSession 漏了)。
//
// 为什么不从 SDK 层修(走 third_party replace / fork / vendor):保持仓库对所有人可编译、不背本地 SDK
// 副本。已给上游提 issue(coder/acp-go-sdk)。在等上游修期间,用本中间件在「出站管道」上把字段补回。
//
// 做法:NewClientSideConnection 的 peerInput(= harness stdin)外面包一层 resumePatchWriter。
// SDK 每条出站消息 = 一个 JSON 对象 + '\n'(见 acp-go-sdk connection.go 的 Marshal + append '\n' +
// 单次 Write)。中间件按 '\n' 切行,仅对 method=="session/resume" 且 params 缺 mcpServers 的帧,
// 注入 "mcpServers": [] 后重新序列化;其余帧原样透传(字节不变,零解析开销)。
//
// 不变量(保证安全 + 上游修后自动 no-op):
//   - 只动 session/resume 帧;其它帧(newsession/load/prompt/close/通知…)字节透传。
//   - 只在 params 里【确实没有】mcpServers 时补;已有则不动 → 上游修了 tag、字段本就在,
//     本中间件自然变成 no-op,删掉零风险(单测 TestResumePatch_NoopWhenFieldPresent 锁这一点)。
//   - 顶层字段(jsonrpc/id/method/params)用 map[string]json.RawMessage 整体回写,不丢字段。
//
// ── 删除步骤(上游 coder/acp-go-sdk 去掉该 omitempty 并发版后)─────────────────
//   1. 删本文件(resume_patch.go)与 resume_patch_test.go。
//   2. internal/acp/runner.go 里搜 RESUME_PATCH,把那行改回直接传 stdin(去掉 newResumePatchWriter 包装)。
//   3. go test ./internal/acp/ 应仍全绿(届时 SDK 自带字段,无依赖此中间件的逻辑)。
// ──────────────────────────────────────────────────────────────────────────────

import (
	"bytes"
	"encoding/json"
	"io"
)

// resumePatchWriter 包裹 harness stdin,补 session/resume 帧缺失的 mcpServers 字段。
// 详见文件头注释。
type resumePatchWriter struct {
	w   io.Writer // 真正的 harness stdin
	buf []byte    // 跨 Write 的不完整行缓冲(防御分块写;SDK 实际一帧一 Write)
}

// newResumePatchWriter 包裹 w,返回可传给 NewClientSideConnection 的 peerInput。
// 上游 SDK 修复后删除本函数 + 调用点的包装即可(见文件头删除步骤)。
func newResumePatchWriter(w io.Writer) io.Writer {
	return &resumePatchWriter{w: w}
}

func (m *resumePatchWriter) Write(p []byte) (int, error) {
	m.buf = append(m.buf, p...)
	var out []byte
	// 按 '\n' 切完整行处理;末尾不完整行留 buf 等下次 Write 补全(SDK 一帧一 Write,通常无残留)。
	for {
		i := bytes.IndexByte(m.buf, '\n')
		if i < 0 {
			break
		}
		line := m.buf[:i]
		m.buf = m.buf[i+1:]
		out = append(out, m.patchResumeLine(line)...)
		out = append(out, '\n')
	}
	if len(out) > 0 {
		if _, err := m.w.Write(out); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// patchResumeLine 处理一行(不含 '\n'):session/resume 且缺 mcpServers → 补 [];否则原样返回。
func (m *resumePatchWriter) patchResumeLine(line []byte) []byte {
	// 快速过滤:不含该方法名的帧直接透传(避免无谓 unmarshal)。这是优化,不是判定;
	// 真正判定靠下面的 method == "session/resume"(防其它帧 params 里恰好含该字符串)。
	if !bytes.Contains(line, []byte(`"session/resume"`)) {
		return line
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(line, &frame); err != nil {
		return line // 非 JSON / 解析失败:原样返回,不破坏帧
	}
	var method string
	if raw, ok := frame["method"]; ok {
		_ = json.Unmarshal(raw, &method)
	}
	if method != "session/resume" {
		return line
	}
	// params 是嵌套对象;解析、补字段、回填。
	var params map[string]json.RawMessage
	if raw, ok := frame["params"]; ok {
		if err := json.Unmarshal(raw, &params); err != nil {
			return line // params 非对象(理论不会),不动
		}
	}
	if params == nil {
		params = map[string]json.RawMessage{}
	}
	if _, ok := params["mcpServers"]; ok {
		return line // 字段已存在(上游修后 / harness 自己带的):不动,no-op
	}
	params["mcpServers"] = json.RawMessage(`[]`)
	newParams, err := json.Marshal(params)
	if err != nil {
		return line
	}
	frame["params"] = newParams
	fixed, err := json.Marshal(frame)
	if err != nil {
		return line
	}
	return fixed
}
