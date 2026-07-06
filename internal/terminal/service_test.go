package terminal

import (
	"encoding/base64"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// pty 仅 Unix(creack/pty Windows 返回 ErrUnsupported),Windows 直接跳过。
func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("pty not supported on windows")
	}
}

// waitForExit 轮询直到 id 从 sessions 移除(readLoop 收口)。
func waitForExit(s *TerminalService, id string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.get(id) == nil {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func TestStartAndKill(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	defer s.killAll()

	id, err := s.Start("sess-a", "", 80, 24)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if id == "" || s.get(id) == nil {
		t.Fatal("terminal not registered after Start")
	}
	if err := s.Kill(id); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if s.get(id) != nil {
		t.Fatal("terminal still in map after Kill")
	}
}

func TestKillSessionTerminals(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	defer s.killAll()

	a1, _ := s.Start("sess-a", "", 80, 24)
	a2, _ := s.Start("sess-a", "", 80, 24)
	b1, _ := s.Start("sess-b", "", 80, 24)

	s.KillSessionTerminals("sess-a")

	if s.get(a1) != nil || s.get(a2) != nil {
		t.Fatal("session A terminals not killed")
	}
	if s.get(b1) == nil {
		t.Fatal("session B terminal should survive")
	}
}

func TestServiceShutdownKillsAll(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	if _, err := s.Start("s1", "", 80, 24); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := s.Start("s2", "", 80, 24); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := s.ServiceShutdown(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	s.mu.RLock()
	n := len(s.sessions)
	s.mu.RUnlock()
	if n != 0 {
		t.Fatalf("expected 0 sessions after shutdown, got %d", n)
	}
}

// TestStaleOpsNoPanic 终端已 kill 后,前端延迟到达的 Write/Resize 必须静默 nil 不 panic。
func TestStaleOpsNoPanic(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	defer s.killAll()

	id, _ := s.Start("sess-a", "", 80, 24)
	_ = s.Kill(id)

	if err := s.Write(id, "ls -la"); err != nil {
		t.Fatalf("Write after kill: %v", err)
	}
	if err := s.Resize(id, 120, 40); err != nil {
		t.Fatalf("Resize after kill: %v", err)
	}
}

// TestWriteEchoesData 集成:Write → PTY → shell 回显 → readLoop → terminal:data 事件。
// 验证整条数据通路(用真 PTY + 普通 shell,非 harness,§5.1)。
func TestWriteEchoesData(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	defer s.killAll()

	const marker = "hello_terminal_marker_xyz"
	var mu sync.Mutex
	var got bool
	s.emitHook = func(name string, data any) {
		if name != EventData {
			return
		}
		dp, ok := data.(DataPayload)
		if !ok {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(dp.Data)
		if err != nil {
			return
		}
		mu.Lock()
		if strings.Contains(string(raw), marker) {
			got = true
		}
		mu.Unlock()
	}

	id, err := s.Start("sess-a", t.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// 让 shell 起来,再发 echo。
	time.Sleep(150 * time.Millisecond)
	if err := s.Write(id, "echo "+marker+"\n"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := got
		mu.Unlock()
		if done {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("did not receive echoed marker in terminal:data events")
}
