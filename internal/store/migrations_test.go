package store

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
)

// TestMigration0020ReadBasenameRewrite validates the 0020 migration SQL against legacy
// rows (#143): global-allow read rules pinned absolute paths get rewritten to the basename
// so cross-project same-name reads match; write/exec rules and user-authored globs are
// untouched; re-running is a no-op (idempotent).
//
// The runner applies all migrations inside New, so legacy pre-0020 rows cannot exist in a
// New()-opened store. Instead the test replays the real SQL file (read through the same
// embed FS the runner uses) over a scratch copy of the 0009 table.
func TestMigration0020ReadBasenameRewrite(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// Seed legacy rows (shapes as stored by pre-#143 ExactMatchRule / hand-authored rules).
	legacy := []PermissionRule{
		{ID: "r-read-abs", ToolName: "read", ActionType: "read", PathPattern: "/projA/src/notes.md", Level: "allow", Enabled: true},
		{ID: "r-read-abs-deep", ToolName: "read", ActionType: "read", PathPattern: "/a/b/c/Makefile", Level: "allow", Enabled: true},
		{ID: "r-read-abs-disabled", ToolName: "read", ActionType: "read", PathPattern: "/projA/other.md", Level: "allow", Enabled: false},
		{ID: "r-write-abs", ToolName: "edit", ActionType: "write", PathPattern: "/projA/notes.md", Level: "allow", Enabled: true},
		{ID: "r-exec-cmd", ToolName: "execute", ActionType: "exec", CommandPattern: `^git status$`, Level: "allow", Enabled: true},
		{ID: "r-read-ask", ToolName: "read", ActionType: "read", PathPattern: "/projA/ask.md", Level: "ask", Enabled: true},
		{ID: "r-read-glob", ToolName: "read", ActionType: "read", PathPattern: "docs/*.md", Level: "allow", Enabled: true},
	}
	for _, r := range legacy {
		if _, err := s.CreatePermissionRule(ctx, r); err != nil {
			t.Fatalf("seed %s: %v", r.ID, err)
		}
	}

	// Replay the real migration file over the seeded table (the runner already applied it
	// on an empty table, which is a no-op there; here it sees legacy data).
	b, err := migrationFS.ReadFile("migrations/0020_permission_read_basename.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	db := sqlDB(s)
	if _, err := db.Exec(string(b)); err != nil {
		t.Fatalf("apply migration: %v", err)
	}

	want := map[string]string{
		"r-read-abs":          "notes.md",        // rewritten to basename
		"r-read-abs-deep":     "Makefile",        // deep path → basename
		"r-read-abs-disabled": "other.md",        // disabled rows rewrite too (re-enabling keeps new semantics)
		"r-write-abs":         "/projA/notes.md", // write untouched
		"r-exec-cmd":          "",                // exec untouched (no path)
		"r-read-ask":          "/projA/ask.md",   // non-allow untouched
		"r-read-glob":         "docs/*.md",       // user-authored glob untouched
	}
	assertPaths(t, s, ctx, want)

	// Idempotency: second run changes nothing.
	if _, err := db.Exec(string(b)); err != nil {
		t.Fatalf("re-apply migration: %v", err)
	}
	assertPaths(t, s, ctx, want)
}

func assertPaths(t *testing.T, s *Store, ctx context.Context, want map[string]string) {
	t.Helper()
	rules, err := s.ListPermissionRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, r := range rules {
		got[r.ID] = r.PathPattern
	}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("rule %s path = %q, want %q", id, got[id], w)
		}
	}
}

// sqlDB exposes the underlying handle for raw-SQL assertions (tests only).
func sqlDB(s *Store) *sql.DB { return s.db }

// TestMigration0025ForkWatermarkBackfill validates the 0025 migration SQL against
// legacy fork rows (#189): forks created before the watermark mechanism (0024,
// a7c9b9b) carry forked_from with fork_base_seq=0, and LoadMessagesPage's guard
// (ForkBaseSeq <= 0) falls back to own-only — the fork reopens with an empty
// history. The backfill reconstructs the watermark as the source's max message
// seq at/before the fork's created_at (inclusive), so post-fork source messages
// never leak into the lineage prefix. Sources with no messages at/before the
// boundary keep 0 (lineage stays off, same as today). Rows already carrying a
// real watermark and non-fork rows are untouched; re-running is a no-op.
//
// Same replay pattern as TestMigration0020ReadBasenameRewrite: the runner applies
// the file inside New on empty tables, so the test re-runs the real SQL (through
// the same embed FS) over seeded legacy-shaped rows.
func TestMigration0025ForkWatermarkBackfill(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	proj, err := s.CreateProject(ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	src, err := s.CreateSession(ctx, proj.ID, "src", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	fork, err := s.CreateSession(ctx, proj.ID, "src (fork)", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	orphanFork, err := s.CreateSession(ctx, proj.ID, "src (fork)", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	watermarked, err := s.CreateSession(ctx, proj.ID, "src (fork)", "", "omp")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := s.CreateSession(ctx, proj.ID, "plain", "", "omp")
	if err != nil {
		t.Fatal(err)
	}

	// Pin every timestamp/seq: the backfill is pure boundary arithmetic, so the
	// test must not depend on wall-clock now() collisions.
	db := sqlDB(s)
	pinSessionAt := func(id string, ts int64) {
		t.Helper()
		if _, err := db.Exec(`UPDATE sessions SET created_at=? WHERE id=?`, ts, id); err != nil {
			t.Fatalf("pin created_at %s: %v", id, err)
		}
	}
	pinSessionAt(src.ID, 1000)
	// Boundary sits mid-history: source messages exist on both sides of the fork.
	pinSessionAt(fork.ID, 5000)
	// Before any source message: no in-boundary rows → stays 0.
	pinSessionAt(orphanFork.ID, 1500)
	pinSessionAt(watermarked.ID, 5000)
	pinSessionAt(plain.ID, 9000)

	for _, f := range []struct{ id, from string }{
		{fork.ID, src.ID}, {orphanFork.ID, src.ID}, {watermarked.ID, src.ID},
	} {
		if err := s.SetSessionForkedFrom(ctx, f.id, f.from); err != nil {
			t.Fatal(err)
		}
	}
	// A fork that already carries a real watermark must not be rewritten.
	if err := s.SetSessionForkBaseSeq(ctx, watermarked.ID, 7); err != nil {
		t.Fatal(err)
	}

	// Source history spanning the boundary; seq 3 sits exactly ON it (the
	// predicate is inclusive), seq 4 after (must be excluded).
	insertMsg := func(seq, ts int64) {
		t.Helper()
		_, err := db.Exec(`INSERT INTO messages(id,session_id,role,kind,content,seq,created_at) VALUES(?,?,?,?,?,?,?)`,
			fmt.Sprintf("m%d", seq), src.ID, "user", "", fmt.Sprintf("msg-%d", seq), seq, ts)
		if err != nil {
			t.Fatalf("seed message %d: %v", seq, err)
		}
	}
	insertMsg(1, 2000)
	insertMsg(2, 4000)
	insertMsg(3, 5000)
	insertMsg(4, 6000)

	// Replay the real migration file over the seeded rows.
	b, err := migrationFS.ReadFile("migrations/0025_session_fork_watermark_backfill.sql")
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if _, err := db.Exec(string(b)); err != nil {
		t.Fatalf("apply migration: %v", err)
	}

	assertForkBaseSeq := func(id string, want int64) {
		t.Helper()
		got, err := s.GetSession(ctx, id)
		if err != nil || got == nil {
			t.Fatalf("get session %s: %v", id, err)
		}
		if got.ForkBaseSeq != want {
			t.Errorf("session %s fork_base_seq = %d, want %d", id, got.ForkBaseSeq, want)
		}
	}
	// MAX(seq) at/before the boundary = 3 (the exactly-at-boundary row counts).
	assertForkBaseSeq(fork.ID, 3)
	// Source has no messages at/before the fork → keeps 0 (lineage stays off).
	assertForkBaseSeq(orphanFork.ID, 0)
	// Real watermark untouched by the <= 0 guard.
	assertForkBaseSeq(watermarked.ID, 7)
	// Non-fork row untouched.
	assertForkBaseSeq(plain.ID, 0)

	// Idempotency: second run changes nothing.
	if _, err := db.Exec(string(b)); err != nil {
		t.Fatalf("re-apply migration: %v", err)
	}
	assertForkBaseSeq(fork.ID, 3)
	assertForkBaseSeq(orphanFork.ID, 0)
	assertForkBaseSeq(watermarked.ID, 7)
	assertForkBaseSeq(plain.ID, 0)
}
