package acp

import (
	"context"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
)

// TestRequestPermissionMemoryAutoAllowsAllRequestTypes 复现并锁定 §5.4 实证 bug:
// omp 这类 harness 对「命令执行」也发 request_permission,其 ToolCall.Locations 多在 cwd
// 内或为空 → isExternalAccess=false。用户已选 allow 档(session/project)记忆已写入,
// 但旧实现 RequestPermission 用 `external && (sessionAllow||projectAllow)` 作闸门 →
// external=false 时记忆分支永不命中 → 每次仍弹窗(「确认过了还要确认」)。
// 修复:去掉 external 闸门,记忆命中即对所有 RequestPermission(含命令执行)自动放行。
// project 档按 project 存、不分 harness → 跨 harness 共享(满足「一个 harness 确认过,
// 其他 harness 也允许」)。
//
// 验证手法:用带超时的 ctx。修复前走弹窗分支会阻塞到 ctx 取消(返回 Cancelled → 断言失败);
// 修复后记忆命中立即返回 allow(断言通过)。从而确定性复现 bug 且不 hang。
func TestRequestPermissionMemoryAutoAllowsAllRequestTypes(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *Handler)
	}{
		{"session记忆", func(h *Handler) { h.sessionAllowExternal.Store(true) }},
		{"project记忆跨harness", func(h *Handler) { h.SetProjectAllowExternal(true) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			called := false
			h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { called = true }, 0)
			c.setup(h)

			kind := acp.ToolKind("bash") // 命令执行;Locations 空 → isExternalAccess=false
			req := acp.RequestPermissionRequest{
				ToolCall: acp.ToolCallUpdate{Kind: &kind},
				Options: []acp.PermissionOption{
					{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
					{Kind: acp.PermissionOptionKindRejectOnce, OptionId: "deny", Name: "Deny"},
				},
			}
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer cancel()
			resp, err := h.RequestPermission(ctx, req)
			if err != nil && err != context.DeadlineExceeded {
				t.Fatalf("unexpected err: %v", err)
			}
			if called {
				t.Fatal("记忆命中时不应弹窗(OnPermission 不应被调)")
			}
			if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "allow" {
				t.Fatalf("%s:应自动放行 allow 选项, got %+v", c.name, resp.Outcome)
			}
		})
	}
}

// TestRequestPermissionNoMemoryStillPrompts 回归保护:用户未选 allow 档(无记忆)时,
// 命令执行请求仍必须弹窗等用户裁决——不能因「记忆覆盖所有请求类型」的修复而无脑放行。
// 用带超时的 ctx:弹窗分支等不到响应 → ctx 取消返回 Cancelled,同时 OnPermission 应被调。
func TestRequestPermissionNoMemoryStillPrompts(t *testing.T) {
	called := false
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { called = true }, 0)

	kind := acp.ToolKind("bash")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	resp, _ := h.RequestPermission(ctx, req)
	if !called {
		t.Fatal("无记忆时应弹窗(OnPermission 应被调)")
	}
	if resp.Outcome.Cancelled == nil {
		t.Fatalf("无响应时应 cancelled, got %+v", resp.Outcome)
	}
}
