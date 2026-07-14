package chat

// lazy_spawn_test.go:懒 spawn 单测(AGENTS.md §5.1:不启真 harness)。
//
// 覆盖懒 spawn 不变量(打开历史会话不立即 spawn harness):
//  1. OpenSession 历史会话(有消息)→ 不 spawn,推 readonly 状态。
//  2. OpenSession 新建会话(无消息)→ spawn(保持原行为,§3.1 不影响新建流程)。
//  3. ContinueSession 显式触发懒 spawn。
//  4. SendMessage 在只读态触发 ensureLive → spawn 并接上。
//  5. CloseSession 只读态(未 spawn)→ no-op,不调 Close(无需回收)。
//  6. CloseSession 已 spawn → 回收(调 Close)。

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// newLazyTestService 建一个带临时 store 的 svc,spawnFn 置 nil(用例须自行注入 mock,
// 否则 ensureLive 调 nil 会 panic —— 正是「不应调 spawnFn」的反向断言)。
// 返回的 session 无消息(新建态);用例可 AppendMessage 转为历史态。
func newLazyTestService(t *testing.T) (svc *ChatService, proj *store.Project, sessionID string) {
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
	svc.spawnFn = nil
	return svc, proj, sessionID
}

// recordingSpawn 返回一个 spawnFn mock:记录调用次数 + 注入 fakeChat 进 active(模拟 startLive)。
// 返回调用计数与注入的 fakeChat,供用例断言。
func recordingSpawn(svc *ChatService, t *testing.T) (fn func(se *store.Session, proj *store.Project, acpSessionID string, resume bool) error, calls *int32, fc *fakeChat) {
	t.Helper()
	var n int32
	chat := newFakeChat()
	t.Cleanup(chat.release)
	fn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		atomic.AddInt32(&n, 1)
		ls := &liveSession{chat: chat, proj: proj, index: map[string]*turnEntry{}}
		// emitHook 让 fakeChat 产出一条消息,避免 runPrompt 空响应检测。
		chat.emitHook = func(msg string) {
			svc.handleEvent(ls, se.ID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "ok"})
		}
		svc.mu.Lock()
		svc.active[se.ID] = ls
		svc.mu.Unlock()
		svc.emitStatus(se.ID, "started", "")
		return nil
	}
	return fn, &n, chat
}

// captureStatus 注入 emitHook,记录某 session 最后一个 status,返回其指针。
func captureStatus(svc *ChatService, sessionID string) *string {
	last := ""
	svc.emitHook = func(name string, data any) {
		if name != EventStatus {
			return
		}
		p, ok := data.(StatusPayload)
		if !ok || p.SessionID != sessionID {
			return
		}
		last = p.Status
	}
	return &last
}

// waitSpawn 轮询等 spawn 计数达 n(异步 spawn 路径用)。
func waitSpawn(t *testing.T, calls *int32, n int32) {
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

// TestOpenSessionHistoricalDoesNotSpawn:历史会话(有消息)打开时不 spawn,推 readonly。
func TestOpenSessionHistoricalDoesNotSpawn(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	if _, err := svc.st.AppendMessage(svc.ctx, sid, "user", "", "hi", ""); err != nil {
		t.Fatal(err)
	}
	spawnFn, calls, _ := recordingSpawn(svc, t)
	svc.spawnFn = spawnFn
	last := captureStatus(svc, sid)

	if err := svc.OpenSession(sid); err != nil {
		t.Fatalf("OpenSession: %v", err)
	}
	if atomic.LoadInt32(calls) != 0 {
		t.Fatalf("historical session must NOT spawn, spawnFn called %d times", atomic.LoadInt32(calls))
	}
	if *last != "readonly" {
		t.Fatalf("expected readonly status, got %q", *last)
	}
	if svc.isActive(sid) {
		t.Fatal("historical session must NOT be active after lazy open")
	}
}

// TestOpenSessionNewSpawnsImmediately:新建会话(无消息)打开时立即异步 spawn(保持原行为)。
func TestOpenSessionNewSpawnsImmediately(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	spawnFn, calls, _ := recordingSpawn(svc, t)
	svc.spawnFn = spawnFn

	if err := svc.OpenSession(sid); err != nil {
		t.Fatalf("OpenSession: %v", err)
	}
	waitSpawn(t, calls, 1)
	if !svc.isActive(sid) {
		t.Fatal("new session should be active after spawn")
	}
}

// TestContinueSessionTriggersSpawn:ContinueSession 显式触发懒 spawn;已活跃则 no-op。
func TestContinueSessionTriggersSpawn(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	if _, err := svc.st.AppendMessage(svc.ctx, sid, "user", "", "hi", ""); err != nil {
		t.Fatal(err)
	}
	spawnFn, calls, _ := recordingSpawn(svc, t)
	svc.spawnFn = spawnFn

	if err := svc.OpenSession(sid); err != nil { // 只读打开
		t.Fatal(err)
	}
	if atomic.LoadInt32(calls) != 0 {
		t.Fatalf("lazy open should not spawn, got %d", atomic.LoadInt32(calls))
	}
	if err := svc.ContinueSession(sid); err != nil {
		t.Fatalf("ContinueSession: %v", err)
	}
	if atomic.LoadInt32(calls) != 1 {
		t.Fatalf("ContinueSession should spawn once, got %d", atomic.LoadInt32(calls))
	}
	if !svc.isActive(sid) {
		t.Fatal("session should be active after ContinueSession")
	}
	// 已活跃再 ContinueSession → no-op,不重复 spawn。
	if err := svc.ContinueSession(sid); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(calls) != 1 {
		t.Fatalf("ContinueSession on active should be no-op, got %d calls", atomic.LoadInt32(calls))
	}
}

// TestSendMessageOnReadOnlyTriggersSpawn:只读态发消息触发 ensureLive → spawn 并接上。
func TestSendMessageOnReadOnlyTriggersSpawn(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	if _, err := svc.st.AppendMessage(svc.ctx, sid, "user", "", "hi", ""); err != nil {
		t.Fatal(err)
	}
	spawnFn, calls, fc := recordingSpawn(svc, t)
	svc.spawnFn = spawnFn

	if err := svc.OpenSession(sid); err != nil { // 只读打开
		t.Fatal(err)
	}
	if atomic.LoadInt32(calls) != 0 {
		t.Fatalf("lazy open should not spawn, got %d", atomic.LoadInt32(calls))
	}
	if err := svc.SendMessage(sid, "hello", nil); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if atomic.LoadInt32(calls) != 1 {
		t.Fatalf("SendMessage on readonly should spawn once, got %d", atomic.LoadInt32(calls))
	}
	waitStarted(t, fc, 1) // 放行 Prompt,防 goroutine 泄漏
}

// TestCloseSessionReadOnlyIsNoOp:只读态(未 spawn)CloseSession 不调 Close(无需回收)。
func TestCloseSessionReadOnlyIsNoOp(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	if _, err := svc.st.AppendMessage(svc.ctx, sid, "user", "", "hi", ""); err != nil {
		t.Fatal(err)
	}
	mc := &mockChatConn{}
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		svc.mu.Lock()
		svc.active[se.ID] = &liveSession{chat: mc, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Unlock()
		return nil
	}
	if err := svc.OpenSession(sid); err != nil { // 只读,未 spawn
		t.Fatal(err)
	}
	if err := svc.CloseSession(sid); err != nil {
		t.Fatalf("CloseSession readonly: %v", err)
	}
	if mc.closed.Load() {
		t.Fatal("readonly CloseSession must not call harness Close")
	}
}

// TestCloseSessionActiveReclaims:已 spawn 的 session CloseSession 调 Close(回收资源)。
func TestCloseSessionActiveReclaims(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	mc := &mockChatConn{}
	svc.spawnFn = func(se *store.Session, proj *store.Project, _ string, _ bool) error {
		svc.mu.Lock()
		svc.active[se.ID] = &liveSession{chat: mc, proj: proj, index: map[string]*turnEntry{}}
		svc.mu.Unlock()
		return nil
	}
	if err := svc.ContinueSession(sid); err != nil { // spawn
		t.Fatal(err)
	}
	if mc.closed.Load() {
		t.Fatal("spawn should not close")
	}
	if err := svc.CloseSession(sid); err != nil {
		t.Fatalf("CloseSession active: %v", err)
	}
	if !mc.closed.Load() {
		t.Fatal("active CloseSession should call harness Close")
	}
	if svc.isActive(sid) {
		t.Fatal("session should be removed from active after close")
	}
}
