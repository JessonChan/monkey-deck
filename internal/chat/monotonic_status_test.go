package chat

import (
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
)

// 回归(§5.4 #10):omp async task 的 onUpdate 在 tool_execution_end 之后到达,
// 经 acp-event-mapper 硬编码 status=in_progress,会把已 completed 的 tool 状态打回。
// 修复:handleEvent 做单调状态保护——终态后 update 只更新 rawOutput,不回退 status。
func TestToolStatusMonotonicNoRegression(t *testing.T) {
	svc, sessionID, _ := newTestService(t)
	ls := svc.active[sessionID]

	const id = "call_test_mono"

	// ① tool_call: in_progress
	svc.handleEvent(ls, sessionID, acp.SessionEvent{
		Kind: "tool_call", ToolCallID: id, ToolStatus: "in_progress",
		ToolTitle: "Test", ToolKind: "read",
	})
	if ls.tools[id].Status != "in_progress" {
		t.Fatalf("after start: status=%q, want in_progress", ls.tools[id].Status)
	}

	// ② tool_call_update: completed (终态)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{
		Kind: "tool_call_update", ToolCallID: id, ToolStatus: "completed",
		RawOutput: map[string]any{"text": "done"},
	})
	if ls.tools[id].Status != "completed" {
		t.Fatalf("after completed: status=%q, want completed", ls.tools[id].Status)
	}

	// ③ tool_call_update: in_progress (迟到的 onUpdate——必须被忽略)
	svc.handleEvent(ls, sessionID, acp.SessionEvent{
		Kind: "tool_call_update", ToolCallID: id, ToolStatus: "in_progress",
		RawOutput: map[string]any{"text": "stale partial"},
	})
	if ls.tools[id].Status != "completed" {
		t.Fatalf("late in_progress should not regress: status=%q, want completed", ls.tools[id].Status)
	}

	// rawOutput 仍应被更新(非状态字段不受保护)
	if ls.tools[id].RawOutput == nil {
		t.Fatal("rawOutput should still be updated after status lock")
	}
}
