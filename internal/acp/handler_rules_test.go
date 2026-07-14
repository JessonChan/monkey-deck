package acp

import (
	"context"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/jessonchan/monkey-deck/internal/permissions"
)

// TestRequestPermissionRuleAllowAutoAllows 复现分级规则「allow 自动放行」:
// 用户未选记忆,但规则集里有「只读 allow」→ read 工具的 RequestPermission 应直接放行、不弹窗。
func TestRequestPermissionRuleAllowAutoAllows(t *testing.T) {
	called := false
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { called = true }, 0)
	h.SetPermissionRules([]permissions.Rule{
		{ID: "r", ActionType: permissions.ActionRead, Level: permissions.LevelAllow, Enabled: true},
	})

	kind := acp.ToolKind("read")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind, Locations: []acp.ToolCallLocation{{Path: "/tmp/proj/a.go"}}},
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
		t.Fatal("规则命中 allow 时不应弹窗")
	}
	if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "allow" {
		t.Fatalf("应自动放行 allow, got %+v", resp.Outcome)
	}
}

// TestRequestPermissionRuleDenyAutoRejects 复现分级规则「deny 自动拒绝」:
// 危险命令(rm -rf)即使 harness 给了 allow 选项,也应被规则 deny 拦下、返回 reject。
func TestRequestPermissionRuleDenyAutoRejects(t *testing.T) {
	called := false
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { called = true }, 0)
	h.SetPermissionRules([]permissions.Rule{
		{ID: "deny", ActionType: permissions.ActionExec, CommandPattern: `\brm\s+-\w*r\w*f`, Level: permissions.LevelDeny, Enabled: true},
	})

	kind := acp.ToolKind("execute")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind, RawInput: map[string]any{"command": "rm -rf /tmp/x"}},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
			{Kind: acp.PermissionOptionKindRejectOnce, OptionId: "deny", Name: "Deny"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	resp, _ := h.RequestPermission(ctx, req)
	if called {
		t.Fatal("规则命中 deny 时不应弹窗")
	}
	if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "deny" {
		t.Fatalf("应自动拒绝 reject, got %+v", resp.Outcome)
	}
}

// TestRequestPermissionRuleAskStillPrompts 规则档为 ask(或无规则)时仍弹前端确认。
func TestRequestPermissionRuleAskStillPrompts(t *testing.T) {
	called := false
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { called = true }, 0)
	h.SetPermissionRules([]permissions.Rule{
		{ID: "ask", ActionType: permissions.ActionWrite, Level: permissions.LevelAsk, Enabled: true},
	})

	kind := acp.ToolKind("edit")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind, Locations: []acp.ToolCallLocation{{Path: "/tmp/proj/a.go"}}},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	resp, _ := h.RequestPermission(ctx, req)
	if !called {
		t.Fatal("ask 规则应弹窗")
	}
	if resp.Outcome.Cancelled == nil {
		t.Fatalf("无响应时应 cancelled, got %+v", resp.Outcome)
	}
}

// TestRequestPermissionMemoryBeatsRules 用户显式「允许记忆」(session/project 档)优先于规则:
// 即便有 deny 规则,记忆命中仍放行。语义:用户已对整项目/会话授权,不再二次拦截。
func TestRequestPermissionMemoryBeatsRules(t *testing.T) {
	called := false
	h := NewHandler("/tmp/proj", nil, func(PermissionPrompt) { called = true }, 0)
	h.SetProjectAllowExternal(true) // 模拟项目级记忆
	// 同时挂一条 deny-all 规则
	h.SetPermissionRules([]permissions.Rule{
		{ID: "denyall", ActionType: permissions.ActionAny, Level: permissions.LevelDeny, Enabled: true},
	})

	kind := acp.ToolKind("execute")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	resp, _ := h.RequestPermission(ctx, req)
	if called {
		t.Fatal("记忆命中时不应弹窗")
	}
	if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "allow" {
		t.Fatalf("记忆应优先于规则放行, got %+v", resp.Outcome)
	}
}
