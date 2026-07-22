package acp

import (
	"context"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/jessonchan/monkey-deck/internal/permissions"
)

// TestRequestPermissionGlobalEmitsExactMatchRule 锁定 onRespond("global") 后端语义(§3.4):
// 用户选「全局允许」→ handler 放行本次请求(返回 allow 选项)、把当前请求固化成的
// 「准确匹配」allow 规则经 OnGlobalRule 交 service 持久化,并写满 session/project 记忆
// 使后续请求即时放行、不再弹窗。
func TestRequestPermissionGlobalEmitsExactMatchRule(t *testing.T) {
	// 用 channel 传递 prompt id,避免与 RequestPermission 所在 goroutine 的数据竞争。
	promptCh := make(chan string, 4)
	var (
		gotRule  permissions.Rule
		emitted  bool
		dispatch int
	)
	h := NewHandler("/tmp/proj", nil, func(p PermissionPrompt) {
		dispatch++
		select {
		case promptCh <- p.ID:
		default:
		}
	}, 0)
	h.SetPermissionRecovery(0, "allow") // 单次分发,简化 channel 时序
	h.OnGlobalRule = func(r permissions.Rule) { gotRule = r; emitted = true }

	kind := acp.ToolKind("execute")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind, RawInput: map[string]any{"command": "git status"}},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
			{Kind: acp.PermissionOptionKindRejectOnce, OptionId: "deny", Name: "Deny"},
		},
	}

	done := make(chan acp.RequestPermissionResponse, 1)
	go func() {
		resp, _ := h.RequestPermission(context.Background(), req)
		done <- resp
	}()
	var promptID string
	select {
	case promptID = <-promptCh:
	case <-time.After(2 * time.Second):
		t.Fatal("OnPermission 未被调用(未分发提示)")
	}

	if !h.RespondPermission(promptID, "global") {
		t.Fatal("RespondPermission(\"global\") 应命中待裁决项")
	}

	var resp acp.RequestPermissionResponse
	select {
	case resp = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RequestPermission 未返回")
	}
	if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "allow" {
		t.Fatalf("global 应放行 allow 选项, got %+v", resp.Outcome)
	}

	// OnGlobalRule 在 RequestPermission 返回前同步调用,此处读已无竞争。
	if !emitted {
		t.Fatal("OnGlobalRule 未被调用")
	}
	wantRule := permissions.Rule{
		ToolName:       "execute",
		ActionType:     permissions.ActionExec,
		CommandPattern: `^git status$`,
		Level:          permissions.LevelAllow,
		Enabled:        true,
	}
	if gotRule != wantRule {
		t.Fatalf("OnGlobalRule 规则形状错误: got %+v, want %+v", gotRule, wantRule)
	}

	// 记忆已写满:后续同会话请求即时放行、不弹窗(不依赖 service 持久化的规则)。
	resp2, err := h.RequestPermission(context.Background(), req)
	if err != nil {
		t.Fatalf("后续请求 unexpected err: %v", err)
	}
	if dispatch != 1 {
		t.Fatalf("记忆命中后不应再次弹窗, dispatch=%d (want 1)", dispatch)
	}
	if resp2.Outcome.Selected == nil || resp2.Outcome.Selected.OptionId != "allow" {
		t.Fatalf("记忆命中应自动放行 allow, got %+v", resp2.Outcome)
	}
}

// TestRequestPermissionGlobalFSShapePath 验证 fs 类请求(无命令、有路径)经 onRespond("global")
// 固化出的规则带 PathPattern(首个 location 原值),与 permissions.ExactMatchRule 形状一致。
func TestRequestPermissionGlobalFSShapePath(t *testing.T) {
	promptCh := make(chan string, 4)
	var (
		gotRule permissions.Rule
		emitted bool
	)
	h := NewHandler("/tmp/proj", nil, func(p PermissionPrompt) {
		select {
		case promptCh <- p.ID:
		default:
		}
	}, 0)
	h.SetPermissionRecovery(0, "allow")
	h.OnGlobalRule = func(r permissions.Rule) { gotRule = r; emitted = true }

	kind := acp.ToolKind("edit")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind, Locations: []acp.ToolCallLocation{{Path: "/foo/bar.go"}}},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	done := make(chan struct{})
	go func() {
		_, _ = h.RequestPermission(context.Background(), req)
		close(done)
	}()
	var promptID string
	select {
	case promptID = <-promptCh:
	case <-time.After(2 * time.Second):
		t.Fatal("OnPermission 未被调用")
	}

	if !h.RespondPermission(promptID, "global") {
		t.Fatal("RespondPermission(\"global\") 应命中待裁决项")
	}
	<-done

	if !emitted {
		t.Fatal("OnGlobalRule 未被调用")
	}
	wantRule := permissions.Rule{
		ToolName:    "edit",
		ActionType:  permissions.ActionWrite,
		PathPattern: "/foo/bar.go",
		Level:       permissions.LevelAllow,
		Enabled:     true,
	}
	if gotRule != wantRule {
		t.Fatalf("fs 规则形状错误: got %+v, want %+v", gotRule, wantRule)
	}
}

// TestRequestPermissionGlobalNoCallbackStillAllows OnGlobalRule 为 nil(handler 单测默认)时,
// onRespond("global") 仍应放行本次请求 + 写记忆;不持久化规则但不影响当前裁决(降级安全)。
func TestRequestPermissionGlobalNoCallbackStillAllows(t *testing.T) {
	promptCh := make(chan string, 4)
	h := NewHandler("/tmp/proj", nil, func(p PermissionPrompt) {
		select {
		case promptCh <- p.ID:
		default:
		}
	}, 0)
	h.SetPermissionRecovery(0, "allow")
	// OnGlobalRule 不设(nil)

	kind := acp.ToolKind("execute")
	req := acp.RequestPermissionRequest{
		ToolCall: acp.ToolCallUpdate{Kind: &kind},
		Options: []acp.PermissionOption{
			{Kind: acp.PermissionOptionKindAllowOnce, OptionId: "allow", Name: "Allow"},
		},
	}
	done := make(chan acp.RequestPermissionResponse, 1)
	go func() {
		resp, _ := h.RequestPermission(context.Background(), req)
		done <- resp
	}()
	var promptID string
	select {
	case promptID = <-promptCh:
	case <-time.After(2 * time.Second):
		t.Fatal("OnPermission 未被调用")
	}

	if !h.RespondPermission(promptID, "global") {
		t.Fatal("RespondPermission(\"global\") 应命中待裁决项")
	}
	select {
	case resp := <-done:
		if resp.Outcome.Selected == nil || resp.Outcome.Selected.OptionId != "allow" {
			t.Fatalf("global(nil callback) 仍应放行 allow, got %+v", resp.Outcome)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RequestPermission 未返回")
	}
}
