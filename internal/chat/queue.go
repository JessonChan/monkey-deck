package chat

// queue.go: server-side per-session message queue (#126A).
//
// The queue used to be frontend memory (App.tsx queueBySession + drainSession):
// it evaporated on window close / app restart, and every remote client held
// its own diverging copy. It now lives here — the single owning process
// (§2.2) — with SQLite as the truth source (§1.5):
//
//   - 5 CRUD bindings: EnqueueMessage / RevokeQueueItem / EditQueueItem /
//     ScheduleQueueItem / ReorderQueueItem. Every mutation persists first,
//     then broadcasts a full authoritative snapshot via the chat:queue event.
//   - drain backendization: runPrompt's terminal tail (and the schedule
//     timer) auto-continues the next DUE item — one queued message = one
//     independent turn, sent in FIFO order (ACP has no queue; one Prompt at
//     a time). The frontend is a DEGRADED EVENT CONSUMER: it renders exactly
//     what chat:queue delivers and never mutates queue state locally.
//   - scheduled send (#97): items with a future scheduledAt are skipped by
//     drain (without blocking later due items); a one-shot timer per session
//     at the earliest future scheduledAt wakes the queue so it cannot sit
//     silently dead with no turn coming.
//
// Locking: all queue-runtime state (stop intents, drain guards, schedule
// timers) lives under queueMu, which is never held while acquiring s.mu or
// sendMu — SendMessage (spawn + busy guard) always runs queue-lock-free.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// queueTimerMaxDelay caps a single schedule-timer delay (~24.8 days) so the
// int64 nanosecond duration cannot overflow (same guard the frontend had).
const queueTimerMaxDelay = 2_147_000_000 * time.Millisecond

// QueueItem is the wire shape of one queued message (chat:queue event +
// bindings). Attachments is the prompt-attachment array exactly as
// SendMessage takes it — built once at enqueue time, reused verbatim by
// drain and by InterruptAndSend ("send now"), so mention/image/audio blocks
// survive the queue round-trip.
type QueueItem struct {
	ID          string           `json:"id"`
	Text        string           `json:"text"`
	Attachments []acp.Attachment `json:"attachments,omitempty"`
	ScheduledAt int64            `json:"scheduledAt"` // epoch ms; due when <= now
}

// QueuePayload is the chat:queue event body: a full per-session snapshot.
// Emitted on every mutation, every drain-dequeue, and on OpenSession
// (initial state for a freshly attaching window).
type QueuePayload struct {
	SessionID string      `json:"sessionId"`
	Items     []QueueItem `json:"items"`
}

// ─── attachments JSON codec (store rows keep an opaque string, §2.1) ────────

func marshalQueueAttachments(atts []acp.Attachment) string {
	if len(atts) == 0 {
		return ""
	}
	b, err := json.Marshal(atts)
	if err != nil {
		slog.Warn("marshal queue attachments", "err", err)
		return ""
	}
	return string(b)
}

func unmarshalQueueAttachments(s string) []acp.Attachment {
	if s == "" {
		return nil
	}
	var atts []acp.Attachment
	if err := json.Unmarshal([]byte(s), &atts); err != nil {
		// Corrupt row: keep the item (its text is the payload users care
		// about); attachments degrade to none rather than failing the read.
		slog.Warn("unmarshal queue attachments", "err", err)
		return nil
	}
	return atts
}

// wireQueueItems converts persisted rows to the event/binding shape.
func wireQueueItems(rows []store.QueueItem) []QueueItem {
	out := make([]QueueItem, len(rows))
	for i, r := range rows {
		out[i] = QueueItem{ID: r.ID, Text: r.Text, Attachments: unmarshalQueueAttachments(r.Attachments), ScheduledAt: r.ScheduledAt}
	}
	return out
}

// emitQueue broadcasts the full queue snapshot (nil normalizes to [] so the
// wire shape stays a stable array; an empty snapshot is itself meaningful —
// it authoritatively clears stale client state).
func (s *ChatService) emitQueue(sessionID string, rows []store.QueueItem) {
	items := wireQueueItems(rows)
	if items == nil {
		items = []QueueItem{}
	}
	s.emit(EventQueue, QueuePayload{SessionID: sessionID, Items: items})
}

// syncQueueSnapshot pushes the persisted queue for a session (best-effort:
// store hiccup → silent, the next mutation re-syncs). OpenSession calls it so
// every attaching window — desktop boot, popout, tab re-open after cache
// eviction, remote reconnect — starts from backend truth.
func (s *ChatService) syncQueueSnapshot(sessionID string) {
	if s.st == nil {
		return
	}
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		return
	}
	s.emitQueue(sessionID, rows)
}

// ─── stop intent (one-shot marker consumed by the next drain) ───────────────

// setUserStopped records a stop intent: StopSession calls it right before
// cancelling the turn, so the drain that follows that turn's idle will skip
// auto-continue (queue kept) — Stop must mean "stop", not "skip one item".
func (s *ChatService) setUserStopped(sessionID string) {
	s.queueMu.Lock()
	s.userStopped[sessionID] = true
	s.queueMu.Unlock()
}

// clearUserStopped drops a pending stop intent. Every user-driven send path
// (direct send / interrupt / enqueue) calls it: sending implies continuing.
func (s *ChatService) clearUserStopped(sessionID string) {
	s.queueMu.Lock()
	delete(s.userStopped, sessionID)
	s.queueMu.Unlock()
}

// consumeUserStopped reports and consumes the one-shot marker (drain entry).
func (s *ChatService) consumeUserStopped(sessionID string) bool {
	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	if s.userStopped[sessionID] {
		delete(s.userStopped, sessionID)
		return true
	}
	return false
}

// cleanupQueueState drops every queue-runtime entry for a session (timers,
// drain guard, stop intent). DeleteSession / RemoveProject use it; rows
// themselves cascade with the session row.
func (s *ChatService) cleanupQueueState(sessionID string) {
	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	if t := s.queueTimers[sessionID]; t != nil {
		t.Stop()
		delete(s.queueTimers, sessionID)
	}
	delete(s.queueDraining, sessionID)
	delete(s.userStopped, sessionID)
}

// ─── CRUD bindings ──────────────────────────────────────────────────────────

// EnqueueMessage appends a message to the session's server-side queue.
// This is the parking path: a turn is running (frontend routes sends here
// while prompting) or the user explicitly enqueued (enqueue button /
// ⌘⇧Enter). It NEVER auto-starts a turn — drain fires at the next turn end
// (frontend parity: park only, so an explicit enqueue doesn't jump the gun).
// Enqueueing implies intent to continue → clears a pending stop intent.
func (s *ChatService) EnqueueMessage(sessionID, text string, attachments []acp.Attachment) error {
	if strings.TrimSpace(text) == "" {
		return errors.New("message is empty")
	}
	s.clearUserStopped(sessionID)
	row := store.NewQueueItem(text, marshalQueueAttachments(attachments), time.Now().UnixMilli())

	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		return fmt.Errorf("list queue: %w", err)
	}
	rows = append(rows, row)
	if err := s.st.ReplaceQueueItems(s.ctx, sessionID, rows); err != nil {
		return fmt.Errorf("persist queue: %w", err)
	}
	s.emitQueue(sessionID, rows)
	return nil
}

// RevokeQueueItem removes one item from the queue. The frontend refills the
// composer from its event-synced copy of the item (the "revoke to edit" flow).
func (s *ChatService) RevokeQueueItem(sessionID, itemID string) error {
	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		return fmt.Errorf("list queue: %w", err)
	}
	idx := queueIndexOf(rows, itemID)
	if idx < 0 {
		return fmt.Errorf("queue item not found: %s", itemID)
	}
	rest := spliceQueueRows(rows, idx)
	if err := s.st.ReplaceQueueItems(s.ctx, sessionID, rest); err != nil {
		return fmt.Errorf("persist queue: %w", err)
	}
	// Removing an item can change which future item is earliest → re-arm.
	s.armQueueTimerLocked(sessionID, rest)
	s.emitQueue(sessionID, rest)
	return nil
}

// EditQueueItem updates a queued item's text in place (inline edit; schedule
// and attachments are kept).
func (s *ChatService) EditQueueItem(sessionID, itemID, text string) error {
	if strings.TrimSpace(text) == "" {
		return errors.New("message is empty")
	}
	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		return fmt.Errorf("list queue: %w", err)
	}
	idx := queueIndexOf(rows, itemID)
	if idx < 0 {
		return fmt.Errorf("queue item not found: %s", itemID)
	}
	rows[idx].Text = text
	if err := s.st.ReplaceQueueItems(s.ctx, sessionID, rows); err != nil {
		return fmt.Errorf("persist queue: %w", err)
	}
	s.emitQueue(sessionID, rows)
	return nil
}

// ScheduleQueueItem sets (or clears) a queued item's scheduledAt. <= 0 / now
// means "due immediately". Mirrors the old frontend behavior: changing the
// schedule while idle with the item now due sends it right away; a future
// time parks it until the one-shot timer fires.
func (s *ChatService) ScheduleQueueItem(sessionID, itemID string, scheduledAt int64) error {
	s.queueMu.Lock()
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		s.queueMu.Unlock()
		return fmt.Errorf("list queue: %w", err)
	}
	idx := queueIndexOf(rows, itemID)
	if idx < 0 {
		s.queueMu.Unlock()
		return fmt.Errorf("queue item not found: %s", itemID)
	}
	at := scheduledAt
	if at <= 0 {
		at = time.Now().UnixMilli()
	}
	rows[idx].ScheduledAt = at
	if err := s.st.ReplaceQueueItems(s.ctx, sessionID, rows); err != nil {
		s.queueMu.Unlock()
		return fmt.Errorf("persist queue: %w", err)
	}
	s.armQueueTimerLocked(sessionID, rows)
	s.emitQueue(sessionID, rows)
	s.queueMu.Unlock()

	if at <= time.Now().UnixMilli() && !s.isBusy(sessionID) {
		go s.drainQueue(sessionID)
	}
	return nil
}

// ReorderQueueItem moves item activeID onto overID's position (remove, then
// insert at overID's index) — the drag-drop / mobile up-down semantics.
// While idle with a due first item, drains immediately (order changed which
// message goes next).
func (s *ChatService) ReorderQueueItem(sessionID, activeID, overID string) error {
	if activeID == overID {
		return nil
	}
	s.queueMu.Lock()
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		s.queueMu.Unlock()
		return fmt.Errorf("list queue: %w", err)
	}
	from := queueIndexOf(rows, activeID)
	to := queueIndexOf(rows, overID)
	if from < 0 || to < 0 {
		s.queueMu.Unlock()
		return fmt.Errorf("queue item not found: %s / %s", activeID, overID)
	}
	moved := rows[from]
	rest := spliceQueueRows(rows, from)
	rows = append(rest[:to], append([]store.QueueItem{moved}, rest[to:]...)...)
	if err := s.st.ReplaceQueueItems(s.ctx, sessionID, rows); err != nil {
		s.queueMu.Unlock()
		return fmt.Errorf("persist queue: %w", err)
	}
	s.armQueueTimerLocked(sessionID, rows)
	s.emitQueue(sessionID, rows)
	s.queueMu.Unlock()

	if !s.isBusy(sessionID) {
		go s.drainQueue(sessionID)
	}
	return nil
}

// queueIndexOf finds an item's position (-1 when absent).
func queueIndexOf(rows []store.QueueItem, id string) int {
	for i := range rows {
		if rows[i].ID == id {
			return i
		}
	}
	return -1
}

// spliceQueueRows returns rows without the given index (fresh slice, no
// aliasing surprises for later reinsertion).
func spliceQueueRows(rows []store.QueueItem, idx int) []store.QueueItem {
	out := make([]store.QueueItem, 0, len(rows)-1)
	out = append(out, rows[:idx]...)
	out = append(out, rows[idx+1:]...)
	return out
}

// ─── drain (auto-continue) ──────────────────────────────────────────────────

// drainQueue sends the next DUE queue item for the session as a fresh turn.
// Triggered by runPrompt's terminal tail (idle/error/notice — the turn ended),
// by the schedule timer, and by schedule/reorder mutations while idle.
//
// Semantics (frontend drainSession parity, §5.3 respect the data source):
//   - user-stop marker consumed first → skip this auto-continue, keep queue;
//   - future-scheduled items are skipped, later due items are not blocked;
//   - all-future queue → arm the one-shot timer instead of sending;
//   - dequeue-before-send (exactly-once across restarts); a failed send
//     (busy race / spawn failure) re-queues the item at its original
//     position instead of losing it.
//
// The per-session drain guard collapses concurrent triggers (duplicate idle
// events, timer + turn-end racing) into one dequeue; the backend busy guard
// remains the final backstop.
func (s *ChatService) drainQueue(sessionID string) {
	if s.consumeUserStopped(sessionID) {
		return
	}
	s.queueMu.Lock()
	if s.queueDraining[sessionID] {
		s.queueMu.Unlock()
		return
	}
	s.queueDraining[sessionID] = true
	s.queueMu.Unlock()
	defer func() {
		s.queueMu.Lock()
		delete(s.queueDraining, sessionID)
		s.queueMu.Unlock()
	}()

	next, dueIdx, ok := s.dequeueDue(sessionID)
	if !ok {
		return
	}
	// Send OUTSIDE every queue lock: SendMessage may block on spawn (spawnMu)
	// and on the session's sendMu while the ending turn finishes its tail.
	if err := s.SendMessage(sessionID, next.Text, unmarshalQueueAttachments(next.Attachments)); err != nil {
		slog.Warn("queue drain send failed, re-queueing", "session", sessionID, "err", err)
		s.requeueAt(sessionID, dueIdx, next)
	}
}

// dequeueDue atomically removes and persists the first due item. Returns the
// removed row and its original index (for requeue-on-send-failure).
func (s *ChatService) dequeueDue(sessionID string) (store.QueueItem, int, bool) {
	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		slog.Warn("queue drain: list", "session", sessionID, "err", err)
		return store.QueueItem{}, 0, false
	}
	nowMs := time.Now().UnixMilli()
	dueIdx := -1
	for i := range rows {
		if rows[i].ScheduledAt <= nowMs {
			dueIdx = i
			break
		}
	}
	if dueIdx < 0 {
		// Everything is future-scheduled: keep the queue alive via the timer.
		s.armQueueTimerLocked(sessionID, rows)
		return store.QueueItem{}, 0, false
	}
	next := rows[dueIdx]
	rest := spliceQueueRows(rows, dueIdx)
	if err := s.st.ReplaceQueueItems(s.ctx, sessionID, rest); err != nil {
		// Dequeue failed → do NOT send (would duplicate on retry).
		slog.Warn("queue drain: dequeue", "session", sessionID, "err", err)
		return store.QueueItem{}, 0, false
	}
	s.armQueueTimerLocked(sessionID, rest)
	s.emitQueue(sessionID, rest)
	return next, dueIdx, true
}

// requeueAt re-inserts an item at its original position after a failed send.
func (s *ChatService) requeueAt(sessionID string, idx int, row store.QueueItem) {
	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	rows, err := s.st.ListQueueItems(s.ctx, sessionID)
	if err != nil {
		slog.Warn("queue requeue: list", "session", sessionID, "err", err)
		return
	}
	if idx > len(rows) {
		idx = len(rows)
	}
	out := make([]store.QueueItem, 0, len(rows)+1)
	out = append(out, rows[:idx]...)
	out = append(out, row)
	out = append(out, rows[idx:]...)
	if err := s.st.ReplaceQueueItems(s.ctx, sessionID, out); err != nil {
		slog.Warn("queue requeue: persist", "session", sessionID, "err", err)
		return
	}
	s.armQueueTimerLocked(sessionID, out)
	s.emitQueue(sessionID, out)
}

// ─── schedule timer ─────────────────────────────────────────────────────────

// armQueueTimerLocked (re)arms the session's one-shot timer at the earliest
// future scheduledAt; no future items → disarms. Idempotent. Caller MUST hold
// queueMu (every mutation site already does).
func (s *ChatService) armQueueTimerLocked(sessionID string, rows []store.QueueItem) {
	if t := s.queueTimers[sessionID]; t != nil {
		t.Stop()
		delete(s.queueTimers, sessionID)
	}
	nowMs := time.Now().UnixMilli()
	var earliest int64
	for _, r := range rows {
		if r.ScheduledAt > nowMs && (earliest == 0 || r.ScheduledAt < earliest) {
			earliest = r.ScheduledAt
		}
	}
	if earliest == 0 {
		return
	}
	delay := time.Duration(earliest-nowMs) * time.Millisecond
	if delay > queueTimerMaxDelay {
		delay = queueTimerMaxDelay
	}
	var t *time.Timer
	t = time.AfterFunc(delay, func() {
		// Read the captured t under queueMu before anything else: the
		// assignment above runs while the caller holds queueMu, so the
		// mutex release→acquire edge is what makes this read race-free
		// (Go's AfterFunc self-reference gotcha — evaluating it as a call
		// argument has no such edge).
		s.queueMu.Lock()
		self := t
		s.queueMu.Unlock()
		s.queueTimerFired(sessionID, self)
	})
	s.queueTimers[sessionID] = t
}

// queueTimerFired handles a schedule-timer callback. It only drains when this
// timer is still the registered one for the session: a callback that lost the
// Stop race against stopAllQueueTimers (shutdown), cleanupQueueState (session
// deleted) or a re-arm (queue changed) must NOT fire a drain — during shutdown
// that is exactly the "drain races the store close" hazard stopAllQueueTimers
// exists to prevent (a drain could even spawn a harness mid-teardown via
// ensureLive).
func (s *ChatService) queueTimerFired(sessionID string, self *time.Timer) {
	s.queueMu.Lock()
	cur, registered := s.queueTimers[sessionID]
	mine := registered && cur == self
	if mine {
		delete(s.queueTimers, sessionID)
	}
	s.queueMu.Unlock()
	if mine {
		s.drainQueue(sessionID)
	}
}

// stopAllQueueTimers disarms every schedule timer (ServiceShutdown — drain
// callbacks must not race the store close).
func (s *ChatService) stopAllQueueTimers() {
	s.queueMu.Lock()
	defer s.queueMu.Unlock()
	for id, t := range s.queueTimers {
		t.Stop()
		delete(s.queueTimers, id)
	}
}
