package chat

// fork_fakeagent_test.go — real-wire ForkSession e2e (#172 Phase 2, §5.1
// exception: no REAL harness — a minimal in-binary fake ACP agent, no key, no
// network). The agent runs in the re-executed test binary (helper-process
// pattern, same as internal/acp's TestFakeAgentHelper):
//
//	MD_CHAT_FAKE_AGENT_CHILD=1  <testbin> -test.run=^TestChatForkFakeAgentHelper$ --
//
// The agent ALWAYS declares sessionCapabilities.fork (+ resume/close/list,
// loadSession) and mints deterministic session ids: session/new → fake-sess-1,
// every fork → fake-sess-N. That pins the full production path through
// ForkSession: ensureLive → startLive → spawn → Initialize → session/new →
// session/fork → DB row, with the declared-bit gate read from a genuine
// Initialize response.
//
// Why a chat-local helper instead of reusing internal/acp's: the acp fake agent
// lives in the acp package's TEST binary, which does not exist at the chat
// package's test time — each package re-executes its own binary.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/harness"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// TestChatForkFakeAgentHelper is not a real test: with MD_CHAT_FAKE_AGENT_CHILD=1
// it acts as the fake harness child process; without the env var it returns
// immediately so normal test runs are unaffected.
func TestChatForkFakeAgentHelper(t *testing.T) {
	if os.Getenv("MD_CHAT_FAKE_AGENT_CHILD") != "1" {
		return
	}
	chatFakeAgentMain()
	// Exit before the testing framework prints its PASS banner — stdout is
	// the JSON-RPC channel and must stay clean.
	os.Exit(0)
}

// chatFakeAgentMain speaks a minimal ACP JSON-RPC dialect on stdio (newline-
// delimited JSON, matching the SDK's bufio.Scanner framing). Declared-only:
// initialize advertises fork/resume/close/list + loadSession; session/new seeds
// fake-sess-1 with one model configOption; session/fork mints fake-sess-N and
// echoes the same configOptions (probe ⑤ shape); prompts answer end_turn;
// unknown methods get -32601.
func chatFakeAgentMain() {
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
		Params struct {
			SessionId string `json:"sessionId"`
		} `json:"params"`
	}

	sessions := map[string]bool{"fake-sess-1": true}
	nextID := 2

	sessionConfig := func() (opts []any, modes any) {
		opts = []any{map[string]any{
			"type":         "select",
			"id":           "model",
			"name":         "Model",
			"category":     "model",
			"currentValue": "fake-model",
			"options":      []any{map[string]any{"value": "fake-model", "name": "Fake Model"}},
		}}
		modes = map[string]any{
			"currentModeId": "code",
			"availableModes": []any{
				map[string]any{"id": "code", "name": "Code"},
			},
		}
		return opts, modes
	}
	withModes := func(result map[string]any) map[string]any {
		if _, modes := sessionConfig(); modes != nil {
			result["modes"] = modes
		}
		return result
	}

	for sc.Scan() {
		var m rpcMsg
		if json.Unmarshal(sc.Bytes(), &m) != nil || m.Method == "" || len(m.ID) == 0 {
			continue // notification or malformed line: nothing to answer
		}
		defaultErr := func() {
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"error":   map[string]any{"code": -32601, "message": "method not found: " + m.Method},
			})
		}
		switch m.Method {
		case "initialize":
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result": map[string]any{
					"protocolVersion": 1,
					"agentCapabilities": map[string]any{
						"loadSession":        true,
						"promptCapabilities": map[string]any{},
						"sessionCapabilities": map[string]any{
							"fork":   map[string]any{},
							"list":   map[string]any{},
							"resume": map[string]any{},
							"close":  map[string]any{},
						},
					},
				},
			})
		case "session/new":
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"sessionId": "fake-sess-1", "configOptions": opts}),
			})
		case "session/prompt":
			sid := m.Params.SessionId
			if sid == "" {
				sid = "fake-sess-1"
			}
			enc(map[string]any{
				"jsonrpc": "2.0",
				"method":  "session/update",
				"params": map[string]any{
					"sessionId": sid,
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
				"result":  map[string]any{"stopReason": "end_turn"},
			})
		case "session/fork":
			if !sessions[m.Params.SessionId] {
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"error":   map[string]any{"code": -32602, "message": "unknown session: " + m.Params.SessionId},
				})
				continue
			}
			id := fmt.Sprintf("fake-sess-%d", nextID)
			nextID++
			sessions[id] = true
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"sessionId": id, "configOptions": opts}),
			})
		case "session/list":
			ids := make([]string, 0, len(sessions))
			for id := range sessions {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			list := make([]any, 0, len(ids))
			for _, id := range ids {
				list = append(list, map[string]any{"sessionId": id, "cwd": "/tmp/fake-agent"})
			}
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  map[string]any{"sessions": list},
			})
		case "session/load", "session/resume":
			if !sessions[m.Params.SessionId] {
				enc(map[string]any{
					"jsonrpc": "2.0",
					"id":      m.ID,
					"error":   map[string]any{"code": -32602, "message": "unknown session: " + m.Params.SessionId},
				})
				continue
			}
			opts, _ := sessionConfig()
			enc(map[string]any{
				"jsonrpc": "2.0",
				"id":      m.ID,
				"result":  withModes(map[string]any{"configOptions": opts}),
			})
		case "session/close":
			delete(sessions, m.Params.SessionId)
			enc(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{}})
		default:
			defaultErr()
		}
	}
}

// TestForkSessionFakeAgentDeclared walks the REAL production path: ensureLive →
// startLive → spawn fakeagent → Initialize (declared bit) → session/new →
// session/fork → DB row. Asserts the row-level contract end to end:
// forked_from / cwd / harness / project / title (+ the fork response's pinned
// ACP id and config-options cache).
func TestForkSessionFakeAgentDeclared(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// NewRunner splits the command on whitespace (no quoting), so a test
	// binary path with spaces cannot be spawned.
	if strings.ContainsAny(exe, " \t") {
		t.Skipf("test binary path contains spaces: %s", exe)
	}
	t.Setenv("MD_CHAT_FAKE_AGENT_CHILD", "1")

	// Register the fake agent as a user harness so harness.Command("fakefork")
	// resolves to the helper-process command (SetUserHarnesses is process-global;
	// restore the previous list afterwards).
	cmd := fmt.Sprintf("%s -test.run=^TestChatForkFakeAgentHelper$ --", exe)
	prev := harness.UserHarnesses()
	harness.SetUserHarnesses(append(prev, harness.UserHarness{ID: "fakefork", Name: "Fake Fork", Command: cmd}))
	t.Cleanup(func() { harness.SetUserHarnesses(prev) })

	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewChatService(config.TestConfig(t.TempDir()))
	svc.spawnFn = svc.startLive // REAL spawn path (ServiceStartup wires the same)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	svc.ctx = ctx
	svc.st = st
	t.Cleanup(func() { _ = svc.ServiceShutdown() })

	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "src title", "", "fakefork")
	if err != nil {
		t.Fatal(err)
	}

	// #172 Phase 3: empty-conversation guard — seed an exchange first.
	if _, err := st.AppendMessage(svc.ctx, se.ID, "user", "", "hello", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendMessage(svc.ctx, se.ID, "agent", "", "hi", ""); err != nil {
		t.Fatal(err)
	}

	fresh, err := svc.ForkSession(se.ID)
	if err != nil {
		t.Fatalf("ForkSession: %v", err)
	}
	if fresh.ID == se.ID {
		t.Fatal("fork row id must differ from source")
	}
	if fresh.ForkedFrom != se.ID {
		t.Fatalf("forked_from = %q, want %q", fresh.ForkedFrom, se.ID)
	}
	// Rule ② same-cwd fork: no worktree on the source → fork pinned to nothing
	// new (project dir semantics); nothing about the source changed.
	if fresh.WorktreePath != "" || fresh.Branch != "" {
		t.Fatalf("fork must not create a worktree: got %q/%q", fresh.WorktreePath, fresh.Branch)
	}
	if fresh.ProjectID != proj.ID {
		t.Fatalf("project = %q, want %q", fresh.ProjectID, proj.ID)
	}
	if fresh.Harness != "fakefork" {
		t.Fatalf("harness = %q, want fakefork", fresh.Harness)
	}
	if fresh.Title != "src title (fork)" {
		t.Fatalf("title = %q, want %q", fresh.Title, "src title (fork)")
	}
	// The fake agent mints fake-sess-2 for the first fork — the fork response's
	// own new id, pinned for the next open's resume.
	if fresh.ACPSession != "fake-sess-2" {
		t.Fatalf("acp session = %q, want fake-sess-2", fresh.ACPSession)
	}
	// DB round-trip: the fork row (with lineage + ACP id) is durable.
	got, err := st.GetSession(svc.ctx, fresh.ID)
	if err != nil || got == nil {
		t.Fatalf("fork row missing in db: %v", err)
	}
	if got.ForkedFrom != se.ID || got.ACPSession != "fake-sess-2" || got.Title != "src title (fork)" {
		t.Fatalf("db row mismatch: %+v", got)
	}
	// Source row untouched (same ACP session id, no lineage).
	srcGot, _ := st.GetSession(svc.ctx, se.ID)
	if srcGot.ACPSession != "fake-sess-1" || srcGot.ForkedFrom != "" {
		t.Fatalf("source row changed: %+v", srcGot)
	}
	// configOptions cache from the fork response (echoed model option).
	if !strings.Contains(got.ConfigOptionsCache, "fake-model") {
		t.Fatalf("config cache should carry the fork response's model option, got %q", got.ConfigOptionsCache)
	}

	// #172 Phase 3 lineage: the fork row carries a real watermark and its
	// transcript view = source prefix (offsets -N..-1) + its own rows; source
	// rows appended AFTER the fork must not leak into the fork's view.
	if got.ForkBaseSeq != 2 {
		t.Fatalf("fork_base_seq = %d, want 2 (source max seq at fork time)", got.ForkBaseSeq)
	}
	st.AppendMessage(svc.ctx, se.ID, "user", "", "post-fork source-only", "")
	view, err := svc.LoadMessagesPage(fresh.ID, 0, 50)
	if err != nil {
		t.Fatalf("fork transcript view: %v", err)
	}
	joined := ""
	for _, m := range view {
		joined += m.Content
	}
	if joined != "hellohi" {
		t.Fatalf("fork transcript = %q, want %q (post-fork source message excluded)", joined, "hellohi")
	}
	if len(view) > 0 && view[len(view)-1].SessionID != fresh.ID {
		t.Fatalf("base rows must be presented under the fork's session id")
	}
}
