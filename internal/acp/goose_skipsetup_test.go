//go:build integration

package acp

// goose skip-setup 重开验证:harness 无 session/resume 能力时,LoadChatSession 跳过 setup,
// 首条 session/prompt 由 goose get_session_agent 自动从持久化加载完整上下文(不重放、无分页问题)。
// 区别于 omp/opencode(走 resume)。实证依据见 docs/worklog/2026-07-23-goose-resume-skip-setup.md。
//
// go test -tags=integration -count=1 -run TestGooseSkipSetupReopen -v ./internal/acp/ -timeout 180s
// 需本机装好 goose 且 provider 配好(端点可达);端点过载(529)时可能失败,重试即可。

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestGooseSkipSetupReopen(t *testing.T) {
	runner := NewRunner("goose acp", nil)
	cwd := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()

	var (
		mu  sync.Mutex
		buf strings.Builder
	)
	onEvent := func(e SessionEvent) {
		if e.Kind == "agent_message_chunk" {
			mu.Lock()
			buf.WriteString(e.Text) // 累积全文(ACP 层每条 chunk 是增量,messageKey 合并发生在 chat 层)
			mu.Unlock()
		}
	}

	// 1. 建会话 + 植入一个记忆点
	cs1, err := runner.NewChatSession(ctx, cwd, onEvent, nil)
	if err != nil {
		t.Fatalf("NewChatSession: %v", err)
	}
	sid := string(cs1.SessionID)
	t.Logf("created goose session: %s", sid)
	if _, err := cs1.Prompt(ctx, "Remember the secret codeword MANGO-9988. Reply only: stored.", nil); err != nil {
		t.Fatalf("plant prompt: %v", err)
	}
	cs1.Close()
	time.Sleep(time.Second)

	// 2. 重开:goose 无 resume 能力 → LoadChatSession 走 skip-setup(不 load/resume)
	cs2, err := runner.LoadChatSession(ctx, cwd, sid, onEvent, nil)
	if err != nil {
		t.Fatalf("LoadChatSession (skip-setup): %v", err)
	}
	defer cs2.Close()
	t.Logf("reopened (skip-setup): %s", sid)

	// 3. 直接 prompt 旧 sessionId:goose 应自动加载上下文,记得密钥
	buf.Reset()
	if _, err := cs2.Prompt(ctx, "What is the secret codeword I told you? Reply with only the codeword or 'I do not know'.", nil); err != nil {
		t.Fatalf("reopen prompt: %v", err)
	}
	mu.Lock()
	got := buf.String()
	mu.Unlock()
	if !strings.Contains(got, "MANGO-9988") {
		t.Fatalf("goose skip-setup reopen LOST context: reply %q missing MANGO-9988", got)
	}
	t.Logf("OK: goose skip-setup reopened session restored context (reply: %q)", got)
}
