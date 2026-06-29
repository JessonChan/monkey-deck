package acp

import (
	"testing"
	"time"
)

// 方案 A 回归:tool 处于 in_progress 时豁免静默超时(协议级「正在工作」信号,
// ToolCallStatus.in_progress);tool 进入终态后恢复超时判定。
// 修掉「长 tool 期间无 chunk 流入 → 被误判卡死 → 误触发 idle timeout」。
func TestActivityTrackerInProgressExemptsTimeout(t *testing.T) {
	a := newActivityTracker()
	stale := func() { a.lastActivity.Store(time.Now().Add(-10 * time.Minute).UnixNano()) }

	stale()
	if !a.timedOut(time.Second) {
		t.Fatal("应超时:无 tool 且已静默")
	}

	// tool 进入 in_progress → 即便静默也不超时
	a.observe(SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolStatus: "in_progress"})
	stale() // observe 会刷新时间,压回过去模拟长静默
	if a.timedOut(time.Second) {
		t.Fatal("不应超时:有 in_progress tool")
	}

	// tool 完成 → 恢复超时
	a.observe(SessionEvent{Kind: "tool_call_update", ToolCallID: "t1", ToolStatus: "completed"})
	stale()
	if !a.timedOut(time.Second) {
		t.Fatal("应超时:tool 已完成且静默")
	}
}

// in_progress 计数随状态转换正确增减:多 tool 并发、failed 终态、重复事件幂等。
func TestActivityTrackerInProgressCounting(t *testing.T) {
	a := newActivityTracker()
	stale := func() { a.lastActivity.Store(time.Now().Add(-time.Hour).UnixNano()) }

	a.observe(SessionEvent{Kind: "tool_call", ToolCallID: "a", ToolStatus: "in_progress"})
	a.observe(SessionEvent{Kind: "tool_call", ToolCallID: "b", ToolStatus: "in_progress"})
	stale()
	if a.timedOut(time.Second) {
		t.Fatal("2 个 in_progress 不应超时")
	}
	if got := a.inProgress.Load(); got != 2 {
		t.Fatalf("inProgress = %d, want 2", got)
	}

	// 一个 failed → 计数 -1,仍剩 1 个 in_progress
	a.observe(SessionEvent{Kind: "tool_call_update", ToolCallID: "a", ToolStatus: "failed"})
	stale()
	if a.timedOut(time.Second) {
		t.Fatal("1 个 in_progress 不应超时")
	}

	// 重复发同一 in_progress 状态不计重复(幂等)
	a.observe(SessionEvent{Kind: "tool_call_update", ToolCallID: "b", ToolStatus: "in_progress"})
	a.observe(SessionEvent{Kind: "tool_call_update", ToolCallID: "b", ToolStatus: "in_progress"})
	if got := a.inProgress.Load(); got != 1 {
		t.Fatalf("重复 in_progress 不应叠加,inProgress = %d, want 1", got)
	}

	// 全部完成 → 计数归零、恢复超时
	a.observe(SessionEvent{Kind: "tool_call_update", ToolCallID: "b", ToolStatus: "completed"})
	stale()
	if !a.timedOut(time.Second) {
		t.Fatal("全部完成后应超时")
	}
	if got := a.inProgress.Load(); got != 0 {
		t.Fatalf("inProgress = %d, want 0", got)
	}
}

// 非 tool 事件 / 缺字段事件只刷新活动时间,不污染 in_progress 计数。
func TestActivityTrackerIgnoresIrrelevantEvents(t *testing.T) {
	a := newActivityTracker()
	a.observe(SessionEvent{Kind: "agent_message_chunk", Text: "hi"})
	a.observe(SessionEvent{Kind: "tool_call", ToolCallID: "", ToolStatus: "in_progress"}) // 缺 ID
	a.observe(SessionEvent{Kind: "tool_call", ToolCallID: "x", ToolStatus: ""})           // 缺 status
	a.observe(SessionEvent{Kind: "usage_update"})
	a.observe(SessionEvent{Kind: "plan"})
	if got := a.inProgress.Load(); got != 0 {
		t.Fatalf("无关事件不应改变 inProgress, got %d", got)
	}
}
