//go:build integration

package acp

// 集成测试:启动真 opencode,验证完整 ACP 生命周期(AGENTS.md §5.1)。
// CI 默认跳过(build tag),本地手动跑:go test -tags=integration -run TestIntegration -v ./internal/acp/ -timeout 120s

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestIntegrationChatSession(t *testing.T) {
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skip("opencode not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()

	runner := NewRunner("opencode acp", nil, "zai/glm-4.6")
	tmp := t.TempDir()

	var agentText strings.Builder
	onEvent := func(e SessionEvent) {
		if e.Kind == "agent_message_chunk" {
			agentText.WriteString(e.Text)
		}
	}

	cs, err := runner.NewChatSession(ctx, tmp, onEvent, nil)
	if err != nil {
		t.Fatalf("NewChatSession: %v", err)
	}
	defer cs.Close()

	t.Logf("session created: %s, cwd=%s", cs.SessionID, tmp)

	stopReason, err := cs.Prompt(ctx, "用一句话简短地打个招呼", 90*time.Second)
	if err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	t.Logf("stopReason=%s agentText=%q", stopReason, agentText.String())

	if agentText.Len() == 0 {
		t.Fatalf("agent produced no message text (possible model/§3.5 issue)")
	}
	t.Logf("OK: received %d chars of agent text", agentText.Len())
}
