package chat

// fork_watermark_test.go — #189 ForkSession watermark hardening: atomicity of
// the fork row on a watermark persist failure. A fork row wearing the badge
// with fork_base_seq=0 reopens own-only (empty history) — worse than
// surfacing the error — so ForkSession must fail loud and remove the row.
//
// Failure injection: a SQLite trigger RAISE(ABORT)s only the watermark UPDATE
// (fork_base_seq > 0), created through an independent handle on the same temp
// DB file. The preceding INSERT (CreateSession) and metadata UPDATEs
// (worktree / forked_from, fork_base_seq still 0) pass untouched, and the
// cleanup is a DELETE, which the trigger does not fire on.

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
	// Driver registration for the test-side injection handle (also transitively
	// registered via store; kept explicit as the direct user in this file).
	_ "modernc.org/sqlite"
)

func TestForkSessionWatermarkPersistFatal(t *testing.T) {
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
	// The empty-source guard rejects watermark-less forks; seed a real exchange.
	if _, err := st.AppendMessage(svc.ctx, se.ID, "user", "", "hello", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendMessage(svc.ctx, se.ID, "agent", "", "hi", ""); err != nil {
		t.Fatal(err)
	}

	// Inject the failure at exactly the SetSessionForkBaseSeq step.
	inj, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	inj.SetMaxOpenConns(1)
	if _, err := inj.Exec(`CREATE TRIGGER md_inject_watermark_failure
		BEFORE UPDATE ON sessions WHEN NEW.fork_base_seq > 0
		BEGIN SELECT RAISE(ABORT, 'injected watermark persist failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := inj.Close(); err != nil {
		t.Fatal(err)
	}

	fc := newFakeChat()
	fc.canFork = true
	fc.forkResult = acp.ForkResult{NewSessionID: "fork-acp-1", ConfigOptions: forkModelOption()}
	injectFakeChat(t, svc, se.ID, fc, false)

	fresh, err := svc.ForkSession(se.ID)
	if err == nil {
		t.Fatal("expected watermark persist failure to fail ForkSession")
	}
	if !strings.Contains(err.Error(), "fork: persist fork watermark") {
		t.Fatalf("error = %v, want wrapped \"fork: persist fork watermark\"", err)
	}
	if !strings.Contains(err.Error(), "injected watermark persist failure") {
		t.Fatalf("error = %v, want the injected trigger cause (failure must come from the watermark step)", err)
	}
	if fresh != nil {
		t.Fatalf("fork row returned on failure: %+v", fresh)
	}
	// Atomicity: the fresh row must not survive — only the source remains.
	list, err := st.ListSessions(svc.ctx, proj.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != se.ID {
		t.Fatalf("sessions = %d, want 1 (source only) — fresh row must be cleaned up", len(list))
	}
}
