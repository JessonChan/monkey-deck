//go:build integration

package acp

// 诊断 resume 路径:NewSession → Close → LoadSession(resume) → Prompt。
// 定位 wave-2 的 60s 断开是否由 LoadSession 引起。
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
	cs1, err := runner.NewChatSession(ctx, cwd, func(SessionEvent) {}, nil)
	if err != nil {
		t.Fatalf("NewChatSession: %v", err)
	}
	sid := string(cs1.SessionID)
	t.Logf("created session: %s", sid)
	if _, err := cs1.Prompt(ctx, "只回复:hi", nil, 60*time.Second); err != nil {
		t.Fatalf("first prompt: %v", err)
	}
	cs1.Close()
	t.Logf("closed; now resume via LoadSession")

	// 2. resume → 再问一个会读文件的问题(cwd 空,用简单问题)
	time.Sleep(time.Second)
	cs2, err := runner.LoadChatSession(ctx, cwd, sid, func(SessionEvent) {}, nil)
	if err != nil {
		t.Fatalf("LoadChatSession: %v", err)
	}
	defer cs2.Close()
	t.Logf("resumed session: %s", sid)

	// 3. resumed 后连发两轮(测 resume 后是否稳定)
	for i := 1; i <= 2; i++ {
		if _, err := cs2.Prompt(ctx, "只回复:ok"+strings.Repeat("!", i), nil, 60*time.Second); err != nil {
			t.Fatalf("resume prompt #%d failed: %v", i, err)
		}
		t.Logf("resume prompt #%d ok", i)
	}
	t.Logf("OK: resume path stable")
}
