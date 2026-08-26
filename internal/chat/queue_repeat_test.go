package chat

// queue_repeat_test.go: recurring queue items (#111, Task #24333). All via the
// fakeChat mock (§5.1: no real harness is ever spawned). Fast repeat intervals
// (60ms) are written directly to the store rows — the SetQueueItemRepeat
// binding hard-validates 1min..24h, which is exactly what its own tests pin;
// the drain mechanics themselves are interval-agnostic.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/store"
)

// repeatRowOf waits for the session's queue to hold exactly one row and
// returns it (the one-item shape every test here uses).
func repeatRowOf(t *testing.T, svc *ChatService, sid string) store.QueueItem {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rows := listQueue(t, svc, sid); len(rows) == 1 {
			return rows[0]
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("expected exactly one queue row, got %+v", listQueue(t, svc, sid))
	return store.QueueItem{}
}

// waitRepeatRow polls until the queue holds one row with sentCount >= n.
func waitRepeatRow(t *testing.T, svc *ChatService, sid string, n int64) store.QueueItem {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, r := range listQueue(t, svc, sid) {
			if r.SentCount >= n {
				return r
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for sentCount>=%d, queue=%+v", n, listQueue(t, svc, sid))
	return store.QueueItem{}
}

// waitQueueEmpty polls until the session's queue is empty.
func waitQueueEmpty(t *testing.T, svc *ChatService, sid string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(listQueue(t, svc, sid)) == 0 {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("queue should be empty, got %+v", listQueue(t, svc, sid))
}

// mutateQueueRow rewrites the session's single queue row through the store
// (test-side; production mutations all go through the bindings).
func mutateQueueRow(t *testing.T, svc *ChatService, sid string, mut func(*store.QueueItem)) {
	t.Helper()
	mutateQueueRows(t, svc, sid, func(rows []store.QueueItem) { mut(&rows[0]) })
}

// mutateQueueRows rewrites the whole row list through the store (test-side).
func mutateQueueRows(t *testing.T, svc *ChatService, sid string, mut func(rows []store.QueueItem)) {
	t.Helper()
	rows := listQueue(t, svc, sid)
	if len(rows) == 0 {
		t.Fatal("expected at least one queue row")
	}
	mut(rows)
	if err := svc.st.ReplaceQueueItems(context.Background(), sid, rows); err != nil {
		t.Fatalf("replace queue: %v", err)
	}
}

// TestQueueRepeatRearmFormula pins the re-arm formula for the CONTINUOUSLY
// ONLINE case (#111 hard gate): consecutive fires are exactly one interval
// apart — next = max(now, prev+interval) resolves to prev+interval because the
// send happened within the period. Also pins position preservation: the
// recurring row re-inserts at its original index, not at the queue tail.
func TestQueueRepeatRearmFormula(t *testing.T) {
	svc, sid, fc := newTestService(t)
	const iv = 60 // ms

	if err := svc.EnqueueMessage(sid, "tick", nil); err != nil {
		t.Fatalf("enqueue tick: %v", err)
	}
	if err := svc.EnqueueMessage(sid, "other", nil); err != nil {
		t.Fatalf("enqueue other: %v", err)
	}
	mutateQueueRows(t, svc, sid, func(rows []store.QueueItem) { rows[0].RepeatEveryMs = iv })
	prev := listQueue(t, svc, sid)[0].ScheduledAt

	// Fire #1: drain sends, reschedules to prev+iv (still future → timer arms).
	svc.drainQueue(sid)
	waitStarted(t, fc, 1)
	row := waitRepeatRow(t, svc, sid, 1)
	if got := row.ScheduledAt - prev; got < iv-10 || got > iv+40 {
		t.Fatalf("first re-arm must be prev+interval (%dms), got %dms off (row=%+v)", iv, got, row)
	}
	// Position preserved: tick still FIRST, other stays behind it.
	if rows := listQueue(t, svc, sid); len(rows) != 2 || rows[0].Text != "tick" || rows[1].Text != "other" {
		t.Fatalf("repeat row must keep its original position, got %+v", rows)
	}

	// Fire #2 (turn end / timer): cadence continues — prev+2*iv, not now+iv.
	fc.release()
	waitStarted(t, fc, 2)
	row = waitRepeatRow(t, svc, sid, 2)
	if got := row.ScheduledAt - prev; got < 2*iv-10 || got > 2*iv+60 {
		t.Fatalf("second re-arm must continue the prev-anchored cadence (~%dms), got %dms off", 2*iv, got)
	}
	if n := countPrompts(fc, "tick"); n != 2 {
		t.Fatalf("expected exactly 2 tick sends, got %d (%v)", n, fc.prompts)
	}
}

// TestQueueRepeatSkipsCatchUp pins skip-catch-up (#111 hard gate): an item
// overdue across SEVERAL periods (downtime) sends exactly ONCE per drain and
// re-anchors to now — no back-fill burst.
func TestQueueRepeatSkipsCatchUp(t *testing.T) {
	svc, sid, fc := newTestService(t)
	const iv = 60 // ms

	if err := svc.EnqueueMessage(sid, "tick", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// Simulate downtime: the last fire was 5 periods ago.
	mutateQueueRow(t, svc, sid, func(r *store.QueueItem) {
		r.RepeatEveryMs = iv
		r.ScheduledAt = time.Now().Add(-5 * iv).UnixMilli()
	})

	sentAt := time.Now().UnixMilli()
	svc.drainQueue(sid)
	waitStarted(t, fc, 1)
	row := waitRepeatRow(t, svc, sid, 1)
	// Re-anchored to ~now (at/after the send), NOT prev+iv (which lies in the
	// past — a catch-up reschedule would land BEFORE the send that just ran).
	if got := row.ScheduledAt; got < sentAt || got > sentAt+150 {
		t.Fatalf("overdue re-arm must re-anchor to ~now(%d), got %d", sentAt, got)
	}
	// One send per drain — no catch-up burst (the fake turn stays blocked so
	// the only possible sends would come from drain/timer, and a re-anchored
	// due-now item arms no timer).
	time.Sleep(3 * iv)
	if n := countPrompts(fc, "tick"); n != 1 {
		t.Fatalf("downtime across periods must send exactly once, got %d (%v)", n, fc.prompts)
	}
}

// TestQueueRepeatMaxSendsAutoClears: maxSends=N repeats N times, then the
// repeat auto-clears and the item is consumed like a normal one-shot (queue
// empties, no further sends).
func TestQueueRepeatMaxSendsAutoClears(t *testing.T) {
	svc, sid, fc := newTestService(t)
	const iv = 60 // ms

	if err := svc.EnqueueMessage(sid, "tick", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	mutateQueueRow(t, svc, sid, func(r *store.QueueItem) {
		r.RepeatEveryMs = iv
		r.MaxSends = 2
	})

	svc.drainQueue(sid)           // send #1 → re-armed, sentCount=1
	waitRepeatRow(t, svc, sid, 1) // still queued
	fc.release()                  // turn end / timer → send #2 → budget hit
	waitStarted(t, fc, 2)
	waitQueueEmpty(t, svc, sid) // consumed — not re-inserted

	// Past a third period: still exactly 2 sends, queue still empty.
	time.Sleep(3 * iv)
	if n := countPrompts(fc, "tick"); n != 2 {
		t.Fatalf("maxSends=2 must stop after 2 sends, got %d (%v)", n, fc.prompts)
	}
	if rows := listQueue(t, svc, sid); len(rows) != 0 {
		t.Fatalf("repeat must be auto-cleared after maxSends, got %+v", rows)
	}
}

// TestQueueUserStopSkipsRepeatItem: StopSession's one-shot intent suppresses
// the auto-continue of a DUE recurring item too — Stop means stop, the
// recurring row waits (sentCount untouched) for the next trigger.
func TestQueueUserStopSkipsRepeatItem(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send first: %v", err)
	}
	waitStarted(t, fc, 1)
	if err := svc.EnqueueMessage(sid, "tick", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	mutateQueueRow(t, svc, sid, func(r *store.QueueItem) { r.RepeatEveryMs = 60 })

	if err := svc.StopSession(sid); err != nil {
		t.Fatalf("stop: %v", err)
	}
	waitCancelled(t, fc, 1)
	time.Sleep(100 * time.Millisecond) // let the tail drain consume the marker
	if n := countPrompts(fc, "tick"); n != 0 {
		t.Fatalf("user-stop must suppress the repeat auto-continue, got %d (%v)", n, fc.prompts)
	}
	rows := listQueue(t, svc, sid)
	if len(rows) != 1 || rows[0].Text != "tick" || rows[0].SentCount != 0 {
		t.Fatalf("repeat item must be retained unsent, got %+v", rows)
	}
}

// TestQueueRevokeDeletesRepeatItem: RevokeQueueItem removes a recurring item
// outright — revoking is the "cancel this recurring message" escape hatch.
func TestQueueRevokeDeletesRepeatItem(t *testing.T) {
	svc, sid, _ := newTestService(t)

	if err := svc.EnqueueMessage(sid, "tick", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	rows := listQueue(t, svc, sid)
	if err := svc.SetQueueItemRepeat(sid, rows[0].ID, 5*60_000, 0); err != nil {
		t.Fatalf("set repeat: %v", err)
	}
	if err := svc.RevokeQueueItem(sid, rows[0].ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if got := listQueue(t, svc, sid); len(got) != 0 {
		t.Fatalf("revoke must delete the recurring item, got %+v", got)
	}
}

// TestQueueRepeatDrainGuardNoReentry: concurrent drain triggers collapse into
// ONE dequeue+send (per-session drain guard) — a recurring due item is never
// double-sent by racing triggers.
func TestQueueRepeatDrainGuardNoReentry(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.EnqueueMessage(sid, "tick", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// Long interval: even a slow guard release must not reach the next period.
	mutateQueueRow(t, svc, sid, func(r *store.QueueItem) { r.RepeatEveryMs = 2_000 })

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			svc.drainQueue(sid)
		}()
	}
	wg.Wait()
	waitStarted(t, fc, 1)
	waitRepeatRow(t, svc, sid, 1)

	time.Sleep(120 * time.Millisecond)
	if n := countPrompts(fc, "tick"); n != 1 {
		t.Fatalf("concurrent drains must send exactly once, got %d (%v)", n, fc.prompts)
	}
	row := waitRepeatRow(t, svc, sid, 1)
	if row.SentCount != 1 {
		t.Fatalf("sentCount must be 1 after the guarded send, got %+v", row)
	}
}

// TestSetQueueItemRepeatValidation: interval hard gate 1min..24h with the
// stable errQueueRepeatInterval code; 0 always legal (clear); maxSends >= 0;
// unknown item rejected; the wire snapshot carries repeatEveryMs/sentCount.
func TestSetQueueItemRepeatValidation(t *testing.T) {
	svc, sid, _ := newTestService(t)
	qc := &queueEventCapture{}
	svc.emitHook = qc.hook

	if err := svc.EnqueueMessage(sid, "tick", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	id := listQueue(t, svc, sid)[0].ID

	for _, bad := range []int64{1, 59_999, 24*60*60_000 + 1, -60_000} {
		err := svc.SetQueueItemRepeat(sid, id, bad, 0)
		if !errors.Is(err, errQueueRepeatInterval) {
			t.Fatalf("interval %dms must be rejected with the stable code, got %v", bad, err)
		}
		if !strings.Contains(err.Error(), "queue_repeat_interval_invalid") {
			t.Fatalf("error message must carry the stable code prefix, got %v", err)
		}
	}
	// Bounds are inclusive.
	if err := svc.SetQueueItemRepeat(sid, id, 60_000, 0); err != nil {
		t.Fatalf("1min must be accepted: %v", err)
	}
	if err := svc.SetQueueItemRepeat(sid, id, 24*60*60_000, 0); err != nil {
		t.Fatalf("24h must be accepted: %v", err)
	}
	if err := svc.SetQueueItemRepeat(sid, id, 5*60_000, -1); err == nil {
		t.Fatal("negative maxSends must be rejected")
	}
	// Set + change + clear round-trip, wire snapshot included.
	if err := svc.SetQueueItemRepeat(sid, id, 5*60_000, 3); err != nil {
		t.Fatalf("set repeat: %v", err)
	}
	row := listQueue(t, svc, sid)[0]
	if row.RepeatEveryMs != 5*60_000 || row.MaxSends != 3 || row.SentCount != 0 {
		t.Fatalf("repeat fields not applied: %+v", row)
	}
	p, ok := qc.last()
	if !ok || len(p.Items) != 1 || p.Items[0].RepeatEveryMs != 5*60_000 || p.Items[0].SentCount != 0 {
		t.Fatalf("chat:queue snapshot must carry repeatEveryMs/sentCount, got %+v ok=%v", p, ok)
	}
	if err := svc.SetQueueItemRepeat(sid, id, 0, 0); err != nil {
		t.Fatalf("clear repeat: %v", err)
	}
	if row = listQueue(t, svc, sid)[0]; row.RepeatEveryMs != 0 {
		t.Fatalf("repeat must be cleared, got %+v", row)
	}
	if err := svc.SetQueueItemRepeat(sid, "nope", 5*60_000, 0); err == nil {
		t.Fatal("unknown item must be rejected")
	}
}

// countPrompts counts Prompt calls with the exact text.
func countPrompts(fc *fakeChat, text string) int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	n := 0
	for _, p := range fc.prompts {
		if p == text {
			n++
		}
	}
	return n
}
