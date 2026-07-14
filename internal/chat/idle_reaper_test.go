package chat

// idle_reaper_test.go:B 方案 idle reaper 单测(AGENTS.md §5.1:不启真 harness)。
//
// 注入 mockChatConn(满足 chatConn)+ 直接往 active 塞 liveSession,测 closeIdle 的三类行为:
//  1. 超 idleTimeout 且非 busy → 关闭(进程 Close + 移出 active);
//  2. busy(turn 进行中)→ 跳过(不杀进行中的 turn);
//  3. 未超时 → 跳过。
// 另测 startIdleReaper 后台 goroutine 能优雅停(ServiceShutdown 路径)。

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// mockChatConn 满足 chatConn,仅记录 Close 调用(其余返零值,本测试不用)。
type mockChatConn struct {
	closed atomic.Bool
}

func (m *mockChatConn) Prompt(ctx context.Context, message string, attachments []acp.Attachment) (acp.StopReason, error) {
	return "", nil
}
func (m *mockChatConn) Close()                                       { m.closed.Store(true) }
func (m *mockChatConn) IsAlive() bool                                { return !m.closed.Load() }
func (m *mockChatConn) RespondPermission(id, optionID string) bool   { return false }
func (m *mockChatConn) SessionTitle(ctx context.Context) (string, error) { return "", nil }
func (m *mockChatConn) FlatConfigOptions() []acp.ConfigOption         { return nil }
func (m *mockChatConn) SupportsImage() bool                           { return false }
func (m *mockChatConn) SetConfigOption(ctx context.Context, configId, value string) error { return nil }
func (m *mockChatConn) RefreshConfig(ctx context.Context) ([]acp.ConfigOption, error) {
	return nil, nil
}

// newIdleTestService 建一个不启 harness 的 svc,注入短 idleTimeout。
func newIdleTestService(t *testing.T, idleTimeout time.Duration) *ChatService {
	t.Helper()
	st, err := store.New("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewChatService(config.TestConfig(t.TempDir()))
	svc.ctx = context.Background()
	svc.st = st
	svc.idleTimeout = idleTimeout
	return svc
}

// addMockLive 往 active 塞一个 mock liveSession,返回它便于断言。
func addMockLive(svc *ChatService, id string, lastActivity int64, busy bool) *liveSession {
	ls := &liveSession{chat: &mockChatConn{}, lastActivity: lastActivity, busy: busy}
	svc.mu.Lock()
	svc.active[id] = ls
	svc.mu.Unlock()
	return ls
}

// closeIdle 关闭超 idleTimeout 且非 busy 的活跃 session。
func TestCloseIdleExpiresIdleSession(t *testing.T) {
	svc := newIdleTestService(t, 200*time.Millisecond)
	mc := &mockChatConn{}
	ls := &liveSession{chat: mc, lastActivity: time.Now().Add(-1 * time.Hour).UnixMilli()} // 1 小时前 → 远超时
	svc.mu.Lock()
	svc.active["s1"] = ls
	svc.mu.Unlock()

	svc.closeIdle()

	if len(svc.active) != 0 {
		t.Fatalf("idle session should be removed from active, still has %d", len(svc.active))
	}
	if !mc.closed.Load() {
		t.Fatal("idle session harness should be closed")
	}
}

// busy(turn 进行中)的 session 不被 idle reaper 杀。
func TestCloseIdleSkipsBusySession(t *testing.T) {
	svc := newIdleTestService(t, 200*time.Millisecond)
	ls := addMockLive(svc, "s1", time.Now().Add(-1*time.Hour).UnixMilli(), true) // 超时但 busy

	svc.closeIdle()

	if len(svc.active) != 1 {
		t.Fatalf("busy session must NOT be closed, active=%d", len(svc.active))
	}
	mc := ls.chat.(*mockChatConn)
	if mc.closed.Load() {
		t.Fatal("busy session harness must NOT be closed")
	}
}

// 未超时的 session 不被关。
func TestCloseIdleSkipsRecentSession(t *testing.T) {
	svc := newIdleTestService(t, 10*time.Minute) // 长 timeout
	addMockLive(svc, "s1", time.Now().UnixMilli(), false) // 刚活动

	svc.closeIdle()

	if len(svc.active) != 1 {
		t.Fatalf("recent session must NOT be closed, active=%d", len(svc.active))
	}
}

// lastActivity 更新后,原本超时的 session 不再被关(模拟 turn 结束重置计时)。
func TestCloseIdleActivityResetsTimer(t *testing.T) {
	svc := newIdleTestService(t, 200*time.Millisecond)
	ls := addMockLive(svc, "s1", time.Now().Add(-1*time.Hour).UnixMilli(), false) // 初始超时

	// 模拟 turn 结束更新 lastActivity(同 runPrompt finalize)。
	ls.mu.Lock()
	ls.lastActivity = time.Now().UnixMilli()
	ls.mu.Unlock()

	svc.closeIdle()

	if len(svc.active) != 1 {
		t.Fatalf("session with fresh activity must NOT be closed, active=%d", len(svc.active))
	}
}

// startIdleReaper 后台 goroutine 能在 idleTimeout 后自动回收,且 reaperStop 优雅停。
func TestIdleReaperGoroutineRecyclesAndStops(t *testing.T) {
	svc := newIdleTestService(t, 100*time.Millisecond)
	mc := &mockChatConn{}
	ls := &liveSession{chat: mc, lastActivity: time.Now().Add(-1 * time.Hour).UnixMilli()}
	svc.mu.Lock()
	svc.active["s1"] = ls
	svc.mu.Unlock()

	svc.startIdleReaper()
	defer func() {
		close(svc.reaperStop)
		<-svc.reaperDone
	}()

	// 等后台 ticker 扫描(scan 间隔 = 100ms/5 = 20ms,几轮内必命中)。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		svc.mu.RLock()
		n := len(svc.active)
		svc.mu.RUnlock()
		if n == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if len(svc.active) != 0 {
		t.Fatalf("reaper goroutine should have closed idle session, active=%d", len(svc.active))
	}
	if !mc.closed.Load() {
		t.Fatal("reaper goroutine should have closed harness")
	}
}

// 并发安全冒烟:多 goroutine 同时调 closeIdle 不 panic(active map 并发读写)。
func TestCloseIdleConcurrentSafe(t *testing.T) {
	svc := newIdleTestService(t, 10*time.Minute)
	for i := 0; i < 5; i++ {
		addMockLive(svc, "s"+string(rune('0'+i)), time.Now().UnixMilli(), false)
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			svc.closeIdle()
		}()
	}
	wg.Wait()
}

// RefreshSessionConfig 对非活跃 session 必须返回错误(不 panic、不调 RefreshConfig)。
func TestRefreshSessionConfigNotActive(t *testing.T) {
	svc := newIdleTestService(t, 10*time.Minute)
	_, err := svc.RefreshSessionConfig("nope")
	if err == nil {
		t.Fatal("expected error for inactive session")
	}
}

// RefreshSessionConfig 对活跃 session(mockChatConn.RefreshConfig 返回 nil,nil)
// 成功返回 + emit 一条 config_option event(无 Wails3 app 时 emit 静默,不 panic)。
func TestRefreshSessionConfigActiveEmitsConfigOption(t *testing.T) {
	svc := newIdleTestService(t, 10*time.Minute)
	addMockLive(svc, "s1", time.Now().UnixMilli(), false)

	var emitted []string
	var emittedPayloads []any
	svc.emitHook = func(name string, data any) {
		emitted = append(emitted, name)
		emittedPayloads = append(emittedPayloads, data)
	}

	flat, err := svc.RefreshSessionConfig("s1")
	if err != nil {
		t.Fatalf("expected success on active session, got %v", err)
	}
	if flat != nil {
		t.Fatalf("mockChatConn returns nil config options, got %v", flat)
	}
	if len(emitted) != 1 || emitted[0] != EventUpdate {
		t.Fatalf("expected one %s event, got %v", EventUpdate, emitted)
	}
	ev, ok := emittedPayloads[0].(acp.SessionEvent)
	if !ok {
		t.Fatalf("expected SessionEvent payload, got %T", emittedPayloads[0])
	}
	if ev.Kind != "config_option" {
		t.Fatalf("expected config_option kind, got %q", ev.Kind)
	}
}
