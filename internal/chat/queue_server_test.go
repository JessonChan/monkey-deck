package chat

// queue_server_test.go: server-side per-session queue (#126A) — CRUD bindings,
// drain auto-continue, user-stop suppression, scheduled-send timer, busy
// requeue, chat:queue snapshots. All via the fakeChat mock (§5.1: no real
// harness is ever spawned).

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// queueEventCapture records every EventQueue payload emitted during a test.
type queueEventCapture struct {
	mu      sync.Mutex
	payload []QueuePayload
}

func (c *queueEventCapture) hook(name string, data any) {
	if name != EventQueue {
		return
	}
	if p, ok := data.(QueuePayload); ok {
		c.mu.Lock()
		c.payload = append(c.payload, p)
		c.mu.Unlock()
	}
}

func (c *queueEventCapture) last() (QueuePayload, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.payload) == 0 {
		return QueuePayload{}, false
	}
	return c.payload[len(c.payload)-1], true
}

func listQueue(t *testing.T, svc *ChatService, sid string) []store.QueueItem {
	t.Helper()
	rows, err := svc.st.ListQueueItems(context.Background(), sid)
	if err != nil {
		t.Fatalf("list queue: %v", err)
	}
	return rows
}

// TestQueueDrainAutoContinuesOnTurnEnd: a queued message is auto-sent as the
// next turn when the running turn ends (idle), FIFO, and the queue empties.
func TestQueueDrainAutoContinuesOnTurnEnd(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send first: %v", err)
	}
	waitStarted(t, fc, 1)
	if err := svc.EnqueueMessage(sid, "queued-1", nil); err != nil {
		t.Fatalf("enqueue 1: %v", err)
	}
	if err := svc.EnqueueMessage(sid, "queued-2", nil); err != nil {
		t.Fatalf("enqueue 2: %v", err)
	}

	fc.release() // end every turn; drains must chain queued-1 then queued-2
	waitStarted(t, fc, 3)
	if fc.prompts[1] != "queued-1" || fc.prompts[2] != "queued-2" {
		t.Fatalf("auto-continue order = %v, want [first queued-1 queued-2]", fc.prompts)
	}
	// Queue must be empty after the chain drains (poll: the last drain-dequeue
	// happens right after prompt 3 starts).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(listQueue(t, svc, sid)) == 0 {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("queue should be empty after drain chain, got %+v", listQueue(t, svc, sid))
}

// TestQueueDrainPreservesAttachments: attachments enqueued with the item ride
// through the drain into the actual Prompt.
func TestQueueDrainPreservesAttachments(t *testing.T) {
	svc, sid, fc := newTestService(t)
	atts := []acp.Attachment{{Kind: "file", Name: "a.go", Path: "a.go"}}

	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	if err := svc.EnqueueMessage(sid, "with-attachment", atts); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	fc.release()
	waitStarted(t, fc, 2)
	if got := fc.promptAttachmentsAt(1); len(got) != 1 || got[0].Path != "a.go" || got[0].Kind != "file" {
		t.Fatalf("queued attachments must ride through the drain, got %+v", got)
	}
}

// TestQueueDrainSuppressedAfterUserStop: StopSession records a one-shot stop
// intent — the drain after that turn's idle skips auto-continue and keeps the
// queue; a later enqueue (clearing the intent) resumes at the next turn end.
func TestQueueDrainSuppressedAfterUserStop(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	if err := svc.EnqueueMessage(sid, "queued", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	if err := svc.StopSession(sid); err != nil {
		t.Fatalf("stop: %v", err)
	}
	waitCancelled(t, fc, 1)
	time.Sleep(100 * time.Millisecond) // let the drain goroutine consume the marker
	if got := fc.count(); got != 1 {
		t.Fatalf("auto-continue must be suppressed after Stop, got %d prompts (%v)", got, fc.prompts)
	}
	if rows := listQueue(t, svc, sid); len(rows) != 1 || rows[0].Text != "queued" {
		t.Fatalf("queue must be retained after Stop, got %+v", rows)
	}

	// A fresh user send clears the intent: the turn it starts drains normally.
	if err := svc.SendMessage(sid, "manual", nil); err != nil {
		t.Fatalf("manual send: %v", err)
	}
	waitStarted(t, fc, 2)
	fc.release()
	waitStarted(t, fc, 3)
	if fc.prompts[2] != "queued" {
		t.Fatalf("expected queued message after manual turn, got %v", fc.prompts)
	}
}

// TestQueueScheduledItemWaitsForTimer: a future scheduledAt is skipped at turn
// end (queue alive via the one-shot timer) and sent once due.
func TestQueueScheduledItemWaitsForTimer(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	if err := svc.EnqueueMessage(sid, "later", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	rows := listQueue(t, svc, sid)
	// Park it 60ms in the future. The turn is busy → no immediate drain.
	if err := svc.ScheduleQueueItem(sid, rows[0].ID, time.Now().Add(60*time.Millisecond).UnixMilli()); err != nil {
		t.Fatalf("schedule: %v", err)
	}

	fc.release() // turn ends → drain finds only future items → no send
	time.Sleep(25 * time.Millisecond)
	if got := fc.count(); got != 1 {
		t.Fatalf("future-scheduled item must not send before due, got %d prompts (%v)", got, fc.prompts)
	}

	waitStarted(t, fc, 2) // timer fires at ~60ms → drain sends
	if fc.prompts[1] != "later" {
		t.Fatalf("expected scheduled message after due, got %v", fc.prompts)
	}
}

// TestQueueDrainRequeuesWhenBusy: a drain racing a running turn (busy guard
// rejects the send) re-queues the item instead of losing it.
func TestQueueDrainRequeuesWhenBusy(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	if err := svc.EnqueueMessage(sid, "queued", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	svc.drainQueue(sid) // manual drain while turn 1 still holds busy
	if rows := listQueue(t, svc, sid); len(rows) != 1 || rows[0].Text != "queued" {
		t.Fatalf("busy-rejected item must be re-queued, got %+v", rows)
	}

	fc.release() // turn ends → drain retries and sends it
	waitStarted(t, fc, 2)
	if fc.prompts[1] != "queued" {
		t.Fatalf("expected re-queued message after turn end, got %v", fc.prompts)
	}
}

// TestQueueCRUDBindings: the 5 mutation bindings persist and emit snapshots.
// Items are parked in the future so the schedule/reorder idle-drain triggers
// fire without actually sending anything.
func TestQueueCRUDBindings(t *testing.T) {
	svc, sid, _ := newTestService(t)
	qc := &queueEventCapture{}
	svc.emitHook = qc.hook

	future := time.Now().Add(time.Hour).UnixMilli()
	if err := svc.EnqueueMessage(sid, "one", nil); err != nil {
		t.Fatalf("enqueue one: %v", err)
	}
	if err := svc.EnqueueMessage(sid, "two", nil); err != nil {
		t.Fatalf("enqueue two: %v", err)
	}
	rows := listQueue(t, svc, sid)
	if len(rows) != 2 || rows[0].Text != "one" || rows[1].Text != "two" {
		t.Fatalf("enqueue order: %+v", rows)
	}
	one, two := rows[0].ID, rows[1].ID

	// Edit text in place.
	if err := svc.EditQueueItem(sid, one, "one-edited"); err != nil {
		t.Fatalf("edit: %v", err)
	}
	rows = listQueue(t, svc, sid)
	if rows[0].Text != "one-edited" {
		t.Fatalf("edit not applied: %+v", rows)
	}

	// Schedule both into the future (also exercises ScheduleQueueItem).
	for _, id := range []string{one, two} {
		if err := svc.ScheduleQueueItem(sid, id, future); err != nil {
			t.Fatalf("schedule %s: %v", id, err)
		}
	}
	rows = listQueue(t, svc, sid)
	if rows[0].ScheduledAt != future || rows[1].ScheduledAt != future {
		t.Fatalf("schedule not applied: %+v", rows)
	}

	// Reorder: move "two" onto "one"'s slot → two first.
	if err := svc.ReorderQueueItem(sid, two, one); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	rows = listQueue(t, svc, sid)
	if len(rows) != 2 || rows[0].Text != "two" || rows[1].Text != "one-edited" {
		t.Fatalf("reorder result: %+v", rows)
	}

	// Revoke one.
	if err := svc.RevokeQueueItem(sid, one); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	rows = listQueue(t, svc, sid)
	if len(rows) != 1 || rows[0].Text != "two" {
		t.Fatalf("revoke result: %+v", rows)
	}

	// Every mutation must have emitted a chat:queue snapshot; the last one
	// reflects the final state.
	p, ok := qc.last()
	if !ok {
		t.Fatal("no chat:queue event emitted")
	}
	if p.SessionID != sid || len(p.Items) != 1 || p.Items[0].Text != "two" {
		t.Fatalf("last snapshot = %+v", p)
	}

	// Unknown item id → error (frontend refills composer only on success).
	if err := svc.RevokeQueueItem(sid, "nope"); err == nil {
		t.Fatal("revoking an unknown item must fail")
	}
}

// TestOpenSessionEmitsQueueSnapshot: OpenSession pushes the authoritative
// queue snapshot (initial state for attaching windows), including the
// meaningful-empty case.
func TestOpenSessionEmitsQueueSnapshot(t *testing.T) {
	svc, sid, _ := newTestService(t)
	qc := &queueEventCapture{}
	svc.emitHook = qc.hook

	if err := svc.EnqueueMessage(sid, "parked", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := svc.OpenSession(sid); err != nil {
		t.Fatalf("open: %v", err)
	}
	p, ok := qc.last()
	if !ok || p.SessionID != sid || len(p.Items) != 1 || p.Items[0].Text != "parked" {
		t.Fatalf("OpenSession must emit the queue snapshot, got %+v ok=%v", p, ok)
	}

	// Drain the queue empty, re-open: the empty snapshot must also be emitted
	// (it authoritatively clears stale client state).
	svc.drainQueue(sid) // idle session → sends "parked" (fake harness) and empties the queue
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(listQueue(t, svc, sid)) == 0 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	qc.mu.Lock()
	qc.payload = nil
	qc.mu.Unlock()
	if err := svc.OpenSession(sid); err != nil {
		t.Fatalf("re-open: %v", err)
	}
	p, ok = qc.last()
	if !ok || len(p.Items) != 0 {
		t.Fatalf("empty queue must still emit an (empty) snapshot, got %+v ok=%v", p, ok)
	}
}

// TestQueueTimerFiredSkipsWhenStale: a timer callback whose registration was
// replaced or disarmed (shutdown / session delete / re-arm lost the Stop race)
// must NOT drain — during shutdown a drain could race the store close; only
// the still-registered timer's callback wakes the queue.
func TestQueueTimerFiredSkipsWhenStale(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.EnqueueMessage(sid, "due", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// Arm a far-future schedule so a real timer is registered (it must not
	// fire on its own within the test).
	svc.queueMu.Lock()
	svc.armQueueTimerLocked(sid, []store.QueueItem{store.NewQueueItem("later", "", time.Now().Add(time.Hour).UnixMilli())})
	svc.queueMu.Unlock()
	svc.queueMu.Lock()
	registered := svc.queueTimers[sid]
	svc.queueMu.Unlock()
	if registered == nil {
		t.Fatal("schedule timer must be armed")
	}

	// Stale (unregistered) timer fires → no drain, queue untouched.
	svc.queueTimerFired(sid, &time.Timer{})
	time.Sleep(20 * time.Millisecond)
	if got := fc.count(); got != 0 {
		t.Fatalf("stale timer callback must not drain, got %d prompts (%v)", got, fc.prompts)
	}
	if rows := listQueue(t, svc, sid); len(rows) != 1 || rows[0].Text != "due" {
		t.Fatalf("queue must be untouched by a stale timer fire, got %+v", rows)
	}

	// The registered timer fires → drains the due item.
	svc.queueTimerFired(sid, registered)
	waitStarted(t, fc, 1)
	if fc.prompts[0] != "due" {
		t.Fatalf("registered timer must drain the due item, got %v", fc.prompts)
	}
}

// TestQueueDrainsAfterReconnectSuccess: a queued item whose drain send failed
// during the outage (ensureLive hit a failing spawn) is requeued due-now — no
// schedule timer (timers only cover future items), no running turn — so the
// successful reconnect must re-drain it, or the queue stalls forever.
func TestQueueDrainsAfterReconnectSuccess(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	rec := captureStatuses(svc, sid)

	var (
		mu         sync.Mutex
		chats      []*fakeChat
		spawnCalls int32
	)
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		n := atomic.AddInt32(&spawnCalls, 1)
		if n == 2 {
			// The drain's own ensureLive attempt lands here while the harness
			// is still broken: fail it so the item is requeued due-now.
			return errors.New("spawn harness failed")
		}
		chat := newFakeChat()
		t.Cleanup(chat.release)
		mu.Lock()
		chats = append(chats, chat)
		mu.Unlock()
		if n == 1 {
			// First harness: Prompt dies with peer-disconnected.
			chat.promptErr = errors.New("peer disconnected before response")
		}
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		return nil
	}

	// Park the item first (enqueue never auto-drains), then start a turn that
	// dies peer-disconnected: the error tail drains → dequeue → SendMessage →
	// ensureLive fails (spawn #2) → requeue; the reconnect retry (#3) spawns
	// fine → reconnectLoop must re-drain and send the parked item.
	if err := svc.EnqueueMessage(sid, "queued", nil); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := svc.SendMessage(sid, "first", nil); err != nil {
		t.Fatalf("send: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		// Snapshot the chat list under mu: the spawnFn goroutine appends to
		// chats concurrently (evaluating `chats` outside mu would race on the
		// slice header).
		mu.Lock()
		snap := make([]*fakeChat, len(chats))
		copy(snap, chats)
		mu.Unlock()
		if sent := promptsContain(snap, "queued"); sent {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("queued item must auto-send after reconnect succeeds; spawn calls=%d statuses=%v",
		atomic.LoadInt32(&spawnCalls), rec.snapshot())
}

// promptsContain reports whether any recorded fakeChat Prompt equals text
// (each fakeChat's prompts slice is guarded by its own mu).
func promptsContain(chats []*fakeChat, text string) bool {
	for _, c := range chats {
		c.mu.Lock()
		found := false
		for _, p := range c.prompts {
			if p == text {
				found = true
				break
			}
		}
		c.mu.Unlock()
		if found {
			return true
		}
	}
	return false
}
