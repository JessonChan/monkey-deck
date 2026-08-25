package chat

// session_statuses_test.go: read-only status snapshot for remote:resync
// reconciliation (AGENTS.md §5.1: mock chatConn, no real harness).
//
// Reproduces the two mirror bugs the pull API fixes:
//   - #127: remote client connected AFTER a turn started (missed the
//     "prompting" push) → snapshot must still report "prompting".
//   - #134: remote client's WS dropped BEFORE the turn ended (missed the
//     "idle" push) → snapshot must report "idle" once the turn is over.
//
// Plus the derived-state matrix: reconnecting / gave-up / closed-absent.

import (
	"testing"
	"time"
)

// TestSessionStatusesBusyTurn repro #127: turn in flight (no status event
// consumed) → snapshot reports "prompting" so a late-connected client seeds
// its composer/queue behavior from backend truth instead of a missed event.
func TestSessionStatusesBusyTurn(t *testing.T) {
	svc, sid, fc := newTestService(t)
	if err := svc.SendMessage(sid, "hello", nil); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	waitStarted(t, fc, 1) // Prompt entered (blocked until release)
	if st := svc.SessionStatuses()[sid]; st != "prompting" {
		t.Fatalf("busy turn: want prompting, got %q", st)
	}
}

// TestSessionStatusesIdleAfterTurn repro #134: turn finishes while the client
// was disconnected (idle event lost) → snapshot reports "idle".
func TestSessionStatusesIdleAfterTurn(t *testing.T) {
	svc, sid, fc := newTestService(t)
	if err := svc.SendMessage(sid, "hello", nil); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	waitStarted(t, fc, 1)
	fc.release() // turn ends → busy=false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if svc.SessionStatuses()[sid] == "idle" {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("turn finished: want idle, got %q", svc.SessionStatuses()[sid])
}

// TestSessionStatusesDerivedStates covers the non-busy derivation branches and
// the absence contract (closed / never-spawned sessions must not appear).
func TestSessionStatusesDerivedStates(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	ls := &liveSession{chat: newFakeChat(), proj: nil, index: map[string]*turnEntry{}}
	svc.mu.Lock()
	svc.active[sid] = ls
	svc.mu.Unlock()

	// Live but idle → "idle".
	if st := svc.SessionStatuses()[sid]; st != "idle" {
		t.Fatalf("live idle: want idle, got %q", st)
	}
	// Reconnect in flight → "reconnecting".
	ctl := &reconnectCtl{stop: make(chan struct{}), done: make(chan struct{})}
	svc.mu.Lock()
	svc.reconnects[sid] = ctl
	svc.mu.Unlock()
	if st := svc.SessionStatuses()[sid]; st != "reconnecting" {
		t.Fatalf("reconnecting: want reconnecting, got %q", st)
	}
	// Reconnect exhausted → "error".
	svc.mu.Lock()
	delete(svc.reconnects, sid)
	svc.reconnectGiveUp[sid] = true
	svc.mu.Unlock()
	if st := svc.SessionStatuses()[sid]; st != "error" {
		t.Fatalf("gave-up: want error, got %q", st)
	}
	// Closed → absent: callers drop stale cached "prompting" for absent ids.
	svc.mu.Lock()
	delete(svc.active, sid)
	delete(svc.reconnectGiveUp, sid)
	svc.mu.Unlock()
	if _, ok := svc.SessionStatuses()[sid]; ok {
		t.Fatal("closed session must be absent from the snapshot")
	}
	// Empty map (not nil) when nothing is live — stable wire shape for bindings.
	if got := svc.SessionStatuses(); got == nil || len(got) != 0 {
		t.Fatalf("no live sessions: want empty non-nil map, got %#v", got)
	}
}
