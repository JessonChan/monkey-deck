//go:build integration

package acp

// Diagnoses the resume path: NewSession → Close → session/resume → Prompt.
// Locates whether wave-2's 60s disconnect is caused by session/resume.
// go test -tags=integration -count=1 -run TestDiagResume -v ./internal/acp/ -timeout 120s

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDiagResume(t *testing.T) {
	runner := NewRunner("opencode acp --print-logs --log-level DEBUG", nil)
	cwd := t.TempDir()
	ctx := context.Background()

	// 1. 新建 + 一轮对话,拿到 acp session id
	cs1, err := runner.NewChatSession(ctx, cwd, nil, func(SessionEvent) {}, nil, nil)
	if err != nil {
		t.Fatalf("NewChatSession: %v", err)
	}
	sid := string(cs1.SessionID)
	t.Logf("created session: %s", sid)
	if _, err := cs1.Prompt(ctx, "只回复:hi", nil); err != nil {
		t.Fatalf("first prompt: %v", err)
	}
	cs1.Close()
	t.Logf("closed; now resume via session/resume")

	// 2. resume → 再问一个会读文件的问题(cwd 空,用简单问题)
	time.Sleep(time.Second)
	cs2, err := runner.ResumeChatSession(ctx, cwd, sid, nil, func(SessionEvent) {}, nil, nil)
	if err != nil {
		t.Fatalf("ResumeChatSession: %v", err)
	}
	defer cs2.Close()
	t.Logf("resumed session: %s", sid)

	// 3. resumed 后连发两轮(测 resume 后是否稳定)
	for i := 1; i <= 2; i++ {
		if _, err := cs2.Prompt(ctx, "只回复:ok"+strings.Repeat("!", i), nil); err != nil {
			t.Fatalf("resume prompt #%d failed: %v", i, err)
		}
		t.Logf("resume prompt #%d ok", i)
	}
	t.Logf("OK: resume path stable")
}
