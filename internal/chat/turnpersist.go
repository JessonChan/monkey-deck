package chat

// turnpersist.go: incremental turn persistence (#125).
//
// Model: the timeline is the single source of truth (§5.4 #5, #12); persistence
// is split into two layers —
//   1. Incremental flush (this file): while a turn is running, events dirty
//      timeline entries and a 1s-debounced batch UpsertTurnMessage writes them
//      to the DB. A crash / kill loses at most ~1s of streamed content, not
//      the whole turn.
//   2. Turn-end reconcile (persistTurn, this file): when the turn ends, every
//      timeline entry is upserted — rows already flushed are updated in place
//      to the final full text, unflushed ones are inserted. Idempotent: no
//      matter how many flushes ran, the DB converges to the timeline's final
//      state.
//
// Concurrency invariants (§5.3 find the invariant, don't pile up ifs):
//   - Upsert primary key = (session_id, turn_id, entry_key). turn_id = the
//     user message id that opened the turn; entry_key = timeline entry id
//     (messageId key / toolCallId / fallback key). The timeline only appends,
//     never shifts → the first write fixes seq; replays never reorder.
//   - Flush and reconcile are serialized via ls.persistMu; flush re-validates
//     turnID inside the persistMu critical section (runPrompt clears
//     currentTurnID before reconcile), so a stale snapshot is always a no-op
//     and partial content can never overwrite the final full text.
//   - The debounce is "1s after the FIRST dirty event" (trailing throttle),
//     not "1s after the last event" — continuous streaming never starves the
//     flush; the write interval is bounded at 1s.

import (
	"encoding/json"
	"log/slog"
	"strings"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

// turnPersistItem is one timeline entry's persist form (upsert arguments).
type turnPersistItem struct {
	entryKey   string
	role       string
	kind       string
	content    string
	toolCallID string
}

// buildTurnItem converts a timeline entry into its persist form. Whitespace-
// only messages return ok=false (same skip semantics as the old persistTurn:
// empty thought/agent segments are not persisted). Caller must hold ls.mu
// (strings.Builder / toolAccum are not concurrency-safe).
func buildTurnItem(e *turnEntry) (turnPersistItem, bool) {
	switch e.kind {
	case "message":
		content := e.text.String()
		if strings.TrimSpace(content) == "" {
			return turnPersistItem{}, false
		}
		kind := "agent_message_chunk"
		if e.role == "thought" {
			kind = "agent_thought_chunk"
		}
		return turnPersistItem{entryKey: e.id, role: e.role, kind: kind, content: content}, true
	case "tool":
		body, _ := json.Marshal(e.tool)
		return turnPersistItem{entryKey: e.id, role: "tool", kind: "tool_call", content: string(body), toolCallID: e.tool.ID}, true
	}
	return turnPersistItem{}, false
}

// markTurnDirty registers a timeline entry as pending-write after an event
// dirtied it, and schedules the debounced flush if none is pending. Caller
// must hold ls.mu (inside handleEvent). No running turn (currentTurnID="")
// registers nothing: late async updates arriving after turn end were not
// persisted before this change either (no regression); the reconcile owns the
// final state.
func (s *ChatService) markTurnDirty(ls *liveSession, sessionID, entryID string) {
	if ls.currentTurnID == "" {
		return
	}
	if ls.flushDirty == nil {
		ls.flushDirty = map[string]struct{}{}
	}
	ls.flushDirty[entryID] = struct{}{}
	if ls.flushTimer != nil {
		return // a flush is already scheduled: keep accumulating within the window, timer untouched
	}
	turnID := ls.currentTurnID
	interval := s.turnFlushEvery
	if interval <= 0 {
		return // disabled (defensive; production NewChatService defaults to 1s)
	}
	ls.flushTimer = time.AfterFunc(interval, func() { s.flushTurn(sessionID, ls, turnID) })
}

// flushTurn performs one incremental persist (debounce timer callback):
// serialize (persistMu) → re-validate the turn → snapshot dirty entries in
// timeline order → upsert one by one.
func (s *ChatService) flushTurn(sessionID string, ls *liveSession, turnID string) {
	ls.persistMu.Lock()
	defer ls.persistMu.Unlock()
	// Re-validate inside the persistMu critical section: if the turn already
	// finalized while we waited (currentTurnID is cleared before reconcile),
	// the stale snapshot is void — the reconcile has written / will write the
	// authoritative final state; partial content must not overwrite it.
	items := s.takeDirtyTurnItems(ls, turnID)
	if len(items) == 0 {
		return
	}
	slog.Debug("flush turn entries", "session", sessionID, "turn", turnID, "entries", len(items))
	for _, it := range items {
		s.upsertTurnItem(sessionID, turnID, it)
	}
}

// takeDirtyTurnItems snapshots the dirty entries' persist form under ls.mu
// and clears the dirty set. If the turn has moved on (≠turnID) it returns nil
// (stale flush no-op; the dirty set is left untouched so a new turn's dirty
// set is not affected).
func (s *ChatService) takeDirtyTurnItems(ls *liveSession, turnID string) []turnPersistItem {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.flushTimer = nil
	if ls.currentTurnID != turnID {
		return nil
	}
	var items []turnPersistItem
	for _, e := range ls.timeline {
		if _, ok := ls.flushDirty[e.id]; !ok {
			continue
		}
		if it, ok := buildTurnItem(e); ok {
			items = append(items, it)
		}
	}
	// The dirty set is consumed as a whole (whitespace-only messages skipped
	// don't wait for a replay; getting dirty again re-registers them).
	ls.flushDirty = nil
	return items
}

// upsertTurnItem writes one entry (failures are logged only; they don't
// affect the other entries or the main flow).
func (s *ChatService) upsertTurnItem(sessionID, turnID string, it turnPersistItem) {
	if _, err := s.st.UpsertTurnMessage(s.ctx, sessionID, turnID, it.entryKey, it.role, it.kind, it.content, it.toolCallID); err != nil {
		slog.Warn("upsert turn entry", "session", sessionID, "turn", turnID, "entry", it.entryKey, "err", err)
	}
}

// persistTurn is the turn-end reconcile (#125): when the turn ends, every
// timeline entry is upserted in true chronological order so the DB converges
// to the final full text — rows already flushed incrementally are updated in
// place, the rest are inserted. Idempotent: repeated calls interleaved with
// any number of flushes converge to the same result. Messages (thought/agent)
// and tools are written interleaved, so reloading a session replays history
// in the same order as the live stream (§5.4 #12).
//
// Concurrency: first stop any scheduled flush timer and clear the dirty set
// (the reconcile fully covers it), then take persistMu to serialize with
// in-flight flushes — a later stale flush no-ops because currentTurnID is
// already cleared.
func (s *ChatService) persistTurn(ls *liveSession, sessionID, turnID string, timeline []*turnEntry) {
	if s.persistHook != nil {
		s.persistHook() // test hook: block here to widen the finalize window (nil in production, pass-through)
	}
	// Stop the scheduled flush timer and clear the dirty set (the reconcile
	// fully covers it), snapshotting the timeline's final state in the same
	// critical section — after Prompt returns a late tool_call_update can
	// still concurrently patch toolAccum, so the snapshot must hold ls.mu.
	ls.mu.Lock()
	if ls.flushTimer != nil {
		ls.flushTimer.Stop()
		ls.flushTimer = nil
	}
	ls.flushDirty = nil
	items := make([]turnPersistItem, 0, len(timeline))
	for _, e := range timeline {
		if it, ok := buildTurnItem(e); ok {
			items = append(items, it)
		}
	}
	ls.mu.Unlock()
	// Take persistMu to serialize with in-flight flushes: a later stale flush
	// no-ops because currentTurnID is already cleared.
	ls.persistMu.Lock()
	defer ls.persistMu.Unlock()
	for _, it := range items {
		s.upsertTurnItem(sessionID, turnID, it)
	}
}

// persistTurnPlan persists the turn's final plan snapshot (role='plan'
// message) so reopening a session can review each turn's plan. Empty entries
// are not written (a turn without a plan leaves no trace). The turnID is
// stored in the tool_call_id column; the frontend pins plan items to their
// turn with it (plans are per-turn indexed history snapshots). Written via
// UpsertTurnMessage (entry_key="plan") for idempotence: same mechanism as
// messages, replays never duplicate.
func (s *ChatService) persistTurnPlan(sessionID, turnID string, entries []acp.PlanEntry) {
	if len(entries) == 0 {
		return
	}
	body, err := json.Marshal(entries)
	if err != nil {
		slog.Warn("marshal plan entries", "err", err)
		return
	}
	if _, err := s.st.UpsertTurnMessage(s.ctx, sessionID, turnID, "plan", "plan", "plan", string(body), turnID); err != nil {
		slog.Warn("persist plan", "err", err)
	}
}
