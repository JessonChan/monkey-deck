package acp

// elicitation_test.go: 钉死 elicitation 的 schema 扁平化 + 响应转换 + 端到端 dispatch/respond。
// 覆盖 omp 实际发的两种 form(select = string+enum、confirm = boolean)+ decline/cancel 路径。

import (
	"context"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
)

// elicitFields 把 ACP ElicitationSchema 扁平化为前端字段。omp 的 select 包装成
// {type:object, properties:{value:{type:"string", enum:[...]}}, required:["value"]}。
func TestElicitFieldsParsesOmpSelect(t *testing.T) {
	schema := acp.UnstableElicitationSchema{
		Type: "object",
		Properties: map[string]any{
			"value": map[string]any{
				"type":  "string",
				"enum":  []any{"1. Review against a base branch", "2. Review uncommitted changes"},
				"title": "Review Mode",
			},
		},
		Required: []string{"value"},
	}
	fields, err := elicitFields(schema)
	if err != nil {
		t.Fatalf("elicitFields: %v", err)
	}
	if len(fields) != 1 {
		t.Fatalf("want 1 field, got %d", len(fields))
	}
	f := fields[0]
	if f.Name != "value" || f.Type != "string" {
		t.Fatalf("field = %+v, want name=value type=string", f)
	}
	if f.Title != "Review Mode" {
		t.Fatalf("title = %q", f.Title)
	}
	if !f.Required {
		t.Fatal("should be required")
	}
	if len(f.Enum) != 2 || f.Enum[0] != "1. Review against a base branch" {
		t.Fatalf("enum = %v", f.Enum)
	}
}

// omp confirm 包装成 {properties:{value:{type:"boolean"}}}。
func TestElicitFieldsParsesBoolean(t *testing.T) {
	schema := acp.UnstableElicitationSchema{
		Type: "object",
		Properties: map[string]any{
			"value": map[string]any{"type": "boolean", "description": "confirm"},
		},
		Required: []string{"value"},
	}
	fields, err := elicitFields(schema)
	if err != nil {
		t.Fatalf("elicitFields: %v", err)
	}
	if fields[0].Type != "boolean" {
		t.Fatalf("type = %q, want boolean", fields[0].Type)
	}
	if fields[0].Description != "confirm" {
		t.Fatalf("description = %q", fields[0].Description)
	}
}

// 空 properties / 非 map property 应报错(decline 兜底)。
func TestElicitFieldsRejectsInvalid(t *testing.T) {
	if _, err := elicitFields(acp.UnstableElicitationSchema{Properties: map[string]any{}}); err == nil {
		t.Fatal("empty properties should error")
	}
	if _, err := elicitFields(acp.UnstableElicitationSchema{Properties: map[string]any{"x": "not-a-map"}}); err == nil {
		t.Fatal("non-map property should error")
	}
	if _, err := elicitFields(acp.UnstableElicitationSchema{Properties: map[string]any{"x": map[string]any{}}}); err == nil {
		t.Fatal("property without type should error")
	}
}

// elicitResponseToSDK:accept 携带 content,decline/cancel 各自分支。
func TestElicitResponseToSDK(t *testing.T) {
	r := elicitResponseToSDK(ElicitationResponse{Action: "accept", Content: map[string]any{"value": "selected"}})
	if r.Accept == nil || r.Accept.Action != "accept" || r.Accept.Content["value"] != "selected" {
		t.Fatalf("accept wrong: %+v", r)
	}
	r = elicitResponseToSDK(ElicitationResponse{Action: "decline"})
	if r.Decline == nil {
		t.Fatal("decline nil")
	}
	r = elicitResponseToSDK(ElicitationResponse{Action: "cancel"})
	if r.Cancel == nil {
		t.Fatal("cancel nil")
	}
	// unknown action → cancel(安全降级)
	r = elicitResponseToSDK(ElicitationResponse{Action: "whatever"})
	if r.Cancel == nil {
		t.Fatal("unknown should default to cancel")
	}
}

// 端到端:form 请求 → dispatch prompt → 前端 RespondElicitation(accept) → SDK accept 响应。
// 钉死 dispatch/respond 闭环 + 字段名 "value" 约定。
func TestUnstableCreateElicitationFormDispatchAndRespond(t *testing.T) {
	var got ElicitationPrompt
	h := NewHandler("/tmp/proj", func(SessionEvent) {}, func(PermissionPrompt) {}, func(e ElicitationPrompt) { got = e }, 0)
	h.permTTL = 200 * time.Millisecond // 缩短,本测试不会超时(会 respond)

	// 模拟 harness 发 elicitation/create(omp select 形态)。
	req := acp.UnstableCreateElicitationRequest{
		Form: &acp.UnstableCreateElicitationForm{
			Message: "Review Mode",
			RequestedSchema: acp.UnstableElicitationSchema{
				Type: "object",
				Properties: map[string]any{
					"value": map[string]any{"type": "string", "enum": []any{"a", "b"}},
				},
				Required: []string{"value"},
			},
		},
	}

	type result struct {
		resp acp.UnstableCreateElicitationResponse
		err  error
	}
	done := make(chan result, 1)
	go func() {
		resp, err := h.UnstableCreateElicitation(context.Background(), req)
		done <- result{resp, err}
	}()

	// 等 dispatch 把 prompt 投递到 OnElicitation。
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) && got.ID == "" {
		time.Sleep(2 * time.Millisecond)
	}
	if got.ID == "" {
		t.Fatal("OnElicitation not dispatched")
	}
	if len(got.Fields) != 1 || got.Fields[0].Name != "value" {
		t.Fatalf("dispatched prompt fields wrong: %+v", got.Fields)
	}
	if got.Message != "Review Mode" {
		t.Fatalf("message = %q", got.Message)
	}

	// 前端响应 accept,选了 "a"。
	if !h.RespondElicitation(got.ID, ElicitationResponse{Action: "accept", Content: map[string]any{"value": "a"}}) {
		t.Fatal("RespondElicitation returned false")
	}

	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("CreateElicitation err: %v", r.err)
		}
		if r.resp.Accept == nil {
			t.Fatalf("want accept, got %+v", r.resp)
		}
		if r.resp.Accept.Content["value"] != "a" {
			t.Fatalf("content = %v", r.resp.Accept.Content)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timeout waiting for CreateElicitation to return after respond")
	}

	// 二次 respond 同 id 应失败(已消费)。
	if h.RespondElicitation(got.ID, ElicitationResponse{Action: "cancel"}) {
		t.Fatal("second RespondElicitation should fail (already consumed)")
	}
}

// url 模式暂不支持,返回 decline。
func TestUnstableCreateElicitationUrlDeclines(t *testing.T) {
	h := NewHandler("/tmp/proj", nil, nil, nil, 0)
	resp, err := h.UnstableCreateElicitation(context.Background(), acp.UnstableCreateElicitationRequest{
		Url: &acp.UnstableCreateElicitationUrl{Url: "https://example.com/auth", Message: "auth"},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Decline == nil {
		t.Fatal("url mode should decline")
	}
}

// 超时降级为 decline(不卡死连接,同 §3.4 权限超时兜底)。
func TestUnstableCreateElicitationTimeoutDeclines(t *testing.T) {
	h := NewHandler("/tmp/proj", nil, nil, nil, 0)
	h.permTTL = 50 * time.Millisecond // 立即超时(无 OnElicitation,无 respond)
	start := time.Now()
	resp, err := h.UnstableCreateElicitation(context.Background(), acp.UnstableCreateElicitationRequest{
		Form: &acp.UnstableCreateElicitationForm{
			Message: "x",
			RequestedSchema: acp.UnstableElicitationSchema{
				Properties: map[string]any{"value": map[string]any{"type": "string"}},
			},
		},
	})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Decline == nil {
		t.Fatal("timeout should degrade to decline")
	}
	if elapsed < 40*time.Millisecond {
		t.Fatalf("returned too fast (%v), should wait ~permTTL", elapsed)
	}
}
