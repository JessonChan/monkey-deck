package store

import (
	"context"
	"database/sql"
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
