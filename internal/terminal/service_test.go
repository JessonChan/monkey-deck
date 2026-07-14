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

// TestListTerminalsBySession 验证后端查询接口反映活跃终端的真实分布
// (侧栏图标的权威数据源,§5.3 尊重数据源)。
func TestListTerminalsBySession(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	defer s.killAll()

	a1, _ := s.Start("sess-a", "", 80, 24)
	_, _ = s.Start("sess-a", "", 80, 24) // 同 session 第二个终端
	_, _ = s.Start("sess-b", "", 80, 24)

	got := s.ListTerminalsBySession()
	if !got["sess-a"] || !got["sess-b"] {
		t.Fatalf("expected sess-a and sess-b present, got %v", got)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got))
	}

	_ = s.Kill(a1)
	// sess-a 还有另一个终端,仍应存在
	got = s.ListTerminalsBySession()
	if !got["sess-a"] {
		t.Fatal("sess-a should still have a terminal")
	}
}

// TestEmitStateOnStartAndKill 验证 Start/Kill 都推 terminal:state 事件,
// 且 HasTerminal 反映该 session 是否仍有终端(图标对账依据)。
func TestEmitStateOnStartAndKill(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	defer s.killAll()

	var mu sync.Mutex
	var states []StatePayload
	s.emitHook = func(name string, data any) {
		if name != EventState {
			return
		}
		mu.Lock()
		states = append(states, data.(StatePayload))
		mu.Unlock()
	}

	// Start → 应推 hasTerminal=true
	id, _ := s.Start("sess-a", "", 80, 24)
	if !waitForState(&mu, &states, "sess-a", true, time.Second) {
		t.Fatal("expected state sess-a=true after Start")
	}

	// Kill → 应推 hasTerminal=false(归零)
	_ = s.Kill(id)
	if !waitForState(&mu, &states, "sess-a", false, time.Second) {
		t.Fatal("expected state sess-a=false after Kill")
	}
}

// TestEmitStateKeepsTrueWhenSiblingAlive 同 session 多终端,杀一个不应误报归零。
func TestEmitStateKeepsTrueWhenSiblingAlive(t *testing.T) {
	skipOnWindows(t)
	s := NewTerminalService()
	defer s.killAll()

	var mu sync.Mutex
	var badFalse bool
	s.emitHook = func(name string, data any) {
		if name != EventState {
			return
		}
		sp := data.(StatePayload)
		if sp.SessionID == "sess-a" && !sp.HasTerminal {
			mu.Lock()
			badFalse = true
			mu.Unlock()
		}
	}

	a1, _ := s.Start("sess-a", "", 80, 24)
	a2, _ := s.Start("sess-a", "", 80, 24)
	_ = s.Kill(a1)
	// 等待可能的误报窗口
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	bad := badFalse
	mu.Unlock()
	if bad {
		t.Fatal("must not emit sess-a=false while a2 still alive")
	}
	_ = a2
}

// waitForState 轮询 states 直到出现匹配 sessionId/hasTerminal 的条目。
func waitForState(mu *sync.Mutex, states *[]StatePayload, sessionID string, has bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		mu.Lock()
		for _, sp := range *states {
			if sp.SessionID == sessionID && sp.HasTerminal == has {
				mu.Unlock()
				return true
			}
		}
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	return false
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
