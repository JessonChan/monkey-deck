//go:build integration

package acp

// 诊断:同 cwd 起 3 个全新 opencode acp 并发,看是否稳定(用户指出 opencode 本支持同目录多对话)。
// 捕获每个 opencode 的 stderr,定位 60s 同时断开的真因。
// go test -tags=integration -run TestDiagConcurrentSameCwd -v ./internal/acp/ -timeout 180s

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"sync"
	"testing"
	"time"

	"github.com/coder/acp-go-sdk"
)

func TestDiagConcurrentSameCwd(t *testing.T) {
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skip("opencode not installed")
	}
	cwd := t.TempDir()
	const n = 3
	var wg sync.WaitGroup
	type res struct {
		idx     int
		ok      bool
		err     string
		stderr  string
		elapsed time.Duration
	}
	results := make([]res, n)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			start := time.Now()
			r := res{idx: idx}
			defer func() { results[idx] = r }()

			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
			defer cancel()
			// 用 --print-logs 拿 opencode 自己的日志
			cmd := exec.CommandContext(ctx, "opencode", "acp", "--print-logs", "--log-level", "DEBUG")
			cmd.Dir = cwd
			stdin, _ := cmd.StdinPipe()
			stdout, _ := cmd.StdoutPipe()
			stderrBuf := &bytes.Buffer{}
			cmd.Stderr = stderrBuf
			if err := cmd.Start(); err != nil {
				r.err = "start: " + err.Error()
				return
			}
			handler := &Handler{Log: nil, WorkDir: cwd, OnEvent: func(SessionEvent) {}, OnPermission: nil, pending: map[string]*pendingPermission{}, permTTL: 5 * time.Minute}
			conn := acp.NewClientSideConnection(handler, stdin, stdout)
			if _, err := conn.Initialize(ctx, acp.InitializeRequest{
				ProtocolVersion:    acp.ProtocolVersionNumber,
				ClientCapabilities: acp.ClientCapabilities{Fs: acp.FileSystemCapabilities{ReadTextFile: true, WriteTextFile: true}},
			}); err != nil {
				r.err = "init: " + err.Error()
				r.stderr = stderrBuf.String()
				return
			}
			sess, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: cwd, McpServers: []acp.McpServer{}})
			if err != nil {
				r.err = "newsession: " + err.Error()
				r.stderr = stderrBuf.String()
				return
			}
			_, err = conn.Prompt(ctx, acp.PromptRequest{SessionId: sess.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("读 package.json,列出 3 个关键依赖,简短回答")}})
			r.elapsed = time.Since(start)
			r.stderr = stderrBuf.String()
			if err != nil {
				r.err = "prompt: " + err.Error()
				return
			}
			r.ok = true
		}(i)
		time.Sleep(300 * time.Millisecond) // 错开 spawn,模拟 UI 依次发消息
	}
	wg.Wait()

	pass := 0
	for _, r := range results {
		if r.ok {
			pass++
			t.Logf("[%d] OK in %v", r.idx, r.elapsed)
		} else {
			t.Logf("[%d] FAIL in %v err=%s", r.idx, r.elapsed, r.err)
			tail := r.stderr
			if len(tail) > 800 {
				tail = "..." + tail[len(tail)-800:]
			}
			t.Logf("[%d] opencode stderr tail:\n%s", r.idx, tail)
		}
	}
	t.Logf("result: %d/%d ok", pass, n)
	if pass != n {
		t.Fatalf("concurrent same-cwd not stable: %d/%d", pass, n)
	}
	_ = fmt.Sprint
}
