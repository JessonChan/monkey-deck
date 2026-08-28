package acp

// elicitation_test.go: 钉死 elicitation 的 schema 扁平化 + 响应转换 + 端到端 dispatch/respond。
// 覆盖 omp 实际发的两种 form(select = string+enum、confirm = boolean)+ decline/cancel 路径。

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
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
	promptCh := make(chan ElicitationPrompt, 1)
	h := NewHandler("/tmp/proj", func(SessionEvent) {}, func(PermissionPrompt) {}, func(e ElicitationPrompt) { promptCh <- e }, 0)
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

	// Wait for dispatch to deliver the prompt via OnElicitation. Use a channel (not a busy-wait on
	// a shared var) to avoid a data race with the callback goroutine.
	var got ElicitationPrompt
	select {
	case got = <-promptCh:
	case <-time.After(500 * time.Millisecond):
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

// ctx 取消(如 StopSession / session 关闭)中断等待中的 elicitation:
// 返 Cancel + 清空 pendingElicit + 触发 OnElicitationResolved(让前端清残留卡片)。
// 锁死 teardown 不泄漏、不残留卡片的契约(review nit:此前该路径无测试保护)。
func TestUnstableCreateElicitationCtxCancel(t *testing.T) {
	resolved := make(chan string, 1)
	h := NewHandler("/tmp/proj", nil, nil, nil, 0)
	h.permTTL = 5 * time.Minute // 长 TTL,确保是 ctx 取消而非超时触发
	h.OnElicitationResolved = func(id string) { resolved <- id }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		resp, _ := h.UnstableCreateElicitation(ctx, acp.UnstableCreateElicitationRequest{
			Form: &acp.UnstableCreateElicitationForm{
				Message: "x",
				RequestedSchema: acp.UnstableElicitationSchema{
					Properties: map[string]any{"value": map[string]any{"type": "string"}},
				},
			},
		})
		// ctx 取消应命中 ctx.Done() 分支 → 返 Cancel。
		if resp.Cancel == nil {
			t.Errorf("ctx cancel should return Cancel, got %+v", resp)
		}
		close(done)
	}()

	// 等 dispatch(OnElicitation 在测试环境为 nil,但 pendingElicit 已注册)。
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("CreateElicitation did not return after ctx cancel")
	}
	// pendingElicit 应已清空(防 goroutine 泄漏 + 残留响应通道)。
	h.mu.Lock()
	leak := len(h.pendingElicit)
	h.mu.Unlock()
	if leak != 0 {
		t.Fatalf("pendingElicit should be empty after ctx cancel, got %d", leak)
	}
	// OnElicitationResolved 应被触发(让前端清残留卡片)。
	select {
	case id := <-resolved:
		if id == "" {
			t.Fatal("resolved id should be non-empty")
		}
	case <-time.After(time.Second):
		t.Fatal("OnElicitationResolved not triggered after ctx cancel")
	}
	// 取消后对该 id 的 RespondElicitation 应失败(已被 ctx 路径清掉)。
	if h.RespondElicitation("any-id-after-cancel", ElicitationResponse{Action: "accept"}) {
		t.Fatal("RespondElicitation should fail after ctx cancel (entry removed)")
	}
}

// #158 shape (a): a map without "type" but with a non-empty enum synthesizes a
// string select; every option survives (non-string items fmt.Sprint-ed, not
// dropped) so the select stays answerable.
func TestElicitFieldsEnumOnlyMapSynthesizesSelect(t *testing.T) {
	schema := acp.UnstableElicitationSchema{
		Properties: map[string]any{
			"mode": map[string]any{
				"title": "Mode",
				"enum":  []any{"fast", "ulw", 3},
			},
		},
		Required: []string{"mode"},
	}
	fields, err := elicitFields(schema)
	if err != nil {
		t.Fatalf("elicitFields: %v", err)
	}
	if len(fields) != 1 {
		t.Fatalf("want 1 field, got %d: %+v", len(fields), fields)
	}
	f := fields[0]
	if f.Name != "mode" || f.Type != "string" {
		t.Fatalf("field = %+v, want name=mode type=string (synthesized select)", f)
	}
	want := []string{"fast", "ulw", "3"}
	if len(f.Enum) != len(want) {
		t.Fatalf("enum = %v, want %v (all options must survive)", f.Enum, want)
	}
	for i := range want {
		if f.Enum[i] != want[i] {
			t.Fatalf("enum[%d] = %q, want %q", i, f.Enum[i], want[i])
		}
	}
	if f.Title != "Mode" {
		t.Fatalf("title = %q, want Mode", f.Title)
	}
	if !f.Required {
		t.Fatal("should be required")
	}
}

// #158 shape (b): the property itself is a bare option array — synthesize a
// string select named after the property key, every option fmt.Sprint-ed to a
// string (numbers/booleans included).
func TestElicitFieldsBareArraySynthesizesSelect(t *testing.T) {
	schema := acp.UnstableElicitationSchema{
		Properties: map[string]any{
			"choice": []any{"alpha", 42, true},
		},
	}
	fields, err := elicitFields(schema)
	if err != nil {
		t.Fatalf("elicitFields: %v", err)
	}
	if len(fields) != 1 {
		t.Fatalf("want 1 field, got %d: %+v", len(fields), fields)
	}
	f := fields[0]
	if f.Name != "choice" || f.Type != "string" {
		t.Fatalf("field = %+v, want name=choice type=string (synthesized select)", f)
	}
	want := []string{"alpha", "42", "true"}
	if len(f.Enum) != len(want) {
		t.Fatalf("enum = %v, want %v", f.Enum, want)
	}
	for i := range want {
		if f.Enum[i] != want[i] {
			t.Fatalf("enum[%d] = %q, want %q (non-string items must be fmt.Sprint-ed)", i, f.Enum[i], want[i])
		}
	}
}

// #158: shapes that cannot render (empty enum, bare scalar, null) stay
// unrenderable — each alone drives fields==0 and thus the visible-decline path.
func TestElicitFieldsUnrenderableShapes(t *testing.T) {
	cases := map[string]any{
		"empty_enum":  map[string]any{"enum": []any{}},
		"bare_scalar": "just a string",
		"null":        nil,
	}
	for name, prop := range cases {
		schema := acp.UnstableElicitationSchema{Properties: map[string]any{"x": prop}}
		if _, err := elicitFields(schema); err == nil {
			t.Fatalf("%s: want error (no renderable fields), got nil", name)
		}
	}
}

// #158 / G-2: the schema dump must truncate — small schemas verbatim, oversized
// ones cut at the limit with a visible marker (never a full-schema log flood).
func TestSchemaDumpTruncates(t *testing.T) {
	if got := schemaDump(map[string]any{"a": "b"}, schemaDumpLimit); got != `{"a":"b"}` {
		t.Fatalf("small schema should marshal verbatim, got %q", got)
	}
	big := map[string]any{"blob": strings.Repeat("y", 4*schemaDumpLimit)}
	got := schemaDump(big, schemaDumpLimit)
	if len(got) > schemaDumpLimit+16 {
		t.Fatalf("dump = %d bytes, want <= %d (+marker)", len(got), schemaDumpLimit)
	}
	if !strings.HasSuffix(got, "(truncated)") {
		t.Fatalf("oversized dump must carry the truncation marker, got tail %q", got[max(0, len(got)-20):])
	}
}

// #158 fields==0 end to end: the callback response stays Decline (the harness
// degrades gracefully), the service notice callback fires (the frontend shows
// why no form appeared), and the warn log's schema dump stays bounded (G-2:
// no full-schema flood).
func TestUnstableCreateElicitationUnrenderableDeclinesWithNotice(t *testing.T) {
	noticed := make(chan struct{}, 1)
	h := NewHandler("/tmp/proj", nil, nil, nil, 0)
	h.OnElicitationUnrenderable = func() { noticed <- struct{}{} }

	// Capture the default slog logger to assert the dump truncation.
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer slog.SetDefault(prev)

	// One unrenderable 8KB prop (bare scalar): fields==0, and the marshaled
	// schema far exceeds the 2KB dump limit.
	schema := acp.UnstableElicitationSchema{
		Properties: map[string]any{
			"junk": strings.Repeat("x", 8192),
		},
	}
	resp, err := h.UnstableCreateElicitation(context.Background(), acp.UnstableCreateElicitationRequest{
		Form: &acp.UnstableCreateElicitationForm{
			Mode:            "form",
			Message:         "unrenderable",
			RequestedSchema: schema,
		},
	})
	if err != nil {
		t.Fatalf("UnstableCreateElicitation: %v", err)
	}
	if resp.Decline == nil {
		t.Fatalf("want Decline response, got %+v", resp)
	}
	select {
	case <-noticed:
	case <-time.After(time.Second):
		t.Fatal("OnElicitationUnrenderable not invoked (frontend notice would never show)")
	}

	logs := buf.String()
	if !strings.Contains(logs, "(truncated)") {
		t.Fatalf("oversized schema must be logged truncated, logs = %s", logs)
	}
	if len(logs) > schemaDumpLimit+512 {
		t.Fatalf("warn output = %d bytes, dump must stay bounded near the %d limit", len(logs), schemaDumpLimit)
	}
}
