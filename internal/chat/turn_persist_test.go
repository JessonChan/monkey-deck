package chat

// turn_persist_test.go:增量落库回归(#125,turnpersist.go)。
//
// 覆盖:
//   - 增量 flush:turn 进行中(无 persistTurn 收尾)防抖后 DB 即有部分内容
//     —— 崩溃 / 杀进程最多丢一个防抖窗口,而非整轮。
//   - upsert 累积:flush 后继续流式,同 entry 仍一行,内容为累积全文。
//   - 收尾 reconcile:flush 过的行更新为最终全文,未 flush 的插入;重复 reconcile
//     幂等;顺序 = timeline 真实时序(thought→tool→agent 交错,§5.4 #5/#12)。
//   - 陈旧 flush no-op:turn 已收尾(currentTurnID 已清)后 flush 触发,不得把
//     部分内容写回覆盖终态。
//   - resetBuffers 清防抖遗留:跨 turn 定时器 / 脏集不污染新 turn。
//   - 并发:事件流与 flush 并发(配 -race),收敛后每 entry 恰一行、内容完整。

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

// beginTestTurn 直接置 currentTurnID,模拟 startTurn 已发生(绕开 Prompt 流程,
// 聚焦落库语义)。返回收尾用的清理(清 currentTurnID,模拟 runPrompt finalize)。
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

// waitUntil 轮询等待条件成立(默认 2s 超时)。
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

// 增量 flush:turn 未收尾(不调 persistTurn),防抖窗口后部分内容已在库。
func TestFlushTurnPersistsIncrementally(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]
	end := beginTestTurn(ls, "turn-1")
	defer end()

	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "先想", MessageID: "m1"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "部分回", MessageID: "m2"})

	// 不等收尾:防抖(测试注入 5ms)后应出现 thought + tool + agent 三行。
	waitUntil(t, func() bool { return len(listRows(t, svc, sid)) >= 3 })

	rows := listRows(t, svc, sid)
	if rows[0].role != "thought" || rows[1].role != "tool" || rows[2].role != "agent" {
		t.Fatalf("incremental rows wrong: %+v", rows)
	}
	if rows[2].content != "部分回" {
		t.Fatalf("partial content not flushed: %+v", rows[2])
	}
}

// upsert 累积:flush 后继续流式,同 entry 仍是一行,内容为累积全文。
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

	// 同 messageId 继续流式 → 再 flush 后仍是 1 行、全文。
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

// 收尾 reconcile:增量 flush 之后的终态写入 —— 幂等、顺序 = 真实时序、内容为最终全文。
func TestPersistTurnReconcileAfterFlush(t *testing.T) {
	svc, sid, _ := newTestService(t)
	ls := svc.active[sid]

	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "想", MessageID: "m1"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "agent_message_chunk", Text: "答", MessageID: "m2"})
	// tool 终态补输出(增量 flush 期间到达)。
	svc.handleEvent(ls, sid, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "T1", ToolStatus: "completed", RawOutput: "42"})

	// 收尾:finalize + reconcile(runPrompt 语义:先清 currentTurnID 再 persistTurn)。
	ls.mu.Lock()
	timeline := ls.finalizeTurn()
	ls.currentTurnID = ""
	ls.mu.Unlock()
	svc.persistTurn(ls, sid, "turn-1", timeline)
	svc.persistTurn(ls, sid, "turn-1", timeline) // 重放:幂等

	rows := listRows(t, svc, sid)
	if len(rows) != 3 {
		t.Fatalf("reconcile not idempotent: want 3 rows, got %d: %+v", len(rows), rows)
	}
	want := []string{"thought", "tool", "agent"}
	for i, w := range want {
		if rows[i].role != w {
			t.Fatalf("row[%d].role: want %q got %q — 顺序与真实时序不符", i, w, rows[i].role)
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

// 崩溃模拟:增量 flush 发生后进程「死掉」(不收尾),DB 保留部分内容;
// 随后新 turn 重新开始(resetBuffers),旧 turn 的陈旧 flush 不得污染。
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
	end() // 模拟 runPrompt 收尾:currentTurnID 已清(reconcile 已写终态)

	// 陈旧 flush(turn 排定时器此刻才触发):不得写任何内容。
	svc.flushTurn(sid, ls, "turn-1")
	rows := listRows(t, svc, sid)
	if len(rows) != 1 || rows[0].content != "turn1部分" {
		t.Fatalf("stale flush wrote data: %+v", rows)
	}
}

// resetBuffers 清掉上一轮的防抖定时器与脏集:新 turn 的脏条目从零开始,
// 旧定时器(即使已经触发)不吞掉新 turn 的增量写。
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
	// 等 turn-1 的增量写落库(resetBuffers 会停掉 pending 定时器,须先等它完成使命)。
	waitUntil(t, func() bool {
		for _, r := range listRows(t, svc, sid) {
			if r.content == "t1" {
				return true
			}
		}
		return false
	})

	ls.resetBuffers() // turn 边界:startTurn 语义
	ls.mu.Lock()
	if ls.flushTimer != nil || ls.flushDirty != nil {
		ls.mu.Unlock()
		t.Fatal("resetBuffers must stop the pending flush timer and clear dirty set")
	}
	ls.mu.Unlock()

	// 新 turn:fallback 键与 turn-1 相同(无 messageId 场景),靠 turn_id 消歧。
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

// 并发:多 goroutine 事件流 × 防抖 flush(配 -race 验证快照持锁);收敛后 reconcile,
// 每 entry 恰一行、内容完整、无交错损坏。
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
					MessageID: "mA", // 同 key 并发累积
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
	// 让最后一次防抖 flush 落定,再收尾 reconcile。
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

// plan 快照经 UpsertTurnMessage 幂等写:重复收尾不留重复行,tool_call_id 仍钉 turn。
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
