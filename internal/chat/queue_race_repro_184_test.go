package chat

// queue_race_repro_184_test.go: #184-reopen race reproduction (Task #28974).
//
// drainQueue dequeues the due row (dequeue-before-send, exactly-once) and only
// re-inserts it AFTER SendMessage returns — once for a recurring item
// (rescheduleRepeat), once for a failed send (requeueAt). SendMessage runs
// with queueMu released, so every user mutation (Revoke / Reorder / Enqueue /
// Schedule) can land inside that window and invalidate the recorded position:
// the re-insertion then uses a stale index.
//
// The interleaving below is deterministic, not timing-based: the test holds
// ls.sendMu before launching the drain, so the drain's SendMessage blocks on
// it AFTER dequeueDue has persisted (poll-verified) and BEFORE the re-insert.
// Mutations are injected through the real bindings inside that window; the
// unlock lets the send finish and the re-insertion run.
//
// Matrix pins three invariants per combination:
//   - the repeat row is still queued with intact fields (RepeatEveryMs /
//     SentCount / ScheduledAt per the #176 re-anchor formula);
//   - no other row is lost or corrupted;
//   - the repeat row lands at its original relative position — immediately
//     before the row that used to follow it (the successor anchor); a missing
//     successor means the tail.
//
// Every non-dequeued row is future-scheduled so nothing else is due when the
// window closes: a drain trigger that escapes the per-session guard (bindings
// fire go drainQueue while !busy) would be a no-op, keeping the matrix free of
// goroutine-scheduling flake.
//
// A second test exercises the same window on the failure path (requeueAt):
// busy is preset so the released send is rejected and the row is re-queued
// verbatim (SentCount untouched, ScheduledAt NOT re-anchored).

import (
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/store"
)

const (
	race184IV      int64 = 60_000 // 1min: the binding-legal minimum repeat interval
	race184TickMax       = 5 * time.Second
)

// race184Fixture builds [A(future) R(due repeat) B(future normal)] with a live
// session and returns the repeat row's original scheduledAt (the #176 re-anchor
// base). The first due row is R (A and B are future) → dequeueDue removes it
// at index 1 and its successor anchor is B.
func race184Fixture(t *testing.T) (svc *ChatService, sid string, fc *fakeChat, ls *liveSession, rPrev int64) {
	t.Helper()
	svc, sid, fc = newTestService(t)
	svc.mu.RLock()
	ls = svc.active[sid]
	svc.mu.RUnlock()
	rPrev = nowMs() - 1000
	setQueueRows(t, svc, sid, []store.QueueItem{
		mkRow("A", "future", 3600_000),
		{ID: "R", Text: "tick", ScheduledAt: rPrev, RepeatEveryMs: race184IV},
		mkRow("B", "normal", 3600_000),
	})
	return svc, sid, fc, ls, rPrev
}

// raceStep is one in-window mutation, applied through the production binding.
type raceStep struct {
	kind   string // revoke | reorder | enqueue | schedule
	arg1   string // revoke: item · reorder: active · enqueue: text · schedule: item
	arg2   string // reorder: over
	atInMs int64  // schedule: scheduledAt delta from now
}

// resolveItemID maps a step target to a real row ID: ID match first, then
// text (enqueued rows carry generated IDs).
func resolveItemID(t *testing.T, svc *ChatService, sid, key string) string {
	t.Helper()
	for _, r := range listQueue(t, svc, sid) {
		if r.ID == key {
			return key
		}
	}
	for _, r := range listQueue(t, svc, sid) {
		if r.Text == key {
			return r.ID
		}
	}
	t.Fatalf("race step target %q not in queue", key)
	return ""
}

func applyRaceStep(t *testing.T, svc *ChatService, sid string, st raceStep) {
	t.Helper()
	var err error
	switch st.kind {
	case "revoke":
		err = svc.RevokeQueueItem(sid, resolveItemID(t, svc, sid, st.arg1))
	case "reorder":
		err = svc.ReorderQueueItem(sid, resolveItemID(t, svc, sid, st.arg1), resolveItemID(t, svc, sid, st.arg2))
	case "enqueue":
		err = svc.EnqueueMessage(sid, st.arg1, nil)
	case "schedule":
		err = svc.ScheduleQueueItem(sid, resolveItemID(t, svc, sid, st.arg1), nowMs()+st.atInMs)
	default:
		t.Fatalf("unknown race step kind %q", st.kind)
	}
	if err != nil {
		t.Fatalf("%s %v: %v", st.kind, st, err)
	}
}

// waitQueueTexts polls until the session's queue holds exactly the given texts
// in order — deterministic evidence that the dequeue (or a mutation) landed.
func waitQueueTexts(t *testing.T, svc *ChatService, sid string, want []string) []store.QueueItem {
	t.Helper()
	deadline := time.Now().Add(race184TickMax)
	for time.Now().Before(deadline) {
		rows := listQueue(t, svc, sid)
		if textsEqual(rows, want) {
			return rows
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for queue %v, got %v", want, queueTextsOf(listQueue(t, svc, sid)))
	return nil
}

func queueTextsOf(rows []store.QueueItem) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Text
	}
	return out
}

func textsEqual(rows []store.QueueItem, want []string) bool {
	if len(rows) != len(want) {
		return false
	}
	for i := range rows {
		if rows[i].Text != want[i] {
			return false
		}
	}
	return true
}

// assertRescheduledTick checks the full post-reschedule invariant set: order,
// zero loss, intact fields, and the #176 re-anchor formula on the repeat row.
func assertRescheduledTick(t *testing.T, svc *ChatService, sid string, rPrev int64, want []string) {
	t.Helper()
	deadline := time.Now().Add(race184TickMax)
	var rows []store.QueueItem
	for time.Now().Before(deadline) {
		rows = listQueue(t, svc, sid)
		if n := countText(rows, "tick"); n == 1 && tickSent(rows) >= 1 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if got := queueTextsOf(rows); !textsEqual(rows, want) {
		t.Fatalf("post-race queue order = %v, want %v (zero-loss + successor-anchor position)", got, want)
	}
	var tick *store.QueueItem
	for i := range rows {
		if rows[i].Text == "tick" {
			tick = &rows[i]
		}
	}
	if tick.RepeatEveryMs != race184IV || tick.SentCount != 1 || tick.MaxSends != 0 {
		t.Fatalf("repeat row fields corrupted: %+v", tick)
	}
	// #176 formula, continuously-online path: next = prev+interval (the send
	// happened well within the period) and strictly future.
	if lo, hi := rPrev+race184IV-int64(time.Second), rPrev+race184IV+int64(5*time.Second); tick.ScheduledAt < lo || tick.ScheduledAt > hi {
		t.Fatalf("repeat re-anchor = %d, want prev+%dms in [%d,%d]", tick.ScheduledAt, race184IV, lo, hi)
	}
	if tick.ScheduledAt <= nowMs() {
		t.Fatalf("repeat re-anchor must be strictly future, got %d", tick.ScheduledAt)
	}
	for _, r := range rows {
		if r.Text != "future" {
			continue // the scheduledAt of other survivors is step-dependent
		}
		if r.ScheduledAt < nowMs()+3000_000 {
			t.Fatalf("survivor future row corrupted: %+v", r)
		}
	}
}

func countText(rows []store.QueueItem, text string) int {
	n := 0
	for _, r := range rows {
		if r.Text == text {
			n++
		}
	}
	return n
}

func tickSent(rows []store.QueueItem) int64 {
	for _, r := range rows {
		if r.Text == "tick" {
			return r.SentCount
		}
	}
	return -1
}

// TestQueueRepeatRace184RescheduleMatrix: the four concurrent-injection
// classes (Revoke / Reorder / Enqueue / Schedule) against the drain window,
// single and combined, both orderings for the combination pairs. Expected
// order = mutation result on the post-dequeue list [A B], then the repeat row
// re-inserted before its successor B (tail when B is gone).
func TestQueueRepeatRace184RescheduleMatrix(t *testing.T) {
	cases := []struct {
		name  string
		steps []raceStep
		want  []string
	}{
		// single injections — one per class
		{"revoke earlier row", []raceStep{{kind: "revoke", arg1: "A"}}, []string{"tick", "normal"}},
		{"reorder successor over earlier", []raceStep{{kind: "reorder", arg1: "B", arg2: "A"}}, []string{"tick", "normal", "future"}},
		{"reorder earlier after successor", []raceStep{{kind: "reorder", arg1: "A", arg2: "B"}}, []string{"tick", "normal", "future"}},
		{"enqueue tail", []raceStep{{kind: "enqueue", arg1: "C"}}, []string{"future", "tick", "normal", "C"}},
		{"schedule other row", []raceStep{{kind: "schedule", arg1: "A", atInMs: 7200_000}}, []string{"future", "tick", "normal"}},
		// control: successor itself revoked → anchor gone → tail
		{"revoke successor anchor", []raceStep{{kind: "revoke", arg1: "B"}}, []string{"future", "tick"}},
		// combinations — including both orderings of the same pair (前后组合)
		{"revoke then enqueue", []raceStep{{kind: "revoke", arg1: "A"}, {kind: "enqueue", arg1: "C"}}, []string{"tick", "normal", "C"}},
		{"enqueue then revoke", []raceStep{{kind: "enqueue", arg1: "C"}, {kind: "revoke", arg1: "A"}}, []string{"tick", "normal", "C"}},
		{"reorder then enqueue", []raceStep{{kind: "reorder", arg1: "B", arg2: "A"}, {kind: "enqueue", arg1: "C"}}, []string{"tick", "normal", "future", "C"}},
		{"revoke both neighbours", []raceStep{{kind: "revoke", arg1: "A"}, {kind: "revoke", arg1: "B"}}, []string{"tick"}},
		{"revoke then schedule", []raceStep{{kind: "revoke", arg1: "A"}, {kind: "schedule", arg1: "B", atInMs: 7200_000}}, []string{"tick", "normal"}},
		{"schedule then revoke", []raceStep{{kind: "schedule", arg1: "A", atInMs: 7200_000}, {kind: "revoke", arg1: "A"}}, []string{"tick", "normal"}},
		{"enqueue then reorder onto new tail", []raceStep{{kind: "enqueue", arg1: "C"}, {kind: "reorder", arg1: "B", arg2: "C"}}, []string{"future", "C", "tick", "normal"}},
		{"reorder then revoke earlier", []raceStep{{kind: "reorder", arg1: "A", arg2: "B"}, {kind: "revoke", arg1: "A"}}, []string{"tick", "normal"}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			svc, sid, _, ls, rPrev := race184Fixture(t)

			ls.sendMu.Lock() // open the window: the drain's SendMessage blocks here
			go svc.drainQueue(sid)
			waitQueueTexts(t, svc, sid, []string{"future", "normal"}) // dequeue landed deterministically
			for _, st := range tc.steps {
				applyRaceStep(t, svc, sid, st)
			}
			ls.sendMu.Unlock() // send completes → rescheduleRepeat executes

			assertRescheduledTick(t, svc, sid, rPrev, tc.want)
		})
	}
}

// TestQueueRepeatRace184RequeueWindow: same window, failure path. busy is
// preset so the unblocked send is busy-rejected → requeueAt re-inserts the
// row VERBATIM (SentCount untouched, ScheduledAt not re-anchored) at the
// successor-anchored position.
func TestQueueRepeatRace184RequeueWindow(t *testing.T) {
	svc, sid, fc, ls, rPrev := race184Fixture(t)

	ls.mu.Lock()
	ls.busy = true // the guard check after unlock must see a busy session
	ls.mu.Unlock()
	ls.sendMu.Lock()
	go svc.drainQueue(sid)
	waitQueueTexts(t, svc, sid, []string{"future", "normal"}) // dequeue landed

	applyRaceStep(t, svc, sid, raceStep{kind: "revoke", arg1: "A"})
	applyRaceStep(t, svc, sid, raceStep{kind: "enqueue", arg1: "C"})

	ls.sendMu.Unlock() // send rejected (busy) → requeueAt executes

	deadline := time.Now().Add(race184TickMax)
	var rows []store.QueueItem
	for time.Now().Before(deadline) {
		rows = listQueue(t, svc, sid)
		if n := countText(rows, "tick"); n == 1 && tickSent(rows) == 0 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	// Successor anchor = B → tick goes back BEFORE normal; the busy-rejected
	// send must not start any prompt.
	if got := queueTextsOf(rows); !textsEqual(rows, []string{"tick", "normal", "C"}) {
		t.Fatalf("post-race requeue order = %v, want [tick normal C]", got)
	}
	for _, r := range rows {
		if r.Text != "tick" {
			continue
		}
		if r.SentCount != 0 || r.RepeatEveryMs != race184IV {
			t.Fatalf("requeued repeat row fields corrupted: %+v", r)
		}
		if r.ScheduledAt != rPrev {
			t.Fatalf("requeue must restore scheduledAt verbatim (got %d, want %d) — no re-anchor on failure", r.ScheduledAt, rPrev)
		}
	}
	if got := fc.count(); got != 0 {
		t.Fatalf("busy-rejected drain must not prompt, got %d prompts (%v)", got, fc.prompts)
	}
}
