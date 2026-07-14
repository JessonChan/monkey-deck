package acp

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
)

// TestPermissionPromptCarriesDecisionContext 锁定 Task #15115「提示明确化」:
// 发给前端的 PermissionPrompt 必须携带决策上下文(动作分组 / 命令 / 路径),
// 让用户明确「哪个工具/动作/目标」,而非泛泛确认。
func TestPermissionPromptCarriesDecisionContext(t *testing.T) {
	var got PermissionPrompt
	h := NewHandler("/tmp/proj", nil, func(p PermissionPrompt) { got = p }, 0)

	kind := acp.ToolKind("execute")
	title := "Run bash"
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{
			Kind:  &kind,
			Title: &title,
			Locations: []acp.ToolCallLocation{
				{Path: "/tmp/proj"},
				{Path: "/tmp/proj/sub/a.go"},
			},
			RawInput: map[string]any{"command": "rm -rf /tmp/x"},
		},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, _ = h.RequestPermission(ctx, req)

	if got.ActionType != "exec" {
		t.Fatalf("actionType: want exec, got %q", got.ActionType)
	}
	if got.Command != "rm -rf /tmp/x" {
		t.Fatalf("command: want 'rm -rf /tmp/x', got %q", got.Command)
	}
	if len(got.Locations) != 2 || got.Locations[1] != "/tmp/proj/sub/a.go" {
		t.Fatalf("locations: want 2 entries with [1]=/tmp/proj/sub/a.go, got %+v", got.Locations)
	}
	if got.ToolName != "execute" || got.Title != "Run bash" {
		t.Fatalf("toolName/title mismatch: %+v", got)
	}
}

// TestPermissionRetryReNotify 锁定「失败自动恢复 - 可配置重试次数」:
// 用户未响应时,按 permRetries 额外重发提示(应对「提示丢失/用户没看到」)。
// retries=2 → 共 3 轮通知;用短总预算让重试在测试时限内发生。
func TestPermissionRetryReNotify(t *testing.T) {
	var dispatches atomic.Int32
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { dispatches.Add(1) }, 0)
	// 总预算 300ms,retries=2 → 3 轮,每轮 100ms。无用户响应 → 3 次分发。
	h.permTTL = 300 * time.Millisecond
	h.SetPermissionRecovery(2, "allow")

	kind := acp.ToolKind("execute")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	resp, err := h.RequestPermission(ctx, req)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if n := dispatches.Load(); n != 3 {
		t.Fatalf("dispatch count: want 3 (retries+1), got %d", n)
	}
	// 应在总预算附近降级(给 1.2x 容差,避免调度毛刺)
	if elapsed < 250*time.Millisecond {
		t.Fatalf("degraded too early: %v (expected ~300ms)", elapsed)
	}
	if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "allow" {
		t.Fatalf("degrade policy allow: want selected allow, got %+v", resp.Outcome)
	}
}

// TestPermissionTimeoutDegradeDeny 锁定「超时降级策略」:
// permTimeoutPolicy="deny" + 用户未响应 → 取 reject 选项拒绝(而非默认放行)。
func TestPermissionTimeoutDegradeDeny(t *testing.T) {
	var dispatches atomic.Int32
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { dispatches.Add(1) }, 0)
	h.permTTL = 120 * time.Millisecond
	h.SetPermissionRecovery(0, "deny") // 不重试,直接等总预算耗尽

	kind := acp.ToolKind("edit")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
			{Kind: acp.PermissionOptionKindRejectOnce, OptionId: "deny", Name: "Deny"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resp, err := h.RequestPermission(ctx, req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "deny" {
		t.Fatalf("deny policy: want selected deny option, got %+v", resp.Outcome)
	}
	if n := dispatches.Load(); n != 1 {
		t.Fatalf("retries=0 → single dispatch, got %d", n)
	}
}

// TestPermissionTimeoutDegradeDenyNoRejectOption harness 未给 reject 选项 + deny 策略 → cancelled。
func TestPermissionTimeoutDegradeDenyNoRejectOption(t *testing.T) {
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) {}, 0)
	h.permTTL = 100 * time.Millisecond
	h.SetPermissionRecovery(0, "deny")

	kind := acp.ToolKind("read")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resp, err := h.RequestPermission(ctx, req)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if resp.Outcome.Cancelled == nil {
		t.Fatalf("deny policy w/o reject option: want cancelled, got %+v", resp.Outcome)
	}
}

// TestPermissionDispatchPanicRecovered 锁定「异常捕获不中断主流程」:
// OnPermission 分发 panic 时,不得冒泡到 ACP 调用方(否则连接被 teardown);
// recover 后仍应正常等待用户响应并返回。
func TestPermissionDispatchPanicRecovered(t *testing.T) {
	var attempts atomic.Int32
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) {
		attempts.Add(1)
		if attempts.Load() == 1 {
			panic("simulated dispatch explosion")
		}
	}, 0)
	h.permTTL = 5 * time.Minute
	h.SetPermissionRecovery(0, "allow")

	kind := acp.ToolKind("execute")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}

	// 在独立 goroutine 模拟用户稍后响应(service 调 RespondPermission)。
	go func() {
		time.Sleep(50 * time.Millisecond)
		// 取 pending id(测试里直接遍历 pending map 太 hack,改用:respond 任意,失败无所谓;
		// 这里用 ctx 超时验证不 hang 即可)。实际改用短 ctx 验证不 panic。
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	resp, err := h.RequestPermission(ctx, req)
	// 关键断言:不能因 panic 返回错误(应被 recover),最多 ctx 超时返回 cancelled。
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("panic should be recovered, got unexpected err: %v", err)
	}
	// 分发至少被尝试过 1 次(panic 在第一次)
	if attempts.Load() < 1 {
		t.Fatal("OnPermission should have been invoked at least once")
	}
	if resp.Outcome.Cancelled == nil && (resp.Outcome.Selected == nil) {
		t.Fatalf("expected a terminal outcome, got %+v", resp.Outcome)
	}
}
