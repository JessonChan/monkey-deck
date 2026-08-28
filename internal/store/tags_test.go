package store

import (
	"context"
	"database/sql"
	"reflect"
	"testing"
)

// Store-level defense line for session tags (#150): the write layer must hand
// the column clean JSON — trim, drop empties, dedupe case-sensitively, cap 5 —
// and the read path must round-trip it without letting a corrupt row blank the
// session.

func TestNormalizeTags(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"trims whitespace and drops empties", []string{"  api  ", "", "   ", "\tui\n"}, []string{"api", "ui"}},
		{"all-empty input collapses to none", []string{"", "   "}, []string{}},
		{"dedupes case-sensitively (exact match)", []string{"api", "API", "api", "Api"}, []string{"api", "API", "Api"}},
		{"caps at 5 preserving first-seen order", []string{"a", "b", "c", "d", "e", "f", "g"}, []string{"a", "b", "c", "d", "e"}},
		{"dedupe does not consume the cap budget twice", []string{"a", "a", "b", "b", "c", "d", "e", "f"}, []string{"a", "b", "c", "d", "e"}},
		{"nil input → empty", nil, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := NormalizeTags(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("NormalizeTags(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestNormalizeTagsIdempotent: normalizing an already-normalized set is a
// no-op — the UI can replay the stored tags back without drift.
func TestNormalizeTagsIdempotent(t *testing.T) {
	in := []string{"  work ", "WORK", "x", "", " y", "z1", "z2", "z3"}
	once := NormalizeTags(in)
	twice := NormalizeTags(once)
	if !reflect.DeepEqual(once, twice) {
		t.Fatalf("not idempotent: once=%q twice=%q", once, twice)
	}
}

func TestUpdateSessionTags(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/session-tags", "m/m")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s.CreateSession(ctx, p.ID, "t", "", "")
	if err != nil {
		t.Fatal(err)
	}

	// Fresh session: default column value reads as an empty (non-nil) set.
	got, err := s.GetSession(ctx, se.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Tags == nil || len(got.Tags) != 0 {
		t.Fatalf("fresh session tags = %v, want empty non-nil", got.Tags)
	}

	// Round trip: write → read back the same set.
	want := []string{"api", "API", "perf"}
	if err := s.UpdateSessionTags(ctx, se.ID, want); err != nil {
		t.Fatal(err)
	}
	if got, err = s.GetSession(ctx, se.ID); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Tags, want) {
		t.Fatalf("round trip tags = %v, want %v", got.Tags, want)
	}

	// ListSessions agrees with GetSession (same scanSession path).
	list, err := s.ListSessions(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || !reflect.DeepEqual(list[0].Tags, want) {
		t.Fatalf("ListSessions tags = %v, want %v", list[0].Tags, want)
	}

	// Write layer normalizes on the way in: dirty input lands clean.
	if err := s.UpdateSessionTags(ctx, se.ID, []string{"  api ", "", "api", "x1", "x2", "x3", "x4", "x5", "x6"}); err != nil {
		t.Fatal(err)
	}
	if got, err = s.GetSession(ctx, se.ID); err != nil {
		t.Fatal(err)
	}
	want = []string{"api", "x1", "x2", "x3", "x4"}
	if !reflect.DeepEqual(got.Tags, want) {
		t.Fatalf("normalized tags = %v, want %v", got.Tags, want)
	}

	// Empty set clears all tags.
	if err := s.UpdateSessionTags(ctx, se.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got, err = s.GetSession(ctx, se.ID); err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 0 {
		t.Fatalf("cleared tags = %v, want none", got.Tags)
	}

	// Tag edits are not content activity: updated_at must not move (0008/0016
	// rationale — keeps sidebar time display + secondary sort stable).
	if err := s.UpdateSessionTags(ctx, se.ID, []string{"again"}); err != nil {
		t.Fatal(err)
	}
	after, err := s.GetSession(ctx, se.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.UpdatedAt != got.UpdatedAt {
		t.Fatalf("updated_at moved on tag edit: %d → %d", got.UpdatedAt, after.UpdatedAt)
	}
}

// TestSessionTagsCorruptRow: a corrupt tags column must degrade to an empty
// set, never fail the session read (a broken row must not blank the sidebar).
func TestSessionTagsCorruptRow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/session-tags-corrupt", "m/m")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s.CreateSession(ctx, p.ID, "t", "", "")
	if err != nil {
		t.Fatal(err)
	}
	db := sqlDB(s)
	for _, bad := range []string{`not json`, `{"a":1}`, `[1,2]`, `null`} {
		if _, err := db.Exec(`UPDATE sessions SET tags=? WHERE id=?`, bad, se.ID); err != nil {
			t.Fatal(err)
		}
		got, err := s.GetSession(ctx, se.ID)
		if err != nil {
			t.Fatalf("GetSession with tags=%q: %v", bad, err)
		}
		if got.Tags == nil || len(got.Tags) != 0 {
			t.Fatalf("tags=%q read back as %v, want empty non-nil", bad, got.Tags)
		}
	}
	// Legacy rows predating the column default (raw insert without tags).
	if _, err := db.Exec(`INSERT INTO sessions(id,project_id,acp_session_id,title,model,harness,created_at,updated_at,prompted_at) VALUES('legacy','` + p.ID + `','','legacy','','omp',1,1,1)`); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetSession(ctx, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 0 {
		t.Fatalf("legacy row tags = %v, want empty", got.Tags)
	}
}

// Guard the column presence + default directly, independent of Go plumbing:
// 0021 must add TEXT NOT NULL DEFAULT '[]' and re-running must stay a no-op
// (ALTER TABLE ADD COLUMN is single-statement idempotent per SQLite semantics
// only when not re-run — the runner applies each version once; here we pin the
// resulting schema shape).
func TestMigration0021ColumnShape(t *testing.T) {
	s := newTestStore(t)
	db := sqlDB(s)
	rows, err := db.Query(`SELECT type, "notnull", dflt_value FROM pragma_table_info('sessions') WHERE name='tags'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatal("tags column missing after migrations")
	}
	var typ string
	var notNull int
	var dflt sql.NullString
	if err := rows.Scan(&typ, &notNull, &dflt); err != nil {
		t.Fatal(err)
	}
	if typ != "TEXT" || notNull != 1 || dflt.String != "'[]'" {
		t.Fatalf("tags column shape = type=%s notnull=%d default=%q", typ, notNull, dflt.String)
	}
}
