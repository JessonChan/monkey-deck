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

// TestShouldCancelTurnAbsoluteBeatsInProgress 治本核心:harness 在 in_progress tool
// 中途死亡时,tool 永不到终态 → 旧 timedOut 因 in_progress 豁免返回 false → 永不取消 →
// turn 永久挂起(§5.4 #16)。新 shouldCancelTurn 在绝对上限命中时返回 "absolute",
// 压过 in_progress 豁免,保证 turn 一定能被取消、runPrompt 能返回去拆连接。
func TestShouldCancelTurnAbsoluteBeatsInProgress(t *testing.T) {
	a := newActivityTracker()
	start := time.Now().Add(-16 * time.Minute) // 超过 15min 绝对上限
	now := start.Add(16 * time.Minute)
	a.observe(SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolStatus: "in_progress"})
	a.lastActivity.Store(start.UnixNano()) // 长期静默
	if got := a.shouldCancelTurn(start, now, 5*time.Minute, 15*time.Minute); got != "absolute" {
		t.Fatalf("绝对上限应压过 in_progress 豁免:got %q, want absolute", got)
	}
}

// TestShouldCancelTurnInProgressExemptWithinAbsolute:in_progress 且未到绝对上限时不取消
// (长 tool 正常进行,§3.3 不误判卡死)。回归保护:绝对上限不能误杀正常长 tool。
func TestShouldCancelTurnInProgressExemptWithinAbsolute(t *testing.T) {
	a := newActivityTracker()
	start := time.Now().Add(-1 * time.Minute) // 远未到绝对上限
	now := start.Add(1 * time.Minute)
	a.observe(SessionEvent{Kind: "tool_call", ToolCallID: "t1", ToolStatus: "in_progress"})
	a.lastActivity.Store(start.Add(-10 * time.Minute).UnixNano()) // 静默超 idle 阈值
	if got := a.shouldCancelTurn(start, now, 5*time.Minute, 15*time.Minute); got != "" {
		t.Fatalf("in_progress 且未到绝对上限不应取消:got %q, want \"\"", got)
	}
}

// TestShouldCancelTurnIdleNoTool:无 in_progress tool 且静默超 idle 阈值 → "idle"。
func TestShouldCancelTurnIdleNoTool(t *testing.T) {
	a := newActivityTracker()
	start := time.Now().Add(-1 * time.Minute)
	now := start.Add(1 * time.Minute)
	a.lastActivity.Store(start.Add(-10 * time.Minute).UnixNano()) // 静默,无 tool
	if got := a.shouldCancelTurn(start, now, 5*time.Minute, 15*time.Minute); got != "idle" {
		t.Fatalf("无 tool 且静默应 idle 超时:got %q, want idle", got)
	}
}

// TestShouldCancelTurnRecentActive:近期有活动且未到绝对上限 → 不取消。
func TestShouldCancelTurnRecentActive(t *testing.T) {
	a := newActivityTracker()
	start := time.Now().Add(-30 * time.Second)
	now := start.Add(30 * time.Second)
	a.lastActivity.Store(now.Add(-2 * time.Second).UnixNano()) // 近期有活动
	if got := a.shouldCancelTurn(start, now, 5*time.Minute, 15*time.Minute); got != "" {
		t.Fatalf("近期活动且未到绝对上限不应取消:got %q, want \"\"", got)
	}
}
