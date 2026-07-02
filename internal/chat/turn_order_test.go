package chat

// turn_order_test.go:回归「重开会话后工具全堆到 turn 末尾」bug(AGENTS.md §5.4 #12)。
//
// 根因(已根除):旧 persistTurn 先写完所有 segment 再写所有 tool → DB seq 丢失真实时序。
// 现模型:单一 timeline(message/tool 按真实发生顺序),persistTurn 按 timeline 序写库。
//
// 本测试验证(timeline 重构后):
//   - timeline 的 kind 序列与事件到达顺序一致(thought→tool→agent→tool→agent 交错)。
//   - tool_call_update 就地改 tool 字段,**不动 timeline 位置**(§5.4 #10/#11 协同)。
//   - persistTurn 按 timeline 顺序写库(messages 表 seq 升序 = 真实时序)。

import (
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

func TestTimelineInterleaveToolsInOrder(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// 真实交错序列:thought → tool1 → agent → tool2 → agent(各有不同 messageId)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "先想", MessageID: "m1"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "看完了", MessageID: "m2"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T2", ToolTitle: "edit", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "改好了", MessageID: "m3"})

	ls.mu.Lock()
	timeline := ls.timeline
	ls.mu.Unlock()

	// 期望时序:message(thought), tool(T1), message(agent), tool(T2), message(agent) —— 工具不堆末尾。
	wantKinds := []string{"message", "tool", "message", "tool", "message"}
	if len(timeline) != len(wantKinds) {
		t.Fatalf("timeline len: want %d, got %d", len(wantKinds), len(timeline))
	}
	for i, k := range wantKinds {
		if timeline[i].kind != k {
			t.Fatalf("timeline[%d].kind: want %q, got %q (工具堆末尾 bug)", i, k, timeline[i].kind)
		}
	}
	// 段角色顺序:thought, agent, agent
	wantRoles := []string{"thought", "agent", "agent"}
	ri := 0
	for _, e := range timeline {
		if e.kind == "message" {
			if e.role != wantRoles[ri] {
				t.Fatalf("message role[%d]: want %q, got %q", ri, wantRoles[ri], e.role)
			}
			ri++
		}
	}
}

func TestToolCallUpdateDoesNotMovePosition(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "前", MessageID: "m1"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "run", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "后", MessageID: "m2"})
	// tool_call_update 到达:T1 完成并补 rawOutput(omp async onUpdate,§5.4 #10)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "T1", ToolStatus: "completed", RawOutput: "done"})

	ls.mu.Lock()
	timeline := ls.timeline
	ls.mu.Unlock()

	// 期望:message(前), tool(T1), message(后) —— update 不移位、不新建。
	if len(timeline) != 3 || timeline[1].kind != "tool" {
		t.Fatalf("timeline shape wrong: %+v", timeline)
	}
	tool := timeline[1].tool
	if tool.ID != "T1" || tool.Status != "completed" || tool.RawOutput != "done" {
		t.Fatalf("tool not updated in place: %+v", tool)
	}
	// 确认只有 1 个 tool entry(update 没新建)
	toolCount := 0
	for _, e := range timeline {
		if e.kind == "tool" {
			toolCount++
		}
	}
	if toolCount != 1 {
		t.Fatalf("tool entry count: want 1, got %d — update 新建了多余 tool 项", toolCount)
	}
}

func TestPersistTurnWritesItemsInOrder(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_thought_chunk", Text: "想", MessageID: "m1"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "read"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "答", MessageID: "m2"})

	ls.mu.Lock()
	timeline := ls.finalizeTurn()
	ls.mu.Unlock()
	svc.persistTurn(sessionID, timeline)

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

// 回归(§5.4 #11):同 messageId 的 agent chunk 即使被 tool_call_update 穿插,
// 仍归并到同一条 message entry(tool_call_update 按 toolCallId 只命中 tool,碰不到 message)。
func TestMessageIdMergeSurvivesToolUpdateInterleave(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	// agent 文本流(messageId=mA)被 tool_call_update 穿插(omp async onUpdate)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "这个问题", MessageID: "mA"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call", ToolCallID: "T1", ToolTitle: "run", ToolStatus: "in_progress"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "T1", ToolStatus: "running"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: " 这个问题值得我", MessageID: "mA"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "tool_call_update", ToolCallID: "T1", ToolStatus: "completed", RawOutput: "done"})
	svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: " 这个问题值得我认真", MessageID: "mA"})

	ls.mu.Lock()
	segs := ls.segmentEntries()
	ls.mu.Unlock()

	// 关键:agent 文本应在同一条 entry 累积(不被 update 拆成累积前缀的多条)。
	agentSegs := 0
	for _, s := range segs {
		if s.role == "agent" {
			agentSegs++
			if s.content != "这个问题 这个问题值得我 这个问题值得我认真" {
				t.Fatalf("agent text not accumulated in one entry: %q", s.content)
			}
		}
	}
	if agentSegs != 1 {
		t.Fatalf("agent segment count: want 1 (messageId 归并), got %d — message-duplication bug", agentSegs)
	}
}
