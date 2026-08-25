package chat

// turn_persist_test.go: incremental turn persistence regression (#125,
// turnpersist.go).
//
// Coverage:
//   - Incremental flush: while a turn is running (no persistTurn finalize),
//     partial content reaches the DB after the debounce — a crash / kill
//     loses at most one debounce window, not the whole turn.
//   - Upsert accumulation: streaming continues after a flush; the same entry
//     stays one row with the accumulated full text.
//   - Turn-end reconcile: flushed rows update to the final full text,
//     unflushed ones insert; repeated reconcile is idempotent; order equals
//     the timeline's true sequence (thought→tool→agent interleaved, §5.4
//     #5/#12).
//   - Stale flush no-op: a flush firing after the turn ended (currentTurnID
//     cleared) must not write partial content back over the final state.
//   - resetBuffers clears debounce leftovers: cross-turn timers / dirty sets
//     don't pollute the new turn.
//   - Concurrency: event stream racing the flush (with -race); after
//     convergence each entry is exactly one row with complete content.

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

// beginTestTurn sets currentTurnID directly, simulating that startTurn has
// happened (bypassing the Prompt flow to focus on persistence semantics).
// Returns a cleanup that clears currentTurnID, simulating runPrompt
// finalization.
func beginTestTurn(ls *liveSession, turnID string) func() {
	ls.mu.Lock()
	ls.currentTurnID = turnID
	ls.mu.Unlock()
	return func() {
		ls.mu.Lock()
		ls.currentTurnID = ""
		ls.mu.Unlock()
	}
}

// waitUntil polls until cond holds (2s default timeout).
func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("timeout waiting for condition")
}

func listRows(t *testing.T, svc *ChatService, sid string) []struct {
	role, kind, content string
	seq                 int64
} {
	t.Helper()
	msgs, err := svc.st.ListMessages(svc.ctx, sid)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	var out []struct {
		role, kind, content string
		seq                 int64
	}
	for _, m := range msgs {
		out = append(out, struct {
			role, kind, content string
			seq                 int64
		}{m.Role, m.Kind, m.Content, m.Seq})
	}
	return out
}

// Incremental flush: the turn is not finalized (persistTurn not called);
// after the debounce window partial content is already in the DB.
func TestFlushTurnPersistsIncrementally(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]
	end := beginTestTurn(ls, "turn-1")
	defer end()

	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "先想", MessageID: "m1"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "部分回", MessageID: "m2"})

	// No finalize: after the debounce (5ms injected in tests) the thought +
	// tool + agent rows should appear.
	waitUntil(t, func() bool { return len(listRows(t, svc, sid)) >= 3 })

	rows := listRows(t, svc, sid)
	if rows[0].role != "thought" || rows[1].role != "tool" || rows[2].role != "agent" {
		t.Fatalf("incremental rows wrong: %+v", rows)
	}
	if rows[2].content != "部分回" {
		t.Fatalf("partial content not flushed: %+v", rows[2])
	}
}

// Upsert accumulation: streaming continues after a flush; the same entry
// stays one row with the accumulated full text.
func TestFlushTurnUpsertAccumulates(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]
	end := beginTestTurn(ls, "turn-1")
	defer end()

	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "你好", MessageID: "mA"})
	waitUntil(t, func() bool {
		for _, r := range listRows(t, svc, sid) {
			if r.content == "你好" {
				return true
			}
		}
		return false
	})

	// Keep streaming with the same messageId → still 1 row with the full text
	// after the next flush.
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: ",世界", MessageID: "mA"})
	waitUntil(t, func() bool {
		for _, r := range listRows(t, svc, sid) {
			if r.content == "你好,世界" {
				return true
			}
		}
		return false
	})
	if got := len(listRows(t, svc, sid)); got != 1 {
		t.Fatalf("accumulation broke idempotence: want 1 row, got %d", got)
	}
}

// Turn-end reconcile: the final write after incremental flushes — idempotent,
// order = true sequence, content = final full text.
func TestPersistTurnReconcileAfterFlush(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]

	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "想", MessageID: "m1"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "答", MessageID: "m2"})
	// Tool terminal state gains output (arriving during incremental flushes).
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "T1", ToolStatus: "completed", RawOutput: "42"})

	// Finalize: finalize + reconcile (runPrompt semantics: clear currentTurnID
	// before persistTurn).
	ls.mu.Lock()
	timeline := ls.finalizeTurn()
	ls.currentTurnID = ""
	ls.mu.Unlock()
	svc.persistTurn(ls, sid, "turn-1", timeline)
	svc.persistTurn(ls, sid, "turn-1", timeline) // replay: idempotent

	rows := listRows(t, svc, sid)
	if len(rows) != 3 {
		t.Fatalf("reconcile not idempotent: want 3 rows, got %d: %+v", len(rows), rows)
	}
	want := []string{"thought", "tool", "agent"}
	for i, w := range want {
		if rows[i].role != w {
			t.Fatalf("row[%d].role: want %q got %q — order diverges from the true sequence", i, w, rows[i].role)
		}
	}
	var ta toolAccum
	if err := json.Unmarshal([]byte(rows[1].content), &ta); err != nil {
		t.Fatalf("tool row not toolAccum JSON: %v", err)
	}
	if ta.Status != "completed" || ta.RawOutput != "42" {
		t.Fatalf("final tool state not reconciled: %+v", ta)
	}
}

// Crash simulation: the process "dies" after an incremental flush (no
// finalize); the DB keeps the partial content; a new turn then starts
// (resetBuffers) and the old turn's stale flush must not pollute it.
func TestStaleFlushAfterTurnEndIsNoop(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]

	end := beginTestTurn(ls, "turn-1")
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "turn1部分", MessageID: "mA"})
	waitUntil(t, func() bool {
		for _, r := range listRows(t, svc, sid) {
			if r.content == "turn1部分" {
				return true
			}
		}
		return false
	})
	end() // simulate runPrompt finalize: currentTurnID cleared (reconcile wrote the final state)

	// Stale flush (the turn's scheduled timer fires only now): must not write
	// anything.
	svc.flushTurn(sid, ls, "turn-1")
	rows := listRows(t, svc, sid)
	if len(rows) != 1 || rows[0].content != "turn1部分" {
		t.Fatalf("stale flush wrote data: %+v", rows)
	}
}

// resetBuffers clears the previous round's debounce timer and dirty set: the
// new turn's dirty entries start from zero, and the old timer (even if it
// already fired) can't swallow the new turn's incremental writes.
func TestResetBuffersClearsPendingFlush(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]

	end := beginTestTurn(ls, "turn-1")
	defer end()
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "t1", MessageID: "mA"})
	ls.mu.Lock()
	pending := ls.flushTimer != nil
	ls.mu.Unlock()
	if !pending {
		t.Fatal("expected a flush timer to be scheduled after a dirty event")
	}
	// Wait for turn-1's incremental write to land (resetBuffers stops the
	// pending timer, so let it finish its job first).
	waitUntil(t, func() bool {
		for _, r := range listRows(t, svc, sid) {
			if r.content == "t1" {
				return true
			}
		}
		return false
	})

	ls.resetBuffers() // turn boundary: startTurn semantics
	ls.mu.Lock()
	if ls.flushTimer != nil || ls.flushDirty != nil {
		ls.mu.Unlock()
		t.Fatal("resetBuffers must stop the pending flush timer and clear dirty set")
	}
	ls.mu.Unlock()

	// New turn: same fallback key as turn-1 (no-messageId case); turn_id
	// disambiguates.
	end2 := beginTestTurn(ls, "turn-2")
	defer end2()
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "t2"})
	waitUntil(t, func() bool {
		for _, r := range listRows(t, svc, sid) {
			if r.content == "t2" {
				return true
			}
		}
		return false
	})
	rows := listRows(t, svc, sid)
	if len(rows) != 2 || rows[0].content != "t1" || rows[1].content != "t2" {
		t.Fatalf("turn-scoped rows wrong: %+v", rows)
	}
}

// Concurrency: multi-goroutine event streams × debounced flush (-race
// verifies the locked snapshot); reconcile after convergence — each entry
// exactly one row, complete content, no interleaved corruption.
func TestFlushConcurrentWithEventStream(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]
	end := beginTestTurn(ls, "turn-1")
	defer end()

	const workers = 4
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				svc.handleEvent(ls, sid, acp.SessionEvent{
					Kind:      "agent_message_chunk",
					Text:      "x",
					MessageID: "mA", // concurrent accumulation on the same key
				})
				svc.handleEvent(ls, sid, acp.SessionEvent{
					Kind:        "tool_call_update",
					ToolCallID:  "T1",
					ToolStatus:  "in_progress",
					RawOutput:   w*i + 1,
				})
			}
		}(w)
	}
	wg.Wait()
	// Let the last debounced flush settle, then do the turn-end reconcile.
	time.Sleep(30 * time.Millisecond)

	ls.mu.Lock()
	timeline := ls.finalizeTurn()
	ls.currentTurnID = ""
	ls.mu.Unlock()
	svc.persistTurn(ls, sid, "turn-1", timeline)

	rows := listRows(t, svc, sid)
	if len(rows) != 2 {
		t.Fatalf("want exactly 1 message + 1 tool row, got %d: %+v", len(rows), rows)
	}
	wantText := ""
	for i := 0; i < workers*50; i++ {
		wantText += "x"
	}
	if rows[0].role != "agent" || rows[0].content != wantText {
		t.Fatalf("agent row incomplete: len=%d want=%d", len(rows[0].content), len(wantText))
	}
	var ta toolAccum
	if err := json.Unmarshal([]byte(rows[1].content), &ta); err != nil {
		t.Fatalf("tool row corrupted: %v", err)
	}
}

// The plan snapshot writes idempotently via UpsertTurnMessage: repeated
// finalize leaves no duplicate rows; tool_call_id still pins the turn.
func TestPersistTurnPlanUpsertIdempotent(t *testing.T) {
	svc, sid, _ := newTestService(t)
	entries := []acp.PlanEntry{{Content: "a", Status: "completed"}}
	svc.persistTurnPlan(sid, "turn-1", entries)
	svc.persistTurnPlan(sid, "turn-1", entries)

	rows := listRows(t, svc, sid)
	if len(rows) != 1 {
		t.Fatalf("plan upsert not idempotent: %+v", rows)
	}
	msgs, _ := svc.st.ListMessages(svc.ctx, sid)
	if msgs[0].Role != "plan" || msgs[0].ToolCallID != "turn-1" || msgs[0].EntryKey != "plan" {
		t.Fatalf("plan row shape wrong: %+v", msgs[0])
	}
}
