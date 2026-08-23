package chat

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// errChatConn overrides SetConfigOption to return a canned error (rest delegates to mockChatConn).
type errChatConn struct {
	mockChatConn
	setErr error
}

func (m *errChatConn) SetConfigOption(ctx context.Context, configId, value string) error {
	return m.setErr
}

// SetSessionConfigOption maps the harness's -32602 "model not found" rejection to a
// human-readable error that tells the user how to recover (close & reopen the session),
// instead of leaking raw JSON-RPC text (§4.4). No silent auto-respawn: switching is a
// user action, recovery stays user-driven.
func TestSetSessionConfigOptionModelNotFoundFriendlyError(t *testing.T) {
	svc := newIdleTestService(t, time.Minute)
	addMockLive(svc, "s1", time.Now().UnixMilli(), false)
	svc.mu.RLock()
	ls := svc.active["s1"]
	svc.mu.RUnlock()
	ls.chat = &errChatConn{setErr: errors.New(
		`{"code":-32602,"message":"Invalid params: model not found: opencode/x-preview-f-free","data":{"modelId":"opencode/x-preview-f-free","providerId":"opencode"}}`)}

	err := svc.SetSessionConfigOption("s1", "model", "opencode/x-preview-f-free")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	msg := err.Error()
	if !strings.Contains(msg, "opencode/x-preview-f-free") {
		t.Fatalf("friendly error should name the model, got %q", msg)
	}
	if !strings.Contains(msg, "重新打开") {
		t.Fatalf("friendly error should tell the user how to recover, got %q", msg)
	}
	if strings.Contains(msg, "-32602") || strings.Contains(msg, "Invalid params") {
		t.Fatalf("raw protocol error must not leak to the user, got %q", msg)
	}
}

// Non "model not found" failures must pass through untouched (no over-mapping).
func TestSetSessionConfigOptionOtherErrorPassthrough(t *testing.T) {
	svc := newIdleTestService(t, time.Minute)
	addMockLive(svc, "s1", time.Now().UnixMilli(), false)
	svc.mu.RLock()
	ls := svc.active["s1"]
	svc.mu.RUnlock()
	raw := errors.New("peer disconnected")
	ls.chat = &errChatConn{setErr: raw}

	err := svc.SetSessionConfigOption("s1", "model", "zai/glm-4.6")
	if !errors.Is(err, raw) {
		t.Fatalf("unrelated error should pass through unchanged, got %v", err)
	}
}

func TestIsModelNotFoundErr(t *testing.T) {
	yes := []string{
		`{"code":-32602,"message":"Invalid params: model not found: opencode/x-preview-f-free"}`,
		"model not found: zai/glm-4.6",
	}
	for _, s := range yes {
		if !isModelNotFoundErr(errors.New(s)) {
			t.Errorf("should match %q", s)
		}
	}
	no := []string{
		`{"code":-32602,"message":"Invalid params: session not found: ses_x"}`,
		"",
	}
	for _, s := range no {
		if isModelNotFoundErr(errors.New(s)) {
			t.Errorf("should not match %q", s)
		}
	}
	if isModelNotFoundErr(nil) {
		t.Error("nil should not match")
	}
}
