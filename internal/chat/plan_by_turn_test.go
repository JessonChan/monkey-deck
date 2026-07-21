package chat

// plan_by_turn_test.go:回归「plan 不按 turn 保留历史」(Task #21295)。
//
// 旧实现:plan 是 session 级实时状态,turn 结束即丢、不入消息流、不持久化。重开会话无法
// 回看每轮 plan。
//
// 新实现(本测试覆盖):
//   - handleEvent 收到 plan 事件时,事件携带 turnId(= 当前 turn 的 user message ID),
//     同时快照存进 ls.currentPlan。
//   - persistTurnPlan 在 turn 收尾把 ls.currentPlan 落库为 role='plan' message,
//     tool_call_id 列存 turnID,使前端能按 turn 索引。
//   - 空 entries 不落库(无 plan 的 turn 不留痕)。
//
// 探针结论(协议无 turnId,client 生成):见 docs/worklog/2026-07-22-plan-history-by-turn.md。

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

// TestPlanEventTaggedWithTurnID:plan 事件应携带当前 turn 的 turnID(= user message ID)。
// 没有活跃 turn 时 turnID 为空(防御性,handleEvent 不应 panic)。
func TestPlanEventTaggedWithTurnID(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// 模拟 startTurn 已设置 turnID(绕过 AppendMessage / runPrompt,聚焦 handleEvent 行为)。
	const fakeTurnID = "user-msg-123"
	ls.mu.Lock()
	ls.currentTurnID = fakeTurnID
	ls.mu.Unlock()

	var emitted acp.SessionEvent
	svc.emitHook = func(_ string, data any) {
		if e, ok := data.(acp.SessionEvent); ok && e.Kind == "plan" {
			emitted = e
		}
	}

	svc.handleEvent(ls, sessionID, acp.SessionEvent{
		Kind: "plan",
		PlanEntries: []acp.PlanEntry{
			{Content: "step1", Status: "pending"},
			{Content: "step2", Status: "in_progress"},
		},
	})

	if emitted.TurnID != fakeTurnID {
		t.Fatalf("plan event TurnID: want %q, got %q", fakeTurnID, emitted.TurnID)
	}
	ls.mu.Lock()
	planSnapshot := ls.currentPlan
	ls.mu.Unlock()
	if len(planSnapshot) != 2 || planSnapshot[0].Content != "step1" {
		t.Fatalf("ls.currentPlan not snapshotted: %+v", planSnapshot)
	}
}

// TestPersistTurnPlanWritesRolePlanMessage:turn 收尾 persistTurnPlan 把 plan 快照写库,
// role='plan'、tool_call_id=turnID。空 entries 不写。
func TestPersistTurnPlanWritesRolePlanMessage(t *testing.T) {
	svc, sessionID, _ := newTestService(t)

	turnID := "user-msg-abc"
	entries := []acp.PlanEntry{
		{Content: "do A", Priority: "high", Status: "completed"},
		{Content: "do B", Status: "in_progress"},
	}
	svc.persistTurnPlan(sessionID, turnID, entries)

	msgs, err := svc.st.ListMessages(svc.ctx, sessionID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	var planMsgs []struct{ role, kind, toolCallID, content string }
	for _, m := range msgs {
		if m.Role == "plan" {
			planMsgs = append(planMsgs, struct{ role, kind, toolCallID, content string }{m.Role, m.Kind, m.ToolCallID, m.Content})
		}
	}
	if len(planMsgs) != 1 {
		t.Fatalf("plan messages: want 1, got %d", len(planMsgs))
	}
	if planMsgs[0].toolCallID != turnID {
		t.Fatalf("plan toolCallID(=turnID): want %q, got %q", turnID, planMsgs[0].toolCallID)
	}
	// content 应可反序列化为 []PlanEntry。
	var got []acp.PlanEntry
	if err := json.Unmarshal([]byte(planMsgs[0].content), &got); err != nil {
		t.Fatalf("plan content not JSON []PlanEntry: %v (content=%s)", err, planMsgs[0].content)
	}
	if len(got) != 2 || got[0].Content != "do A" || string(got[0].Priority) != "high" || string(got[0].Status) != "completed" {
		t.Fatalf("plan entries mismatch: %+v", got)
	}

	// 空 entries 不写第二条。
	before := len(planMsgs)
	svc.persistTurnPlan(sessionID, "user-msg-2", nil)
	msgs2, _ := svc.st.ListMessages(svc.ctx, sessionID)
	after := 0
	for _, m := range msgs2 {
		if m.Role == "plan" {
			after++
		}
	}
	if after != before {
		t.Fatalf("empty entries should not persist: before=%d after=%d", before, after)
	}
}

// TestRunPromptPersistsPlanOnFinalize:end-to-end(经 fakeChat):startTurn 设 turnID →
// handleEvent 收 plan → runPrompt 收尾把 plan 落库。验证 DB role='plan' 行存在且 tool_call_id
// 与 user message ID 一致。
func TestRunPromptPersistsPlanOnFinalize(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	ls := svc.active[sessionID]

	// emitHook:Prompt 期间模拟 agent 发一条消息(避免空 turn 检测)+ 一条 plan 事件。
	fc.emitHook = func(_ string) {
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "ok", MessageID: "m1"})
		svc.handleEvent(ls, sessionID, acp.SessionEvent{
			Kind: "plan",
			PlanEntries: []acp.PlanEntry{
				{Content: "step1", Status: "completed"},
				{Content: "step2", Status: "in_progress"},
			},
		})
	}

	if err := svc.SendMessage(sessionID, "do it", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	fc.release()

	// 等 runPrompt 收尾(plan 落库)。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		msgs, _ := svc.st.ListMessages(context.Background(), sessionID)
		done := false
		for _, m := range msgs {
			if m.Role == "plan" {
				done = true
				break
			}
		}
		if done {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	msgs, _ := svc.st.ListMessages(svc.ctx, sessionID)
	var userMsgID string
	var planMsgs int
	for _, m := range msgs {
		if m.Role == "user" {
			userMsgID = m.ID
		}
		if m.Role == "plan" {
			planMsgs++
		}
	}
	if planMsgs != 1 {
		t.Fatalf("plan messages after turn: want 1, got %d", planMsgs)
	}
	if userMsgID == "" {
		t.Fatal("no user message in DB")
	}
	// plan 的 tool_call_id 应 = user message ID(= turnID)。
	for _, m := range msgs {
		if m.Role == "plan" && m.ToolCallID != userMsgID {
			t.Fatalf("plan toolCallID: want user msg id %q, got %q", userMsgID, m.ToolCallID)
		}
	}
}
