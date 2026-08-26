package store

// queue_test.go: server-side queue persistence round-trip + cascade (#126A).
// Uses a temp-file DB (not :memory:) so the FK pragma is active and the
// ON DELETE CASCADE path is actually exercised (§5.2).

import (
	"context"
	"path/filepath"
	"testing"
)

func newQueueTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	st, err := New(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	proj, err := st.CreateProject(context.Background(), "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(context.Background(), proj.ID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return st, se.ID
}

func TestQueueReplaceListRoundtrip(t *testing.T) {
	st, sid := newQueueTestStore(t)
	ctx := context.Background()

	items := []QueueItem{
		NewQueueItem("first", `[{"kind":"file","name":"a.go","path":"a.go"}]`, 1000),
		NewQueueItem("second", "", 2000),
	}
	if err := st.ReplaceQueueItems(ctx, sid, items); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, err := st.ListQueueItems(ctx, sid)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 || got[0].Text != "first" || got[1].Text != "second" {
		t.Fatalf("order/text mismatch: %+v", got)
	}
	if got[0].ID != items[0].ID || got[1].ID != items[1].ID {
		t.Fatalf("ids not preserved: %+v", got)
	}
	if got[0].ScheduledAt != 1000 || got[1].ScheduledAt != 2000 {
		t.Fatalf("scheduledAt mismatch: %+v", got)
	}
	if got[0].Attachments != items[0].Attachments {
		t.Fatalf("attachments mismatch: %+v", got[0].Attachments)
	}
	if got[1].Attachments != "" {
		t.Fatalf("empty attachments should round-trip empty, got %q", got[1].Attachments)
	}

	// Recurring fields (#111) default to zero for plain rows…
	if got[0].RepeatEveryMs != 0 || got[0].SentCount != 0 || got[0].MaxSends != 0 {
		t.Fatalf("plain item must default repeat fields to 0, got %+v", got[0])
	}
	// …and round-trip when set (sent_count advances, max_sends caps).
	items[0].RepeatEveryMs = 5 * 60_000
	items[0].SentCount = 3
	items[0].MaxSends = 5
	if err := st.ReplaceQueueItems(ctx, sid, items); err != nil {
		t.Fatalf("replace repeat: %v", err)
	}
	gotR, _ := st.ListQueueItems(ctx, sid)
	if gotR[0].RepeatEveryMs != 5*60_000 || gotR[0].SentCount != 3 || gotR[0].MaxSends != 5 {
		t.Fatalf("repeat fields mismatch: %+v", gotR[0])
	}

	// Reorder (swap) + re-replace: positions rewrite, ids keep identity.
	swapped := []QueueItem{got[1], got[0]}
	if err := st.ReplaceQueueItems(ctx, sid, swapped); err != nil {
		t.Fatalf("replace swapped: %v", err)
	}
	got2, _ := st.ListQueueItems(ctx, sid)
	if len(got2) != 2 || got2[0].Text != "second" || got2[1].Text != "first" {
		t.Fatalf("swap mismatch: %+v", got2)
	}

	// Clear with nil.
	if err := st.ReplaceQueueItems(ctx, sid, nil); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got3, err := st.ListQueueItems(ctx, sid)
	if err != nil {
		t.Fatalf("list after clear: %v", err)
	}
	if len(got3) != 0 {
		t.Fatalf("expected empty slice after clear, got %+v", got3)
	}
}

func TestQueueCascadesWithSession(t *testing.T) {
	st, sid := newQueueTestStore(t)
	ctx := context.Background()

	if err := st.ReplaceQueueItems(ctx, sid, []QueueItem{NewQueueItem("parked", "", 1000)}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if err := st.DeleteSession(ctx, sid); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	got, err := st.ListQueueItems(ctx, sid)
	if err != nil {
		t.Fatalf("list after session delete: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("queue rows must cascade with the session, got %+v", got)
	}
}
