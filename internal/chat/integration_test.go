//go:build integration

package chat

// 集成测试:验证 ChatService(GUI 调用的同一后端路径)能完成一次真实 opencode 对话。
// go test -tags=integration -run TestIntegrationService -v ./internal/chat/ -timeout 120s

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

func TestIntegrationServiceConversation(t *testing.T) {
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skip("opencode not installed")
	}
	dir := t.TempDir()
	cfg := &config.Config{DataDir: dir, DBPath: filepath.Join(dir, "t.db"), HarnessCmd: "opencode acp", DefaultModel: "zai/glm-4.6"}

	svc := NewChatService(cfg)
	svc.ctx = context.Background()
	// 手动 open store(绕过 ServiceStartup,它依赖 application.Get())。
	st, err := store.New(cfg.DBPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	svc.st = st

	// 项目目录用一个临时子目录(cwd 锚点)。
	projDir := filepath.Join(dir, "myproject")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	proj, err := svc.AddProject("myproject", projDir, "zai/glm-4.6")
	if err != nil {
		t.Fatalf("AddProject: %v", err)
	}
	if err := svc.UpdateProject(proj.ID, "myproject", "zai/glm-4.6"); err != nil {
		t.Fatal(err)
	}

	sess, err := svc.CreateSession(proj.ID, "integration")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	t.Logf("session created: %s (acp=%s)", sess.ID, sess.ACPSession)
	t.Cleanup(func() { svc.CloseSession(sess.ID) })

	if err := svc.SendMessage(sess.ID, "用一句话简短地打个招呼", nil); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	// 轮询,等 agent 消息落库(Prompt 在后台 goroutine)。
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		msgs, err := svc.LoadMessages(sess.ID)
		if err != nil {
			t.Fatalf("LoadMessages: %v", err)
		}
		for _, m := range msgs {
			if m.Role == "agent" && len(m.Content) > 0 {
				t.Logf("agent replied: %q", m.Content)
				t.Logf("OK: conversation completed through ChatService")
				return
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for agent reply")
}
