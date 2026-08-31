package chat

// queue_mixed_repro_176_test.go: regression tests for #176 — a recurring item
// that caught up after downtime used to re-anchor to `now` (immediately due),
// so the very next drain trigger (turn tail / mutation / reconnect re-drain)
// re-sent it and starved due normal items sitting behind it in the queue.
//
//   A future@pos0 + due@pos1: only the due item sends, the future item stays
//     verbatim, and the post-turn tail drain sends nothing more.
//   B overdue repeat (large 90min interval, written straight to the store to
//     keep short-interval noise out) + due normal interleaved: after the
//     catch-up send the re-anchored value must be strictly in the future, and
//     the tail drain must send the NORMAL item before any second tick.
//   C a synchronously failed send (busy guard) requeues in order and leaves a
//     future row's scheduledAt untouched. Note: fc.promptErr fails at the
//     runPrompt level — AFTER dequeue — and is intentionally not used here;
//     the queue's requeue path only covers synchronous SendMessage failures
//     (busy race / spawn failure), per drainQueue's contract.

import (
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/store"
)

func nowMs() int64 { return time.Now().UnixMilli() }

// setQueueRows writes a whole row list straight to the store (test-side;
// production mutations go through the bindings — same rationale as
// queue_repeat_test.go's mutateQueueRows, but works on an empty queue too).
func setQueueRows(t *testing.T, svc *ChatService, sid string, rows []store.QueueItem) {
	t.Helper()
	if err := svc.st.ReplaceQueueItems(t.Context(), sid, rows); err != nil {
		t.Fatalf("replace rows: %v", err)
	}
}

func mkRow(id, text string, dueInMs int64) store.QueueItem {
	return store.QueueItem{ID: id, Text: text, ScheduledAt: nowMs() + dueInMs}
}

// TestQueueMixed176FuturePlusDue: a future item must not block a later due
// item, and the turn-end tail drain must not send anything extra.
func TestQueueMixed176FuturePlusDue(t *testing.T) {
	svc, sid, fc := newTestService(t)
	future := mkRow("f", "future", 3600_000)
	setQueueRows(t, svc, sid, []store.QueueItem{future, mkRow("d", "due", -1000)})

	svc.drainQueue(sid)
	waitStarted(t, fc, 1)
	if n := countPrompts(fc, "due"); n != 1 {
		t.Fatalf("due must send exactly once, got %d (%v)", n, fc.prompts)
	}
	if n := countPrompts(fc, "future"); n != 0 {
		t.Fatalf("future must not send, got %d (%v)", n, fc.prompts)
	}
	rows := listQueue(t, svc, sid)
	if len(rows) != 1 || rows[0].ID != "f" || rows[0].ScheduledAt < nowMs()+3000_000 {
		t.Fatalf("future row must survive verbatim, got %+v", rows)
	}

	// Turn ends → tail drain finds nothing due → no further sends.
	fc.release()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && svc.isBusy(sid) {
		time.Sleep(2 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond) // settle: give any wrongful extra drain a chance to fire
	if got := fc.count(); got != 1 {
		t.Fatalf("tail drain must not send after the due item, got %d prompts (%v)", got, fc.prompts)
	}
}

// TestQueueMixed176OverdueRepeatVsNormal: the #176 core. After an overdue
// repeat's catch-up send, the re-anchored scheduledAt must be strictly in the
// future (one interval past now) so the tail drain sends the due NORMAL item
// instead of instantly re-sending the tick.
func TestQueueMixed176OverdueRepeatVsNormal(t *testing.T) {
	svc, sid, fc := newTestService(t)
	const iv = 90 * int64(time.Minute/time.Millisecond) // 90min, per the issue scenario
	r := mkRow("tick", "tick", -2*iv)                   // overdue across several periods
	r.RepeatEveryMs = iv
	setQueueRows(t, svc, sid, []store.QueueItem{r, mkRow("normal", "normal", -1000)})

	svc.drainQueue(sid) // catch-up: tick sends once, rescheduleRepeat re-anchors
	waitStarted(t, fc, 1)
	row := waitRepeatRow(t, svc, sid, 1)
	if row.ID != "tick" {
		t.Fatalf("tick must keep its original position, got %+v", row)
	}
	// THE invariant (#176): the re-anchor must never hang at due-now.
	if row.ScheduledAt <= nowMs() {
		t.Fatalf("catch-up re-anchor must be strictly future (now+%dms), got %d", iv, row.ScheduledAt)
	}

	// Turn ends → tail drain: the due normal item goes next, NOT a second tick.
	fc.release()
	waitStarted(t, fc, 2)
	if fc.prompts[0] != "tick" || fc.prompts[1] != "normal" {
		t.Fatalf("normal must send before any second tick, got %v", fc.prompts)
	}
	time.Sleep(150 * time.Millisecond) // settle: the bug produces a tick burst within this window
	if n := countPrompts(fc, "tick"); n != 1 {
		t.Fatalf("tick must not re-send before its next period, got %d ticks (%v)", n, fc.prompts)
	}
	if n := countPrompts(fc, "normal"); n != 1 {
		t.Fatalf("normal must send exactly once, got %d (%v)", n, fc.prompts)
	}
}

// TestQueueMixed176RequeueKeepsFuture: a synchronously failed send (busy
// guard) requeues the item at its original position and leaves a future row's
// scheduledAt untouched; the requeued item is retried after the turn ends.
func TestQueueMixed176RequeueKeepsFuture(t *testing.T) {
	svc, sid, fc := newTestService(t)
	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1) // turn 1 now holds the session busy

	due := mkRow("d", "due", -1000)
	futureAt := nowMs() + 3600_000
	future := store.QueueItem{ID: "f", Text: "future", ScheduledAt: futureAt}
	setQueueRows(t, svc, sid, []store.QueueItem{due, future})

	svc.drainQueue(sid) // d dequeued → SendMessage busy-rejected → requeueAt(d, 0)

	// Poll until the requeue lands (a fixed sleep here raced the persist and
	// mis-reported — #176 review note).
	deadline := time.Now().Add(2 * time.Second)
	var rows []store.QueueItem
	for time.Now().Before(deadline) {
		rows = listQueue(t, svc, sid)
		if len(rows) == 2 && rows[0].ID == "d" && rows[1].ID == "f" {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if len(rows) != 2 || rows[0].ID != "d" || rows[1].ID != "f" {
		t.Fatalf("failed send must requeue in original order, got %+v", rows)
	}
	if rows[1].ScheduledAt != futureAt {
		t.Fatalf("future row scheduledAt must survive the requeue verbatim, got %d want %d", rows[1].ScheduledAt, futureAt)
	}
	if got := fc.count(); got != 1 {
		t.Fatalf("busy-rejected drain must not start a prompt, got %d (%v)", got, fc.prompts)
	}

	fc.release() // turn ends → tail drain retries the requeued item
	waitStarted(t, fc, 2)
	if fc.prompts[1] != "due" {
		t.Fatalf("requeued item must be retried after turn end, got %v", fc.prompts)
	}
}
