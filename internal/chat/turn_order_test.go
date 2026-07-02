package chat

// turn_order_test.go:回归「重开会话后工具全堆到 turn 末尾」bug(AGENTS.md §5.4 #12)。
//
// 根因:旧 persistTurn 先写完所有 segment,再写所有 tool —— DB seq 丢失了
// thought→tool→agent→tool 的真实时序,重开加载历史时工具卡片全聚到 turn 末尾。
// 修复:统一时序队列 items(segment / tool 按真实发生顺序),persistTurn 按 items 序写库。
//
// 本测试同时验证:
//   - items 的 kind 序列与事件到达顺序一致(交错)。
//   - tool_call_update 就地改 tool 字段,**不动其在 items 里的位置**(§5.4 #10/#11 协同)。
//   - persistTurn 按 items 顺序写库(messages 表 seq 升序 = 真实时序)。

import (
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

func TestTurnItemsInterleaveToolsInOrder(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// 真实交错序列:thought → tool1 → agent → tool2 → agent
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "先想"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "看完了"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T2", ToolTitle: "edit", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "改好了"})

	ls.mu.Lock()
	items := ls.finalizeTurnItems()
	ls.mu.Unlock()

	// 期望时序:thought, tool(T1), agent, tool(T2), agent —— 工具不堆到末尾。
	wantKinds := []string{"segment", "tool", "segment", "tool", "segment"}
	if len(items) != len(wantKinds) {
		t.Fatalf("items count: want %d, got %d: %+v", len(wantKinds), len(items), items)
	}
	for i, k := range wantKinds {
		if items[i].kind != k {
			t.Fatalf("item[%d].kind: want %q, got %q — 工具未按真实位置交错(全堆末尾 bug)", i, k, items[i].kind)
		}
	}
	// 校验段角色顺序:thought, agent, agent
	wantRoles := []string{"thought", "agent", "agent"}
	ri := 0
	for _, it := range items {
		if it.kind == "segment" {
			if it.seg.role != wantRoles[ri] {
				t.Fatalf("segment role[%d]: want %q, got %q", ri, wantRoles[ri], it.seg.role)
			}
			ri++
		}
	}
}

func TestToolCallUpdateDoesNotMovePosition(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "前"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "run", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "后"})
	// tool_call_update 到达:T1 完成并补 rawOutput(omp async onUpdate,§5.4 #10)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "T1", ToolStatus: "completed", RawOutput: "done"})

	ls.mu.Lock()
	items := ls.finalizeTurnItems()
	ls.mu.Unlock()

	// 期望:agent(前), tool(T1), agent(后) —— update 不应把 tool 移到末尾,也不应新建 tool 项。
	if len(items) != 3 || items[1].kind != "tool" {
		t.Fatalf("items shape wrong: %+v", items)
	}
	toolItem := items[1].tool
	if toolItem.ID != "T1" || toolItem.Status != "completed" || toolItem.RawOutput != "done" {
		t.Fatalf("tool not updated in place: %+v", toolItem)
	}
	// 确认只有 1 个 tool 项(update 没新建)
	toolCount := 0
	for _, it := range items {
		if it.kind == "tool" {
			toolCount++
		}
	}
	if toolCount != 1 {
		t.Fatalf("tool item count: want 1, got %d — update 新建了多余 tool 项", toolCount)
	}
}

func TestPersistTurnWritesItemsInOrder(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "想"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "答"})

	ls.mu.Lock()
	items := ls.finalizeTurnItems()
	ls.mu.Unlock()
	svc.persistTurn(sessionID, items)

	msgs, err := svc.st.ListMessages(svc.ctx, sessionID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	// thought → tool → agent(交错,工具不堆末尾)。
	var turn []string
	for _, m := range msgs {
		if m.Role != "user" {
			turn = append(turn, m.Role)
		}
	}
	wantRoles := []string{"thought", "tool", "agent"}
	if len(turn) != len(wantRoles) {
		t.Fatalf("turn message count: want %d, got %d: %v", len(wantRoles), len(turn), turn)
	}
	for i, w := range wantRoles {
		if turn[i] != w {
			t.Fatalf("turn msg[%d].role: want %q, got %q — 持久化顺序与真实时序不符(工具堆末尾 bug)", i, w, turn[i])
		}
	}
}
