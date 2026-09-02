package chat

// fork_test.go — ForkSession unit tests (#172 Phase 2, mock-injected, §5.1: no
// real harness). Covers the three iron rules at the service layer:
//
//   - declared bit gate (rule ①): undeclared → typed acp.ErrForkNotDeclared,
//     no RPC, no row;
//   - same-cwd fork (rule ②): the new row shares the source's worktree path +
//     branch (no new worktree / baseRef), and inherits project/model/harness;
//   - serial use (rule ③): a busy source (turn in flight) is rejected before
//     any spawn.
//
// The real-wire path (fakeagent declared) lives in fork_fakeagent_test.go.

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// injectFakeChat returns a spawnFn that registers ls{chat: fc} for sessionID in
// s.active (simulating a live harness) and counts spawn attempts. A nil fc with
// failOnSpawn=true makes any ensureLive call fail the test (busy-guard test).
func injectFakeChat(t *testing.T, svc *ChatService, sessionID string, fc *fakeChat, failOnSpawn bool) *int32 {
	t.Helper()
	var n int32
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		if failOnSpawn {
			t.Fatal("spawnFn must not be called on this path")
		}
		n++
		ls := &liveSession{chat: fc, proj: proj, harnessID: se.Harness, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		return nil
	}
	return &n
}

// forkModelOption builds one model config option as the flattened fork response
// payload (mirrors what fakeagent echoes in the e2e test).
func forkModelOption() []acp.ConfigOption {
	return []acp.ConfigOption{{
		ID:           "model",
		Name:         "Model",
		Category:     "model",
		CurrentValue: "fake-model",
		Options:      []acp.ConfigOptionEntry{{Value: "fake-model", Name: "Fake Model"}},
	}}
}

// newForkTestSource creates svc + project + source session with a worktree
// mounted (to assert rule ② same-cwd semantics through the real store paths).
func newForkTestSource(t *testing.T) (*ChatService, *store.Project, *store.Session) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewChatService(config.TestConfig(t.TempDir()))
	svc.ctx = context.Background()
	svc.st = st
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "source title", "fake/model", "fakeharness")
	if err != nil {
		t.Fatal(err)
	}
	wtPath := filepath.Join(t.TempDir(), "wt")
	if err := st.SetSessionWorktree(svc.ctx, se.ID, wtPath, "md/srcbranch"); err != nil {
		t.Fatal(err)
	}
	// #172 Phase 3: the empty-conversation guard rejects sources with no
	// messages — seed one exchange so forking is meaningful (and so the fork
	// row's watermark is a real seq).
	if _, err := st.AppendMessage(svc.ctx, se.ID, "user", "", "hello", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendMessage(svc.ctx, se.ID, "agent", "", "hi", ""); err != nil {
		t.Fatal(err)
	}
	// Keep the in-memory view aligned with the DB row (production CreateSession
	// does the same after SetSessionWorktree) — assertions compare against it.
	se.WorktreePath, se.Branch = wtPath, "md/srcbranch"
	return svc, proj, se
}

// TestForkSessionDeclaredCreatesRow: declared fake → fork succeeds; the new row
// shares source worktree (rule ②), inherits project/model/harness, carries
// forked_from + " (fork)" title, pins the fork's ACP id, and persists the fork
// RESPONSE's configOptions as the read-only cache.
func TestForkSessionDeclaredCreatesRow(t *testing.T) {
	svc, proj, se := newForkTestSource(t)
	fc := newFakeChat()
	fc.canFork = true
	fc.forkResult = acp.ForkResult{NewSessionID: "fork-acp-1", ConfigOptions: forkModelOption()}
	injectFakeChat(t, svc, se.ID, fc, false)

	fresh, err := svc.ForkSession(se.ID)
	if err != nil {
		t.Fatalf("ForkSession: %v", err)
	}
	if fresh.ID == se.ID {
		t.Fatal("fork row id must differ from source")
	}
	// Iron rule ②: same worktree path + branch, nothing new created.
	if fresh.WorktreePath != se.WorktreePath || fresh.Branch != se.Branch {
		t.Fatalf("fork must share source worktree: got %q/%q want %q/%q",
			fresh.WorktreePath, fresh.Branch, se.WorktreePath, se.Branch)
	}
	// Row inheritance.
	if fresh.ProjectID != se.ProjectID || fresh.Harness != se.Harness || fresh.Model != se.Model {
		t.Fatalf("fork must inherit project/model/harness: %+v", fresh)
	}
	if fresh.ForkedFrom != se.ID {
		t.Fatalf("forked_from = %q, want %q", fresh.ForkedFrom, se.ID)
	}
	if fresh.Title != "source title (fork)" {
		t.Fatalf("title = %q, want %q", fresh.Title, "source title (fork)")
	}
	if fresh.CustomTitle != "" {
		t.Fatalf("custom_title = %q, want empty (source has no rename; legacy title-only path)", fresh.CustomTitle)
	}
	if fresh.ACPSession != "fork-acp-1" {
		t.Fatalf("acp session = %q, want fork-acp-1 (pinned from fork response)", fresh.ACPSession)
	}
	if fresh.ProjectID != proj.ID {
		t.Fatalf("project = %q, want %q", fresh.ProjectID, proj.ID)
	}
	// Everything above must survive a DB round-trip (written, not just echoed).
	got, err := svc.st.GetSession(svc.ctx, fresh.ID)
	if err != nil || got == nil {
		t.Fatalf("fork row missing in db: %v", err)
	}
	if got.ForkedFrom != se.ID || got.WorktreePath != se.WorktreePath ||
		got.Harness != se.Harness || got.ProjectID != proj.ID || got.Title != "source title (fork)" {
		t.Fatalf("db row mismatch: %+v", got)
	}
	// configOptions cache = fork response's own options (probe ⑤: consume from response).
	var cache []acp.ConfigOption
	if err := json.Unmarshal([]byte(got.ConfigOptionsCache), &cache); err != nil {
		t.Fatalf("config cache not valid json: %v (%q)", err, got.ConfigOptionsCache)
	}
	if len(cache) != 1 || cache[0].ID != "model" || cache[0].CurrentValue != "fake-model" {
		t.Fatalf("config cache mismatch: %+v", cache)
	}
	// Exactly one fork row was created.
	list, _ := svc.st.ListSessions(svc.ctx, proj.ID)
	if len(list) != 2 {
		t.Fatalf("session count = %d, want 2 (source + fork)", len(list))
	}
}

// TestForkSessionUndeclaredTypedError: undeclared fake → typed sentinel error
// (rule ①), no RPC, no row.
func TestForkSessionUndeclaredTypedError(t *testing.T) {
	svc, _, se := newForkTestSource(t)
	fc := newFakeChat() // canFork=false
	fc.forkErr = errors.New("Fork must not be reached when undeclared")
	calls := injectFakeChat(t, svc, se.ID, fc, false)

	_, err := svc.ForkSession(se.ID)
	if !errors.Is(err, acp.ErrForkNotDeclared) {
		t.Fatalf("err = %v, want errors.Is(acp.ErrForkNotDeclared)", err)
	}
	if !strings.Contains(err.Error(), "sessionCapabilities.fork") {
		t.Fatalf("error should name the missing capability, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "must not be reached") {
		t.Fatalf("Fork RPC must not be reached when undeclared, got %q", err.Error())
	}
	// The source was NOT live: ensureLive legitimately spawns once to obtain
	// the authoritative declared bit; the gate then rejects before session/fork.
	if *calls != 1 {
		t.Fatalf("spawn count = %d, want 1 (ensureLive spawn precedes the gate)", *calls)
	}
	list, _ := svc.st.ListSessions(svc.ctx, se.ProjectID)
	if len(list) != 1 {
		t.Fatalf("undeclared fork must not create a row: %d rows", len(list))
	}
}

// TestForkSessionSourceBusyRejected: source mid-turn → busy error before any
// spawn / RPC (rule ③), and no row is created.
func TestForkSessionSourceBusyRejected(t *testing.T) {
	svc, _, se := newForkTestSource(t)
	// Simulate a live session with a turn in flight (busy set under sendMu in
	// production; no concurrency here).
	svc.mu.Lock()
	svc.active[se.ID] = &liveSession{chat: newFakeChat(), index: map[string]*turnEntry{}, busy: true}
	svc.mu.Unlock()
	injectFakeChat(t, svc, se.ID, nil, true) // spawn must not happen

	_, err := svc.ForkSession(se.ID)
	if !errors.Is(err, errForkSourceBusy) {
		t.Fatalf("err = %v, want errForkSourceBusy", err)
	}
	list, _ := svc.st.ListSessions(svc.ctx, se.ProjectID)
	if len(list) != 1 {
		t.Fatalf("busy rejection must not create a row: %d rows", len(list))
	}
}

// TestForkSessionMissingSource: unknown session id → error, nothing touched.
func TestForkSessionMissingSource(t *testing.T) {
	svc, _, _ := newForkTestSource(t)
	if _, err := svc.ForkSession("no-such-session"); err == nil {
		t.Fatal("expected error for missing source session")
	}
}

// TestForkSessionSourceError: declared fake whose Fork RPC fails → the error
// propagates and no row is created (fork response is the only row-writer).
func TestForkSessionSourceError(t *testing.T) {
	svc, _, se := newForkTestSource(t)
	fc := newFakeChat()
	fc.canFork = true
	fc.forkErr = acp.ErrForkNotDeclared // arbitrary non-nil wire error
	injectFakeChat(t, svc, se.ID, fc, false)

	if _, err := svc.ForkSession(se.ID); err == nil {
		t.Fatal("expected fork RPC error to propagate")
	}
	list, _ := svc.st.ListSessions(svc.ctx, se.ProjectID)
	if len(list) != 1 {
		t.Fatalf("failed fork must not create a row: %d rows", len(list))
	}
}
