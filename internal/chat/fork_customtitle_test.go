package chat

// fork_customtitle_test.go — #190 fork title inheritance: a user-renamed
// source (custom_title) hands its name to the fork as custom_title+" (fork)",
// which is immune to harness title churn (UpdateSessionTitle writes the title
// column only). Without a rename the legacy behavior stands: title gets the
// " (fork)" suffix, custom_title stays empty.
//
// Failure injection mirrors fork_watermark_test.go: an independent SQLite
// handle installs a trigger that RAISE(ABORT)s only the fork's custom-title
// UPDATE (NEW.custom_title gains a " (fork)" suffix). The custom title is set
// BEFORE the trigger exists, so the fixture itself is unaffected.

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
	// Driver registration for the test-side injection handle (also transitively
	// registered via store; kept explicit as the direct user in this file).
	_ "modernc.org/sqlite"
)

// forkCustomTitleFixture builds svc + project + renamed source session on a
// fresh temp DB, returning the DB path so a failure-injection trigger can be
// installed through an independent handle.
func forkCustomTitleFixture(t *testing.T) (*ChatService, *store.Project, *store.Session, string) {
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
	// Empty-conversation guard: seed a real exchange (watermark = seq 2).
	if _, err := st.AppendMessage(svc.ctx, se.ID, "user", "", "hello", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendMessage(svc.ctx, se.ID, "agent", "", "hi", ""); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateSessionCustomTitle(svc.ctx, se.ID, "my custom name"); err != nil {
		t.Fatal(err)
	}
	// Keep the in-memory view aligned with the DB row.
	se.CustomTitle = "my custom name"
	return svc, proj, se, dbPath
}

// forkDeclaredFake builds a fakeChat with a declared fork surface returning a
// fixed fork response (same shape as the other fork tests use).
func forkDeclaredFake() *fakeChat {
	fc := newFakeChat()
	fc.canFork = true
	fc.forkResult = acp.ForkResult{NewSessionID: "fork-acp-1", ConfigOptions: forkModelOption()}
	return fc
}

// TestForkSessionCustomTitleInherits: renamed source → the fork row carries
// custom_title = "<custom> (fork)" with the bare source harness title in the
// title column; a later harness title update must not touch the inherited
// custom_title (the immunity is the whole point of #190).
func TestForkSessionCustomTitleInherits(t *testing.T) {
	svc, _, se, _ := forkCustomTitleFixture(t)
	injectFakeChat(t, svc, se.ID, forkDeclaredFake(), false)

	fresh, err := svc.ForkSession(se.ID)
	if err != nil {
		t.Fatalf("ForkSession: %v", err)
	}
	if fresh.CustomTitle != "my custom name (fork)" {
		t.Fatalf("custom_title = %q, want %q", fresh.CustomTitle, "my custom name (fork)")
	}
	if fresh.Title != "source title" {
		t.Fatalf("title = %q, want the bare source harness title %q (no suffix)", fresh.Title, "source title")
	}
	// Badge coexistence (#190 spec item 4): the fork row must carry BOTH badge
	// sources at once — forked_from (fork badge) and custom_title (rename
	// pencil) — or the sidebar tells only half the story.
	if fresh.ForkedFrom != se.ID {
		t.Fatalf("forked_from = %q, want %q (fork badge must coexist with the rename badge)", fresh.ForkedFrom, se.ID)
	}
	got, err := svc.st.GetSession(svc.ctx, fresh.ID)
	if err != nil || got == nil {
		t.Fatalf("fork row missing in db: %v", err)
	}
	if got.CustomTitle != "my custom name (fork)" || got.Title != "source title" || got.ForkedFrom != se.ID {
		t.Fatalf("db row mismatch: custom_title=%q title=%q forked_from=%q", got.CustomTitle, got.Title, got.ForkedFrom)
	}
	// Immunity: a harness-side title regeneration writes the title column only.
	if err := svc.st.UpdateSessionTitle(svc.ctx, fresh.ID, "harness regenerated"); err != nil {
		t.Fatal(err)
	}
	got, err = svc.st.GetSession(svc.ctx, fresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CustomTitle != "my custom name (fork)" {
		t.Fatalf("custom_title = %q after harness title update, want unchanged", got.CustomTitle)
	}
	if got.Title != "harness regenerated" {
		t.Fatalf("title = %q after harness update, want %q", got.Title, "harness regenerated")
	}
}

// TestForkSessionCustomTitlePersistFailureSilent: a failed custom-title
// inherit (injected via trigger) must not block the fork — the row survives
// with the bare source title and an empty custom_title, lineage intact.
func TestForkSessionCustomTitlePersistFailureSilent(t *testing.T) {
	svc, _, se, dbPath := forkCustomTitleFixture(t)

	inj, err := sql.Open("sqlite", "file:"+dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	inj.SetMaxOpenConns(1)
	if _, err := inj.Exec(`CREATE TRIGGER md_inject_custom_title_failure
		BEFORE UPDATE ON sessions
		WHEN NEW.custom_title LIKE '% (fork)' AND NEW.custom_title <> OLD.custom_title
		BEGIN SELECT RAISE(ABORT, 'injected custom title persist failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := inj.Close(); err != nil {
		t.Fatal(err)
	}

	injectFakeChat(t, svc, se.ID, forkDeclaredFake(), false)

	fresh, err := svc.ForkSession(se.ID)
	if err != nil {
		t.Fatalf("ForkSession: %v (custom title persist failure must not block the fork)", err)
	}
	got, err := svc.st.GetSession(svc.ctx, fresh.ID)
	if err != nil || got == nil {
		t.Fatalf("fork row missing in db: %v", err)
	}
	// Degraded display: custom_title empty, bare source harness title in title.
	if got.CustomTitle != "" {
		t.Fatalf("custom_title = %q, want empty after the injected failure", got.CustomTitle)
	}
	if got.Title != "source title" {
		t.Fatalf("title = %q, want the bare source harness title", got.Title)
	}
	// The rest of the fork row is healthy: lineage, pinned ACP id, watermark.
	if got.ForkedFrom != se.ID || got.ACPSession != "fork-acp-1" || got.ForkBaseSeq != 2 {
		t.Fatalf("fork row damaged by the custom title failure: %+v", got)
	}
}
