package store

// messages_test.go: UpsertTurnMessage regression (#125 incremental persistence).
//
// Coverage:
//   - Idempotence: repeated upserts with the same key leave one row, content
//     updated in place, seq/id stable (rows keep their first-appearance
//     position; replays never reorder history, §5.4 #5); created_at refreshes
//     on write (the turn-end reconcile writes last, so the final value ≈ turn
//     end — preserving the old time semantics, #68).
//   - New keys: insert a new row with seq = MAX(seq)+1 within the session.
//   - Same entry_key across turns: no conflict (turn_id is part of the key).
//   - Legacy rows: rows written by AppendMessage (entry_key='') stay outside
//     dedupe and coexist with upserted rows.

import (
	"context"
	"path/filepath"
	"testing"
)

func newUpsertTestSession(t *testing.T) (*Store, string) {
	t.Helper()
	s := newTestStore(t)
	ctx := context.Background()
	p, err := s.CreateProject(ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s.CreateSession(ctx, p.ID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return s, se.ID
}

func TestUpsertTurnMessageIdempotent(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// First write (partial content from the flush phase).
	m1, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:agent", "agent", "agent_message_chunk", "部分回", "")
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	// Same-key replay: content grows (final full text from the reconcile phase).
	m2, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:agent", "agent", "agent_message_chunk", "部分回复全文", "")
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	// Third replay (same content, reconcile re-entry).
	if _, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:agent", "agent", "agent_message_chunk", "部分回复全文", ""); err != nil {
		t.Fatalf("third upsert: %v", err)
	}

	msgs, err := s.ListMessages(ctx, sid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("idempotence broken: want 1 row, got %d: %+v", len(msgs), msgs)
	}
	got := msgs[0]
	if got.Content != "部分回复全文" {
		t.Fatalf("content not updated in place: %q", got.Content)
	}
	if got.TurnID != "turn-1" || got.EntryKey != "msg:m1:agent" {
		t.Fatalf("keys not persisted: %+v", got)
	}
	// Same row: id/seq stable (upsert doesn't reorder or swap rows); created_at
	// refreshes on write (see above).
	if m1.ID != m2.ID || m1.Seq != m2.Seq {
		t.Fatalf("row identity moved: first=%+v second=%+v", m1, m2)
	}
	if m2.CreatedAt < m1.CreatedAt {
		t.Fatalf("created_at must not go backwards: %d -> %d", m1.CreatedAt, m2.CreatedAt)
	}
	if got.ID != m1.ID || got.Seq != m1.Seq {
		t.Fatalf("stored row differs from first write: %+v vs %+v", got, m1)
	}
}

func TestUpsertTurnMessageNewKeysAppendInOrder(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// The user message (AppendMessage, entry_key='') lands first; incremental
	// entries then insert in timeline order.
	if _, err := s.AppendMessage(ctx, sid, "user", "", "问", ""); err != nil {
		t.Fatal(err)
	}
	first, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m1:thought", "thought", "agent_thought_chunk", "想", "")
	if err != nil {
		t.Fatal(err)
	}
	tool, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "T1", "tool", "tool_call", `{"id":"T1"}`, "T1")
	if err != nil {
		t.Fatal(err)
	}
	agent, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m2:agent", "agent", "agent_message_chunk", "答", "")
	if err != nil {
		t.Fatal(err)
	}
	if !(first.Seq == 2 && tool.Seq == 3 && agent.Seq == 4) {
		t.Fatalf("seq not appended in timeline order: %d %d %d", first.Seq, tool.Seq, agent.Seq)
	}
	// A late upsert replaying an earlier entry: seq stays put (interleaved
	// ordering preserved, §5.4 #5).
	again, err := s.UpsertTurnMessage(ctx, sid, "turn-1", "msg:m2:agent", "agent", "agent_message_chunk", "答(终)", "")
	if err != nil {
		t.Fatal(err)
	}
	if again.Seq != agent.Seq {
		t.Fatalf("replay moved seq: %d -> %d", agent.Seq, again.Seq)
	}
	msgs, _ := s.ListMessages(ctx, sid)
	if len(msgs) != 4 {
		t.Fatalf("want 4 rows (user+3), got %d", len(msgs))
	}
	wantRoles := []string{"user", "thought", "tool", "agent"}
	for i, w := range wantRoles {
		if msgs[i].Role != w {
			t.Fatalf("row[%d].role: want %q got %q — order broken", i, w, msgs[i].Role)
		}
	}
}

func TestUpsertTurnMessageSeparateTurns(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// The fallback entry key ("msg:_fb:1:agent") appears in every turn;
	// turn_id disambiguates.
	for _, turn := range []string{"turn-1", "turn-2"} {
		if _, err := s.UpsertTurnMessage(ctx, sid, turn, "msg:_fb:1:agent", "agent", "agent_message_chunk", "回复"+turn, ""); err != nil {
			t.Fatalf("upsert %s: %v", turn, err)
		}
	}
	msgs, _ := s.ListMessages(ctx, sid)
	if len(msgs) != 2 {
		t.Fatalf("want 2 rows across turns, got %d", len(msgs))
	}
	if msgs[0].Content != "回复turn-1" || msgs[1].Content != "回复turn-2" {
		t.Fatalf("cross-turn collision: %+v", msgs)
	}
}

func TestUpsertTurnMessageLegacyRowsCoexist(t *testing.T) {
	s, sid := newUpsertTestSession(t)
	ctx := context.Background()

	// Legacy rows (entry_key='', written by AppendMessage) sit outside the
	// partial unique index: multiple rows coexist legally and don't affect
	// upsert dedupe.
	for _, c := range []string{"旧1", "旧2"} {
		if _, err := s.AppendMessage(ctx, sid, "agent", "agent_message_chunk", c, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.UpsertTurnMessage(ctx, sid, "turn-9", "msg:m:agent", "agent", "agent_message_chunk", "新", ""); err != nil {
		t.Fatal(err)
	}
	msgs, _ := s.ListMessages(ctx, sid)
	if len(msgs) != 3 {
		t.Fatalf("legacy rows must coexist: got %d rows", len(msgs))
	}
}

// Migration compatibility: an existing DB with data runs 0017 (ALTER + partial
// unique index) without blowing up; legacy rows stay readable.
func TestMessageTurnKeysMigrationOnExistingDB(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	ctx := context.Background()

	// Stage 1: open a fresh DB and seed two legacy rows with duplicate empty
	// keys by hand.
	s1, err := New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	// New already ran all migrations; verify directly that hand-inserted
	// legacy rows (entry_key='') coexist with the index on the migrated DB.
	p, err := s1.CreateProject(ctx, "p", filepath.Join(dir, "wd"), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := s1.CreateSession(ctx, p.ID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s1.db.ExecContext(ctx,
		`INSERT INTO messages(id,session_id,role,kind,content,tool_call_id,turn_id,entry_key,seq,created_at)
		 VALUES('legacy1',?,'agent','','旧内容','','','','1',0),
		        ('legacy2',?,'agent','','旧内容2','','','','2',0)`,
		se.ID, se.ID)
	if err != nil {
		t.Fatalf("seed legacy rows: %v", err)
	}
	// Multiple entry_key='' rows don't trip the unique index (the partial
	// index excludes empty keys).
	if _, err := s1.UpsertTurnMessage(ctx, se.ID, "t", "k", "agent", "agent_message_chunk", "v", ""); err != nil {
		t.Fatalf("upsert alongside legacy rows: %v", err)
	}
	if err := s1.Close(); err != nil {
		t.Fatal(err)
	}

	// Stage 2: reopen (migrations idempotent via IF NOT EXISTS); data survives.
	s2, err := New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	var n int
	if err := s2.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("row count after reopen: want 3, got %d", n)
	}
}
