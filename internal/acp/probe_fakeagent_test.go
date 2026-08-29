package acp

// probe_fakeagent_test.go — regression test for the codebuddy nil-panic bug.
//
// A harness whose initialize response omits the optional agentInfo field used
// to crash ProbeHarness with a nil-pointer dereference at rep.AgentName =
// initResp.AgentInfo.Name; Wails3 recovered the panic into a binding
// CallError, surfacing as "自检失败" in the add-harness modal.
//
// The test re-executes the test binary itself as a minimal fake ACP harness
// (classic exec helper-process pattern; no real harness, no key, no network —
// §5.1) whose initialize response deliberately omits agentInfo, then runs the
// full probe against it. Before the fix this test panics; after it, the probe
// must pass Tier 1 with an empty AgentName.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestProbeHarnessOmittedAgentInfo(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// NewRunner splits the command on whitespace (no quoting), so a test
	// binary path with spaces cannot be spawned.
	if strings.ContainsAny(exe, " \t") {
		t.Skipf("test binary path contains spaces: %s", exe)
	}
	t.Setenv("MD_FAKE_HARNESS_CHILD", "1")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	rep := ProbeHarness(ctx, fmt.Sprintf("%s -test.run=^TestFakeAgentHelper$ --", exe))

	if rep.Error != "" {
		t.Fatalf("probe error: %s", rep.Error)
	}
	if !rep.Initialized.Pass {
		t.Fatalf("initialized check failed: %+v", rep.Initialized)
	}
	if !rep.CanAdd() {
		t.Fatalf("expected CanAdd=true, got report:\n%s", rep.Summary())
	}
	if rep.AgentName != "" {
		t.Fatalf("expected empty AgentName (agentInfo omitted on the wire), got %q", rep.AgentName)
	}
	if rep.Initialized.Note != "agent=(未自报) protocol=1" {
		t.Fatalf("expected readable fallback in Initialized.Note, got %q", rep.Initialized.Note)
	}
	if !rep.Streamed.Pass || !rep.EmitsMessageId {
		t.Fatalf("expected streamed chunks with messageId, got report:\n%s", rep.Summary())
	}
}

// TestFakeAgentHelper is not a real test: with MD_FAKE_HARNESS_CHILD=1 it acts
// as the fake harness child process; without the env var it returns
// immediately so normal test runs are unaffected.
func TestFakeAgentHelper(t *testing.T) {
	if os.Getenv("MD_FAKE_HARNESS_CHILD") != "1" {
		return
	}
	fakeAgentMain()
	// Exit before the testing framework prints its PASS banner — stdout is
	// the JSON-RPC channel and must stay clean.
	os.Exit(0)
}

// fakeAgentMain speaks a minimal ACP JSON-RPC dialect on stdio (newline-
// delimited JSON, matching the SDK's bufio.Scanner framing):
//
//	initialize      → protocolVersion=1, agentCapabilities, NO agentInfo
//	session/new     → sessionId=fake-sess-1, no configOptions
//	session/prompt  → one agent_message_chunk (with messageId), then
//	                  stopReason=end_turn (1st) / cancelled (cancel probe)
//
// Everything else gets a JSON-RPC method-not-found error; notifications
// (session/cancel from the probe's cancel check) are ignored.
func fakeAgentMain() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	out := bufio.NewWriter(os.Stdout)
	enc := func(v any) {
		b, _ := json.Marshal(v)
		out.Write(b)
		out.WriteByte('\n')
		_ = out.Flush()
	}

	type rpcMsg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	prompts := 0
	for sc.Scan() {
		var m rpcMsg
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.Method == "" || len(m.ID) == 0 {
			continue // notification or malformed line: nothing to answer
		}
		switch m.Method {
		case "initialize":
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result": map[string]any{
					"protocolVersion": 1,
					// agentInfo intentionally omitted — the regression scenario.
					"agentCapabilities": map[string]any{
						"loadSession":        false,
						"promptCapabilities": map[string]any{},
						"sessionCapabilities": map[string]any{},
					},
				},
			})
		case "session/new":
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result": map[string]any{
					"sessionId":     "fake-sess-1",
					"configOptions": []any{},
				},
			})
		case "session/prompt":
			prompts++
			stop := "end_turn"
			if prompts > 1 {
				stop = "cancelled" // cancel probe expects stopReason=cancelled
			}
			enc(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": "fake-sess-1",
					"update": map[string]any{
						"sessionUpdate": "agent_message_chunk",
						"content":       map[string]any{"type": "text", "text": "OK"},
						"messageId":     "m1",
					},
				},
			})
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  map[string]any{"stopReason": stop},
			})
		default:
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"error":   map[string]any{"code": -32601, "message": "method not found: " + m.Method},
			})
		}
	}
}
