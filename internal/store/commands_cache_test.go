package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// Store-level contract for the slash command cache (#152): the column is a raw
// JSON string the store persists verbatim (parse lives in the chat layer). Three
// states must round-trip: '' (never seeded), valid JSON (seeded table), and the
// seeded-but-empty table — the first two written via UpdateSessionCommandsCache,
// the corrupt ones via raw SQL to prove the read path survives a hand-broken row.

const wantCmdJSON = `[{"name":"model","description":"Show model","inputHint":"[on|off]"},{"name":"test","description":"Run tests"}]`

func TestUpdateSessionCommandsCache(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/session-commands-cache", "m/m")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s.CreateSession(ctx, p.ID, "t", "", "")
	if err != nil {
		t.Fatal(err)
	}

	// State 1 — never seeded: fresh session reads as the zero value.
	got, err := s.GetSession(ctx, se.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.CommandsCache != "" {
		t.Fatalf("fresh session commandsCache = %q, want empty", got.CommandsCache)
	}

	// State 2 — seeded table: write → read back the same JSON, both read paths.
	if err := s.UpdateSessionCommandsCache(ctx, se.ID, wantCmdJSON); err != nil {
		t.Fatal(err)
	}
	if got, err = s.GetSession(ctx, se.ID); err != nil {
		t.Fatal(err)
	}
	if got.CommandsCache != wantCmdJSON {
		t.Fatalf("round trip commandsCache = %q, want %q", got.CommandsCache, wantCmdJSON)
	}
	list, err := s.ListSessions(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].CommandsCache != wantCmdJSON {
		t.Fatalf("ListSessions commandsCache = %q, want %q", list[0].CommandsCache, wantCmdJSON)
	}

	// State 3 — seeded-but-empty: the empty table is a legitimate full-table
	// replace (a harness clearing its commands), NOT a return to "never seeded".
	if err := s.UpdateSessionCommandsCache(ctx, se.ID, `[]`); err != nil {
		t.Fatal(err)
	}
	if got, err = s.GetSession(ctx, se.ID); err != nil {
		t.Fatal(err)
	}
	if got.CommandsCache != `[]` {
		t.Fatalf("empty-table overwrite commandsCache = %q, want []", got.CommandsCache)
	}

	// Full-table replace: a later advertisement wholesale replaces the earlier one.
	if err := s.UpdateSessionCommandsCache(ctx, se.ID, `[{"name":"fast","description":"Toggle fast mode"}]`); err != nil {
		t.Fatal(err)
	}
	if got, err = s.GetSession(ctx, se.ID); err != nil {
		t.Fatal(err)
	}
	if got.CommandsCache != `[{"name":"fast","description":"Toggle fast mode"}]` {
		t.Fatalf("replace commandsCache = %q", got.CommandsCache)
	}

	// Cache maintenance is not content activity: updated_at must not move
	// (a mid-turn re-advertisement must not churn the sidebar secondary sort).
	before := got.UpdatedAt
	if err := s.UpdateSessionCommandsCache(ctx, se.ID, `[]`); err != nil {
		t.Fatal(err)
	}
	if got, err = s.GetSession(ctx, se.ID); err != nil {
		t.Fatal(err)
	}
	if got.UpdatedAt != before {
		t.Fatalf("updated_at moved on cache write: %d → %d", before, got.UpdatedAt)
	}
}

// TestSessionCommandsCacheCorruptRow: a corrupt commands_cache column must not
// fail the session read — the store hands the raw value up and the chat-layer
// parse degrades to nil. Legacy rows predating the column default read as ''.
func TestSessionCommandsCacheCorruptRow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "demo", "/tmp/session-commands-corrupt", "m/m")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s.CreateSession(ctx, p.ID, "t", "", "")
	if err != nil {
		t.Fatal(err)
	}
	db := sqlDB(s)
	for _, bad := range []string{`not json`, `{"a":1}`, `[1,2]`, `null`} {
		if _, err := db.Exec(`UPDATE sessions SET commands_cache=? WHERE id=?`, bad, se.ID); err != nil {
			t.Fatal(err)
		}
		got, err := s.GetSession(ctx, se.ID)
		if err != nil {
			t.Fatalf("GetSession with commands_cache=%q: %v", bad, err)
		}
		if got.CommandsCache != bad {
			t.Fatalf("corrupt row commandsCache = %q, want raw %q handed up", got.CommandsCache, bad)
		}
	}
	// Legacy row: raw insert predating the column → default '' (never seeded).
	if _, err := db.Exec(`INSERT INTO sessions(id,project_id,acp_session_id,title,model,harness,created_at,updated_at,prompted_at) VALUES('legacy','` + p.ID + `','','legacy','','omp',1,1,1)`); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetSession(ctx, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if got.CommandsCache != "" {
		t.Fatalf("legacy row commandsCache = %q, want empty", got.CommandsCache)
	}
}

// TestMigration0022ColumnShape pins the resulting schema shape: 0022 must add
// commands_cache as TEXT NOT NULL DEFAULT '' (empty string = never seeded,
// distinct from the seeded-but-empty JSON []).
func TestMigration0022ColumnShape(t *testing.T) {
	s := newTestStore(t)
	db := sqlDB(s)
	rows, err := db.Query(`SELECT type, "notnull", dflt_value FROM pragma_table_info('sessions') WHERE name='commands_cache'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatal("commands_cache column missing after migrations")
	}
	var typ string
	var notNull int
	var dflt sql.NullString
	if err := rows.Scan(&typ, &notNull, &dflt); err != nil {
		t.Fatal(err)
	}
	if typ != "TEXT" || notNull != 1 || dflt.String != "''" {
		t.Fatalf("commands_cache column shape = type=%s notnull=%d default=%q", typ, notNull, dflt.String)
	}
}

// TestSessionColumnsCount guards against silent column drift: sessionColumns
// must stay in lockstep with the scanSession scan destinations (26 columns ↔
// 26 dests after 0022). A mismatch also surfaces as a failed scan in every
// read-path test above; this pins the expected count so an accidental edit
// cannot pass unnoticed.
func TestSessionColumnsCount(t *testing.T) {
	if got := len(strings.Split(sessionColumns, ",")); got != 27 {
		t.Fatalf("sessionColumns has %d columns, want 27 (0001..0023)", got)
	}
}
