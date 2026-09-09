package chat

// turn_stamp_test.go — #209: every content event (agent/thought chunk, tool_call,
// tool_call_update) must carry the live turn's id when one exists. Harnesses
// that replay history after resume (codebuddy, production forensic 2026-09-09)
// re-emit events with the SAME toolCallId/messageId from earlier turns; the
// frontend merge keys on turnId-qualified ids to keep replayed copies distinct.
// Without the stamp the frontend cannot disambiguate and renders jumbled rows.

import (
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

func TestContentEventsCarryLiveTurnID(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// No live turn (idle replay window): the stamp stays empty — the frontend
	// falls back to the raw id for those events.
	var got []string
	capture := func() {
		hook := func(name string, data any) {
			if ev, ok := data.(acp.SessionEvent); ok {
				got = append(got, ev.Kind+"="+ev.TurnID)
			}
		}
		svc.emitHook = hook
		defer func() { svc.emitHook = nil }()
	}

	capture()
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "a", MessageID: "m1"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolStatus: "completed"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "t1", ToolStatus: "in_progress"})
	for _, g := range got {
		if g[len(g)-1] != '=' {
			t.Fatalf("idle event must carry empty TurnID, got %v", got)
		}
	}

	// Live turn: every content event is stamped with the turn id.
	ls.mu.Lock()
	ls.currentTurnID = "turn-live"
	ls.mu.Unlock()
	got = nil
	capture()
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "a", MessageID: "m1"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "t", MessageID: "m2"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolStatus: "completed"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "t1", ToolStatus: "in_progress"})
	for _, g := range got {
		if g[len(g)-1] != 'e' {
			t.Fatalf("live-turn events must carry TurnID=turn-live, got %v", got)
		}
	}
}
