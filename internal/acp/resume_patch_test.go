package acp

// resume_patch_test.go:resumePatchWriter 的单测。不依赖真 harness(纯管道字节处理)。
// 详见 resume_patch.go:补 SDK 的 ResumeSessionRequest.McpServers omitempty bug。

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"
)

// writeFrames 把若干帧(每帧自动补 '\n')经中间件写出,返回底层 buffer 内容。
func writeFrames(t *testing.T, m io.Writer, frames ...string) []byte {
	t.Helper()
	for _, f := range frames {
		if _, err := m.Write([]byte(f + "\n")); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	return nil
}

// parseParams 从一行 JSON 取出 params 子对象(map)。
func parseParams(t *testing.T, line []byte) map[string]json.RawMessage {
	t.Helper()
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(line, &frame); err != nil {
		t.Fatalf("parse frame %q: %v", line, err)
	}
	raw, ok := frame["params"]
	if !ok {
		t.Fatalf("no params in %q", line)
	}
	var p map[string]json.RawMessage
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatalf("parse params %q: %v", raw, err)
	}
	return p
}

// TestResumePatch_InjectsMissingMcpServers 缺 mcpServers 的 session/resume 帧 → 补 "mcpServers": [],
// 且顶层(jsonrpc/id/method)与同级 params(cwd/sessionId)字段全保留。
func TestResumePatch_InjectsMissingMcpServers(t *testing.T) {
	var buf bytes.Buffer
	m := newResumePatchWriter(&buf)
	writeFrames(t, m, `{"jsonrpc":"2.0","id":1,"method":"session/resume","params":{"cwd":"/tmp","sessionId":"s1"}}`)

	lines := bytes.Split(bytes.TrimRight(buf.Bytes(), "\n"), []byte("\n"))
	if len(lines) != 1 {
		t.Fatalf("want 1 frame out, got %d (%q)", len(lines), buf.String())
	}
	params := parseParams(t, lines[0])
	if string(params["mcpServers"]) != "[]" {
		t.Fatalf("mcpServers = %q, want []", params["mcpServers"])
	}
	if string(params["cwd"]) != `"/tmp"` {
		t.Fatalf("cwd field lost/changed: %s", params["cwd"])
	}
	if string(params["sessionId"]) != `"s1"` {
		t.Fatalf("sessionId field lost/changed: %s", params["sessionId"])
	}
	// 顶层字段保留。
	var frame map[string]json.RawMessage
	json.Unmarshal(lines[0], &frame)
	if string(frame["jsonrpc"]) != `"2.0"` || frame["id"] == nil || string(frame["method"]) != `"session/resume"` {
		t.Fatalf("top-level fields lost: %s", lines[0])
	}
}

// TestResumePatch_NoopWhenFieldPresent params 已有 mcpServers → 不动(上游修了 tag 就是这情况,
// 中间件自动 no-op,删掉零风险)。
func TestResumePatch_NoopWhenFieldPresent(t *testing.T) {
	var buf bytes.Buffer
	m := newResumePatchWriter(&buf)
	writeFrames(t, m, `{"jsonrpc":"2.0","id":1,"method":"session/resume","params":{"cwd":"/tmp","sessionId":"s1","mcpServers":[]}}`)

	lines := bytes.Split(bytes.TrimRight(buf.Bytes(), "\n"), []byte("\n"))
	params := parseParams(t, lines[0])
	if string(params["mcpServers"]) != "[]" {
		t.Fatalf("mcpServers changed (should be no-op): %s", params["mcpServers"])
	}
}

// TestResumePatch_NonResumeFramesByteIdentical 非 session/resume 帧(session/new / prompt / 通知)
// 字节级透传,不重新序列化(零风险、零开销)。
func TestResumePatch_NonResumeFramesByteIdentical(t *testing.T) {
	var buf bytes.Buffer
	m := newResumePatchWriter(&buf)
	frames := []string{
		`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}`,
		`{"jsonrpc":"2.0","method":"notification/cancel","params":{"id":2}}`,
		`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s1","prompt":[]}}`,
	}
	// 一次 Write 多帧(模拟 SDK 连续写;也验证按 '\n' 切行正确)。
	in := []byte(nil)
	for _, f := range frames {
		in = append(in, []byte(f+"\n")...)
	}
	if _, err := m.Write(in); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !bytes.Equal(buf.Bytes(), in) {
		t.Fatalf("non-resume frames must be byte-identical:\n in:  %q\n out: %q", in, buf.Bytes())
	}
}

// TestResumePatch_MethodCheckNotStringMatch params 里含 "session/resume" 字符串、但 method 不是它
// → 不动(证明判定靠 method 字段,不是字符串包含)。
func TestResumePatch_MethodCheckNotStringMatch(t *testing.T) {
	var buf bytes.Buffer
	m := newResumePatchWriter(&buf)
	writeFrames(t, m, `{"jsonrpc":"2.0","id":4,"method":"session/load","params":{"note":"see session/resume"}}`)
	// method 是 session/load,不应被当 resume 处理 → 原样透传(params 不增 mcpServers)。
	if !bytes.Contains(buf.Bytes(), []byte(`"note":"see session/resume"`)) {
		t.Fatalf("frame should pass through unchanged: %q", buf.String())
	}
	if bytes.Contains(buf.Bytes(), []byte(`"mcpServers"`)) {
		t.Fatalf("non-resume frame should not get mcpServers injected: %q", buf.String())
	}
}

// TestResumePatch_SimulatesBuggySDKOutput 直接模拟带 bug 的 SDK 实际产出的 resume 帧
// (无 mcpServers),验证中间件补回 —— 即真实场景的端到端(管道层)证据。
func TestResumePatch_SimulatesBuggySDKOutput(t *testing.T) {
	// 这正是 acp.ResumeSessionRequest{Cwd:"/tmp",SessionId:"s1",McpServers:[]acp.McpServer{}}
	// 在带 omitempty 的上游 SDK 下序列化的结果(无 mcpServers 字段)。
	buggyLine := `{"jsonrpc":"2.0","id":1,"method":"session/resume","params":{"cwd":"/tmp","sessionId":"s1"}}`
	var buf bytes.Buffer
	m := newResumePatchWriter(&buf)
	writeFrames(t, m, buggyLine)
	if !bytes.Contains(buf.Bytes(), []byte(`"mcpServers":[]`)) {
		t.Fatalf("middleware failed to re-inject mcpServers into buggy-SDK frame:\n in:  %s\n out: %s", buggyLine, buf.String())
	}
}
