//go:build integration

package acp

// 定位 opencode 多轮后 "peer disconnected before response" 的真因。
// 1 个 session,--print-logs,循环提问,断开时 dump opencode stderr。
// go test -tags=integration -count=1 -run TestDiagDisconnectReason -v ./internal/acp/ -timeout 600s

import (
	"bytes"
	"context"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
)

func TestDiagDisconnectReason(t *testing.T) {
	cwd := t.TempDir()
	qs := []string{
		"wesight 是什么?列出全部 agent 引擎。",
		"是 Electron 吗?主进程/渲染进程如何分工?",
		"支持哪些模型供应商?配置方式?",
		"数据持久化用什么?存哪?",
		"前端状态管理用什么库?",
	}
	stderrBuf := &bytes.Buffer{}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Second)
	defer cancel()

	cmd, stdin, stdout := spawnWithLogs(t, ctx, cwd, stderrBuf)
	defer cmd.Process.Kill()
	handler := &Handler{WorkDir: cwd, OnEvent: func(SessionEvent) {}, pending: map[string]*pendingPermission{}, permTTL: 5 * time.Minute}
	conn := acp.NewClientSideConnection(handler, stdin, stdout)
	if _, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: acp.ProtocolVersionNumber, ClientCapabilities: acp.ClientCapabilities{Fs: acp.FileSystemCapabilities{ReadTextFile: true, WriteTextFile: true}}}); err != nil {
		t.Fatalf("init: %v", err)
	}
	sess, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: cwd, McpServers: []acp.McpServer{}})
	if err != nil {
		t.Fatalf("newsession: %v", err)
	}
	t.Logf("session: %s", sess.SessionId)

	for i, q := range qs {
		t.Logf(">>> Q%d: %s", i+1, q)
		_, err := conn.Prompt(ctx, acp.PromptRequest{SessionId: sess.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock(q)}})
		if err != nil {
			t.Logf("<<< Q%d FAILED: %v", i+1, err)
			s := stderrBuf.String()
			if len(s) > 2000 {
				s = s[len(s)-2000:]
			}
			t.Logf("=== opencode stderr tail ===\n%s", strings.TrimSpace(s))
			return
		}
		t.Logf("<<< Q%d OK", i+1)
	}
	t.Logf("all %d questions answered, no disconnect", len(qs))
}

func spawnWithLogs(t *testing.T, ctx context.Context, cwd string, stderr *bytes.Buffer) (*exec.Cmd, io.WriteCloser, io.ReadCloser) {
	t.Helper()
	cmd := exec.CommandContext(ctx, "opencode", "acp", "--print-logs", "--log-level", "DEBUG")
	cmd.Dir = cwd
	cmd.Stderr = stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start opencode: %v", err)
	}
	return cmd, stdin, stdout
}
