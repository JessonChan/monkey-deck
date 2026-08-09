package chat

// export_test.go: ExportSession unit tests (AGENTS.md §5.1: temp store, no real harness).
//
// Coverage:
//   - jsonl: first-line session meta + one line per message, fields complete and
//     in ascending seq order.
//   - txt: human-readable sections (user/thought/agent/tool/plan); tool extracts
//     the main text instead of dumping JSON; plan renders as a checklist.
//   - Empty session (no messages), missing session, unsupported format: each
//     exercises its own error / degradation path.

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// newExportTestService builds a svc backed by a temp store (no harness spawn;
// pure read-path testing).
func newExportTestService(t *testing.T) (svc *ChatService, sessionID string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc = NewChatService(config.TestConfig(t.TempDir()))
	svc.ctx = context.Background()
	svc.st = st
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "Export Test", "omp", "")
	if err != nil {
		t.Fatal(err)
	}
	sessionID = se.ID
	return svc, sessionID
}

func TestExportSession_JSONL(t *testing.T) {
	svc, sid := newExportTestService(t)
	seedConversation(t, svc, sid)

	out, err := svc.ExportSession(sid, "jsonl")
	if err != nil {
		t.Fatalf("ExportSession jsonl: %v", err)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) < 6 { // 1 meta + 5 messages
		t.Fatalf("expected at least 6 lines, got %d", len(lines))
	}

	// First line: session meta.
	var meta map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &meta); err != nil {
		t.Fatalf("meta line not JSON: %v", err)
	}
	if meta["type"] != "session" || meta["id"] != sid || meta["harness"] != "omp" {
		t.Fatalf("unexpected meta: %v", meta)
	}

	// Remaining lines: messages, each valid JSON, ascending seq.
	var prevSeq float64 = -1
	for _, ln := range lines[1:] {
		var rec map[string]any
		if err := json.Unmarshal([]byte(ln), &rec); err != nil {
			t.Fatalf("message line not JSON (%q): %v", ln, err)
		}
		if rec["type"] != "message" {
			t.Fatalf("expected type=message, got %v", rec["type"])
		}
		seq, _ := rec["seq"].(float64)
		if seq <= prevSeq {
			t.Fatalf("seq not ascending: %v after %v", seq, prevSeq)
		}
		prevSeq = seq
		role, _ := rec["role"].(string)
		if role == "" {
			t.Fatalf("missing role: %v", rec)
		}
	}
}

func TestExportSession_TxtHumanReadable(t *testing.T) {
	svc, sid := newExportTestService(t)
	seedConversation(t, svc, sid)

	out, err := svc.ExportSession(sid, "txt")
	if err != nil {
		t.Fatalf("ExportSession txt: %v", err)
	}
	// Section headers present.
	for _, want := range []string{"You", "Thinking", "Assistant", "Plan"} {
		if !strings.Contains(out, want) {
			t.Errorf("txt output missing section %q\n%s", want, out)
		}
	}
	// Tool main text extracted, not raw JSON (§4.4): the tool's rawOutput is the
	// plain string "42 results"; the surrounding toolAccum JSON keys must not leak.
	if !strings.Contains(out, "42 results") {
		t.Errorf("txt output missing tool main text\n%s", out)
	}
	if strings.Contains(out, `"rawOutput"`) {
		t.Errorf("txt output leaked raw JSON key (should be human-readable)\n%s", out)
	}
	// Plan rendered as checklist markers.
	if !strings.Contains(out, "[x]") || !strings.Contains(out, "[ ]") {
		t.Errorf("txt output missing plan checklist markers\n%s", out)
	}
	// Header carries session id and harness.
	if !strings.Contains(out, sid) || !strings.Contains(out, "omp") {
		t.Errorf("txt header missing session id or harness\n%s", out)
	}
}

func TestExportSession_TxtEmptySession(t *testing.T) {
	svc, sid := newExportTestService(t)
	out, err := svc.ExportSession(sid, "txt")
	if err != nil {
		t.Fatalf("ExportSession txt empty: %v", err)
	}
	if !strings.Contains(out, "(no messages)") {
		t.Errorf("empty session txt should note no messages\n%s", out)
	}
}

func TestExportSession_JSONLEmptySession(t *testing.T) {
	svc, sid := newExportTestService(t)
	out, err := svc.ExportSession(sid, "jsonl")
	if err != nil {
		t.Fatalf("ExportSession jsonl empty: %v", err)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("empty session jsonl should be exactly the meta line, got %d lines", len(lines))
	}
}

func TestExportSession_NotFound(t *testing.T) {
	svc, _ := newExportTestService(t)
	if _, err := svc.ExportSession("does-not-exist", "txt"); err == nil {
		t.Fatal("expected error for missing session")
	}
}

func TestExportSession_UnsupportedFormat(t *testing.T) {
	svc, sid := newExportTestService(t)
	if _, err := svc.ExportSession(sid, "pdf"); err == nil {
		t.Fatal("expected error for unsupported format")
	}
}

func TestExportSession_EmptyFormatDefaultsTxt(t *testing.T) {
	svc, sid := newExportTestService(t)
	seedConversation(t, svc, sid)
	out, err := svc.ExportSession(sid, "")
	if err != nil {
		t.Fatalf("ExportSession empty format: %v", err)
	}
	if !strings.Contains(out, "───") {
		t.Errorf("empty format should default to txt (section markers)\n%s", out)
	}
}

// seedConversation writes a representative interleaved turn into the session:
// user → thought → tool(read) → agent → plan. Mirrors what persistTurn would write.
func seedConversation(t *testing.T, svc *ChatService, sid string) {
	t.Helper()
	ctx := svc.ctx
	if _, err := svc.st.AppendMessage(ctx, sid, "user", "", "please read foo", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.st.AppendMessage(ctx, sid, "thought", "agent_thought_chunk", "need to read foo first", ""); err != nil {
		t.Fatal(err)
	}
	// Tool call persisted as toolAccum JSON in content.
	ta := toolAccum{
		ID: "t1", Title: "read", Status: "completed", Kind: "read",
		RawInput: "foo.txt", RawOutput: "42 results",
	}
	body, _ := json.Marshal(ta)
	if _, err := svc.st.AppendMessage(ctx, sid, "tool", "tool_call", string(body), "t1"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.st.AppendMessage(ctx, sid, "agent", "agent_message_chunk", "here is foo", ""); err != nil {
		t.Fatal(err)
	}
	// Plan persisted as []acp.PlanEntry JSON in content.
	entries := []acp.PlanEntry{
		{Content: "done item", Status: "completed"},
		{Content: "pending item", Status: "pending"},
	}
	pb, _ := json.Marshal(entries)
	if _, err := svc.st.AppendMessage(ctx, sid, "plan", "plan", string(pb), "turn1"); err != nil {
		t.Fatal(err)
	}
}
