package chat

// reconnect_test.go:harness 断连自动重连单测(AGENTS.md §3.3 / §5.1:不启真 harness)。
//
// 覆盖五条不变量(Task #21317):
//  1. 主动 spawn 重连:busy / idle 断连后后台 spawn 新 harness,session 自愈。
//  2. 指数退避:每次失败 backoff 翻倍(上限)。
//  3. 重试上限:超过 maxAttempt 不再试。
//  4. busy/idle 分支恢复:runPrompt(peer-disconnected)与 health watcher(空闲进程死)各触发。
//  5. userStopped 抑制:StopSession 干净 cancel 不触发;CloseSession 停止在跑重连 + giveUp。

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// newReconnectTestService 建一个带真实 store 的 svc,重连已启用 + 注入极短时序参数加速测试。
// spawnFn 为 nil(用例必须自行注入,否则 ensureLive 调 nil 会 panic —— 反向断言「不该 spawn」)。
func newReconnectTestService(t *testing.T) (svc *ChatService, proj *store.Project, sessionID string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc = NewChatService(config.TestConfig(t.TempDir()))
	svc.ctx = context.Background()
	svc.st = st
	proj, err = st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	sessionID = se.ID
	// 启用重连 + 极短时序(测试加速)。
	svc.reconnectEnabled = true
	svc.reconnMaxAttempt = 3
	svc.reconnInitBackoff = 5 * time.Millisecond
	svc.reconnMaxBackoff = 20 * time.Millisecond
	svc.reconnStability = 25 * time.Millisecond
	svc.spawnFn = nil
	return svc, proj, sessionID
}

// statusRecorder 线程安全地记录某 session 的全部 status payload(emit 可来自 runPrompt /
// reconnect / health watcher 多个 goroutine)。测试通过其方法读快照,避免 data race。
type statusRecorder struct {
	mu  sync.Mutex
	out []StatusPayload
}

func (r *statusRecorder) append(p StatusPayload) {
	r.mu.Lock()
	r.out = append(r.out, p)
	r.mu.Unlock()
}

func (r *statusRecorder) snapshot() []StatusPayload {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := make([]StatusPayload, len(r.out))
	copy(cp, r.out)
	return cp
}

func (r *statusRecorder) has(want string) bool {
	for _, s := range r.snapshot() {
		if s.Status == want {
			return true
		}
	}
	return false
}

func (r *statusRecorder) last() string {
	ss := r.snapshot()
	if len(ss) == 0 {
		return ""
	}
	return ss[len(ss)-1].Status
}

// captureStatuses 注入 emitHook,把 sessionID 的 status 收进 recorder(线程安全)。
func captureStatuses(svc *ChatService, sessionID string) *statusRecorder {
	r := &statusRecorder{}
	svc.emitHook = func(name string, data any) {
		if name != EventStatus {
			return
		}
		p, ok := data.(StatusPayload)
		if !ok || p.SessionID != sessionID {
			return
		}
		r.append(p)
	}
	return r
}

func waitStatus(t *testing.T, r *statusRecorder, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if r.has(want) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for status %q, got %v", want, r.snapshot())
}

// TestReconnectBusyDisconnectSuccess:busy 分支(peer-disconnected)断连后自动重连成功。
// runPrompt teardown + emitError + startReconnect → spawn 新 harness → emit "started"。
func TestReconnectBusyDisconnectSuccess(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	rec := captureStatuses(svc, sid)

	var spawnCalls int32
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		n := atomic.AddInt32(&spawnCalls, 1)
		chat := newFakeChat()
		t.Cleanup(chat.release)
		if n == 1 {
			// 首次 spawn:Prompt 立即 peer-disconnected(触发 busy 分支重连)。
			chat.promptErr = errors.New("peer disconnected before response")
		}
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		return nil
	}

	if err := svc.SendMessage(sid, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	// 等 busy 分支重连完成(spawn 第二次成功)。
	waitStatus(t, rec, statusReconnecting, 2*time.Second)
	waitSpawn2(t, &spawnCalls, 2)

	if !svc.isActive(sid) {
		t.Fatal("session should be active after successful reconnect")
	}
	if !rec.has("error") {
		t.Fatal("disconnect should emit error before reconnecting")
	}
}

// TestReconnectSpawnAlwaysFailsExhausts:spawn 永远失败 → 重试 maxAttempt 次 → giveUp + emit error。
func TestReconnectSpawnAlwaysFailsExhausts(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	rec := captureStatuses(svc, sid)

	var spawnCalls int32
	svc.spawnFn = func(*store.Session, *store.Project, string, bool) error {
		atomic.AddInt32(&spawnCalls, 1)
		return errors.New("spawn harness failed")
	}

	svc.startReconnect(sid)
	// 等重连耗尽(发 reconnectFailed error)。
	waitStatus(t, rec, statusReconnecting, 2*time.Second)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rec.last() == "error" {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}

	if got := atomic.LoadInt32(&spawnCalls); got != int32(svc.reconnMaxAttempt) {
		t.Fatalf("expected %d spawn attempts, got %d", svc.reconnMaxAttempt, got)
	}
	if rec.last() != "error" {
		t.Fatalf("exhausted reconnect should emit error, last status=%q", rec.last())
	}
	// 给定 up:giveUp 标记置位。
	svc.mu.RLock()
	givenUp := svc.reconnectGiveUp[sid]
	svc.mu.RUnlock()
	if !givenUp {
		t.Fatal("reconnect should set giveUp after exhaustion")
	}
	// giveUp 后 startReconnect 不再启动新一轮。
	atomic.StoreInt32(&spawnCalls, 0)
	svc.startReconnect(sid)
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt32(&spawnCalls); got != 0 {
		t.Fatalf("after giveUp, startReconnect must not spawn, got %d", got)
	}
}

// TestReconnectStabilityFailure:spawn 成功但 harness 在稳定观察期内死 → 算失败,继续重试。
func TestReconnectStabilityFailure(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	rec := captureStatuses(svc, sid)
	// 稳定期稍长,让 kill 有窗口落在期内。
	svc.reconnStability = 40 * time.Millisecond

	var spawnCalls int32
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		n := atomic.AddInt32(&spawnCalls, 1)
		chat := newFakeChat()
		t.Cleanup(chat.release)
		// 每次都立刻 kill:稳定期内 IsAlive=false → 算失败。
		chat.kill()
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		_ = n
		return nil
	}

	svc.startReconnect(sid)
	// 等耗尽(全部 attempt 的 spawn 都因稳定期失败)。
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		svc.mu.RLock()
		givenUp := svc.reconnectGiveUp[sid]
		svc.mu.RUnlock()
		if givenUp {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&spawnCalls); got != int32(svc.reconnMaxAttempt) {
		t.Fatalf("stability-failing spawns should retry maxAttempt=%d times, got %d", svc.reconnMaxAttempt, got)
	}
	if !rec.has(statusReconnecting) {
		t.Fatal("should have emitted reconnecting")
	}
}

// TestStopSessionDoesNotReconnect(userStopped 抑制):干净 cancel 不 teardown → 不触发重连。
func TestStopSessionDoesNotReconnect(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	rec := captureStatuses(svc, sid)

	var spawnCalls int32
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		atomic.AddInt32(&spawnCalls, 1)
		chat := newFakeChat()
		t.Cleanup(chat.release)
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		return nil
	}

	if err := svc.SendMessage(sid, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	// Prompt 在跑(busy)。等 started 后 Stop。
	waitSpawn2(t, &spawnCalls, 1)
	if err := svc.StopSession(sid); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// 等 runPrompt 收尾(emit idle/cancelled)。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rec.last() == "idle" {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if rec.last() != "idle" {
		t.Fatalf("StopSession should emit idle (cancelled), got %q", rec.last())
	}
	if rec.has(statusReconnecting) {
		t.Fatal("user stop (clean cancel) must NOT trigger reconnect")
	}
	if !svc.isActive(sid) {
		t.Fatal("session must still be active after clean cancel (harness not torn down)")
	}
	// 只 spawn 过一次,没有重连 spawn。
	if got := atomic.LoadInt32(&spawnCalls); got != 1 {
		t.Fatalf("clean cancel should not trigger extra spawn, got %d", got)
	}
}

// TestCloseSessionStopsReconnect:CloseSession 停止在跑的重连 goroutine + giveUp。
func TestCloseSessionStopsReconnect(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	// 长 backoff 让重连在等待期被 CloseSession 打断。
	svc.reconnInitBackoff = 2 * time.Second

	var spawnCalls int32
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		atomic.AddInt32(&spawnCalls, 1)
		chat := newFakeChat()
		t.Cleanup(chat.release)
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		return nil
	}

	// 先 spawn 一个,然后 kill 模拟 idle 断连,再 startReconnect(还在 backoff 等待)。
	if err := svc.ensureLive(sid); err != nil {
		t.Fatal(err)
	}
	svc.mu.RLock()
	ls := svc.active[sid]
	svc.mu.RUnlock()
	ls.chat.(*fakeChat).kill()
	svc.startReconnect(sid)
	// 确认重连在跑。
	svc.mu.RLock()
	_, reconnecting := svc.reconnects[sid]
	svc.mu.RUnlock()
	if !reconnecting {
		t.Fatal("reconnect should be running after startReconnect")
	}
	// CloseSession 应停止重连。
	if err := svc.CloseSession(sid); err != nil {
		t.Fatalf("close: %v", err)
	}
	svc.mu.RLock()
	_, reconnecting = svc.reconnects[sid]
	givenUp := svc.reconnectGiveUp[sid]
	svc.mu.RUnlock()
	if reconnecting {
		t.Fatal("CloseSession must stop the reconnect goroutine")
	}
	if !givenUp {
		t.Fatal("CloseSession must set giveUp to suppress further auto-reconnect")
	}
}

// TestHealthWatcherIdleDisconnect:health watcher 检测空闲断连 → teardown + startReconnect。
func TestHealthWatcherIdleDisconnect(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	svc.healthInterval = 10 * time.Millisecond
	svc.startHealthWatcher()
	t.Cleanup(func() {
		if svc.healthStop != nil {
			close(svc.healthStop)
			<-svc.healthDone
		}
	})
	rec := captureStatuses(svc, sid)

	var spawnCalls int32
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		n := atomic.AddInt32(&spawnCalls, 1)
		chat := newFakeChat()
		t.Cleanup(chat.release)
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		_ = n
		return nil
	}

	// 手动塞一个「已死」的 session 进 active(模拟 harness 空闲自杀)。
	deadChat := newFakeChat()
	deadChat.kill()
	svc.mu.Lock()
	svc.active[sid] = &liveSession{chat: deadChat, proj: nil, index: map[string]*turnEntry{}}
	svc.mu.Unlock()

	// health watcher 应检测到死 session → teardown + reconnect → spawn 新的。
	waitSpawn2(t, &spawnCalls, 1)
	waitStatus(t, rec, statusReconnecting, 2*time.Second)
	if !svc.isActive(sid) {
		t.Fatal("session should be re-spawned by health watcher triggered reconnect")
	}
}

// TestGiveUpClearedOnUserInteraction:giveUp 后用户发消息 → ensureLive 清 giveUp → 断连可再次自动重连。
func TestGiveUpClearedOnUserInteraction(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	rec := captureStatuses(svc, sid)

	var spawnCalls int32
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		atomic.AddInt32(&spawnCalls, 1)
		chat := newFakeChat()
		t.Cleanup(chat.release)
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		return nil
	}

	// 先手动置 giveUp(模拟重连耗尽)。
	svc.mu.Lock()
	svc.reconnectGiveUp[sid] = true
	svc.mu.Unlock()
	// startReconnect 被 giveUp 抑制。
	atomic.StoreInt32(&spawnCalls, 0)
	svc.startReconnect(sid)
	time.Sleep(30 * time.Millisecond)
	if got := atomic.LoadInt32(&spawnCalls); got != 0 {
		t.Fatalf("startReconnect with giveUp must not spawn, got %d", got)
	}
	// 用户发消息 → ensureLive 清 giveUp + spawn。
	if err := svc.SendMessage(sid, "retry", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	svc.mu.RLock()
	givenUp := svc.reconnectGiveUp[sid]
	svc.mu.RUnlock()
	if givenUp {
		t.Fatal("ensureLive (user path) must clear giveUp")
	}
	if got := atomic.LoadInt32(&spawnCalls); got != 1 {
		t.Fatalf("user send should spawn once, got %d", got)
	}
	_ = rec
}

// TestReconnectDedup:同一 session 同时只跑一个重连(startReconnect 幂等)。
func TestReconnectDedup(t *testing.T) {
	svc, _, sid := newReconnectTestService(t)
	svc.reconnInitBackoff = 200 * time.Millisecond // 长 backoff,让多次 startReconnect 重叠

	var spawnCalls int32
	svc.spawnFn = func(*store.Session, *store.Project, string, bool) error {
		atomic.AddInt32(&spawnCalls, 1)
		return errors.New("fail")
	}

	// 连续调三次 startReconnect(应在 backoff 等待期重叠)。
	svc.startReconnect(sid)
	svc.startReconnect(sid)
	svc.startReconnect(sid)
	time.Sleep(50 * time.Millisecond) // 等它们都跑过 startReconnect 检查
	svc.mu.RLock()
	n := len(svc.reconnects)
	svc.mu.RUnlock()
	if n != 1 {
		t.Fatalf("only one reconnect goroutine should run, got %d", n)
	}
}

// waitSpawn2 等到 spawn 调用计数达 n(2 表示初始 spawn + 重连 spawn,或其它语义)。
func waitSpawn2(t *testing.T, calls *int32, n int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if atomic.LoadInt32(calls) >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %d spawns, got %d", n, atomic.LoadInt32(calls))
}
