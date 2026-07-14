package chat

// queue_test.go:单 turn 生命周期 + 打断的单测(AGENTS.md §5.1:接口注入 mock,不启真 harness)。
//
// 覆盖三条不变量(协议无 queue,一个 session 同时只一个 Prompt,§5.4 调研结论):
//  1. busy 守卫:turn 进行中再 SendMessage 应被拒,不发起第二个 Prompt。
//  2. InterruptAndSend:cancel 当前 turn(干净 session/cancel)→ 等其落定 → 发新消息;
//     被打断的轮不发 idle(suppressIdle),新轮发 prompting。
//  3. StopSession:干净 cancel 当前 turn(非杀进程),runPrompt 推 idle/cancelled。

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// fakeChat 实现 chatConn:Prompt 阻塞到 ctx 取消(返回 ctx.Err,模拟 SDK 取消行为)
// 或 release 被调用(返回 end_turn)。记录所有 prompt 消息与取消次数。
type fakeChat struct {
	mu        sync.Mutex
	prompts   []string
	cancelled int
	block     chan struct{} // 关闭则所有阻塞 Prompt 返回 end_turn
	started   chan struct{} // 每次 Prompt 进入时发信号(buffered,防丢)
	title     string        // SessionTitle 返回值(模拟 harness 经 session/list 给的标题)
	emitHook  func(msg string) // 成功返回前回调(模拟 agent 产出一条消息,避免空 turn)
}

func newFakeChat() *fakeChat {
	return &fakeChat{
		block:   make(chan struct{}),
		started: make(chan struct{}, 64),
	}
}

func (f *fakeChat) Prompt(ctx context.Context, msg string, _ []acp.Attachment) (acp.StopReason, error) {
	f.mu.Lock()
	f.prompts = append(f.prompts, msg)
	f.mu.Unlock()
	select {
	case f.started <- struct{}{}:
	default:
	}
	select {
	case <-ctx.Done():
		f.mu.Lock()
		f.cancelled++
		f.mu.Unlock()
		return "", ctx.Err()
	case <-f.block:
		if f.emitHook != nil {
			f.emitHook(msg)
		}
		return acp.StopReason("end_turn"), nil
	}
}

func (f *fakeChat) Close()                                               {}
func (f *fakeChat) IsAlive() bool                                        { return true }
func (f *fakeChat) RespondPermission(_, _ string) bool                   { return true }
func (f *fakeChat) SessionTitle(_ context.Context) (string, error)       { return f.title, nil }
func (f *fakeChat) FlatConfigOptions() []acp.ConfigOption                { return nil }
func (f *fakeChat) SupportsImage() bool                                  { return false }
func (f *fakeChat) SetConfigOption(_ context.Context, _, _ string) error { return nil }
func (f *fakeChat) RefreshConfig(_ context.Context) ([]acp.ConfigOption, error) {
	return nil, nil
}

// release 放行所有阻塞的 Prompt(幂等),供 t.Cleanup 防止 goroutine 泄漏。
func (f *fakeChat) release() {
	select {
	case <-f.block:
	default:
		close(f.block)
	}
}

func (f *fakeChat) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.prompts)
}

func (f *fakeChat) cancelledCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cancelled
}

// newTestService 建一个带临时 store 的 ChatService,并注入一个用 fakeChat 的 liveSession。
func newTestService(t *testing.T) (svc *ChatService, sessionID string, fc *fakeChat) {
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

	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	sessionID = se.ID

	fc = newFakeChat()
	ls := &liveSession{chat: fc, proj: proj, index: map[string]*turnEntry{}}
	// emitHook 模拟 agent 在 Prompt 成功返回前产出一条消息(避免 runPrompt 空响应检测)。
	fc.emitHook = func(msg string) {
		svc.handleEvent(ls, sessionID, acp.SessionEvent{Kind: "agent_message_chunk", Text: "ok"})
	}
	svc.active[sessionID] = ls
	t.Cleanup(fc.release) // 兜底:放行所有阻塞 Prompt,防 goroutine 泄漏
	return svc, sessionID, fc
}

// waitStarted 等待 fakeChat 至少进入 n 次 Prompt。
func waitStarted(t *testing.T, fc *fakeChat, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fc.count() >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %d prompts, got %d", n, fc.count())
}

// waitCancelled 等待 fakeChat 累计至少 n 次取消。
func waitCancelled(t *testing.T, fc *fakeChat, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if fc.cancelledCount() >= n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %d cancellations, got %d", n, fc.cancelledCount())
}

// TestBusyGuardRejectsConcurrentSend:turn 进行中再 SendMessage 必须被拒,且不发起第二个 Prompt。
func TestBusyGuardRejectsConcurrentSend(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "msg1", nil); err != nil {
		t.Fatalf("first send: %v", err)
	}
	waitStarted(t, fc, 1) // msg1 的 Prompt 已进入(阻塞中),busy 已置位

	err := svc.SendMessage(sid, "msg2", nil)
	if err == nil {
		t.Fatal("second SendMessage should be rejected while busy")
	}

	// 只应有 1 个 Prompt(msg2 被拒,没起第二轮)。msg1 仍阻塞,由 t.Cleanup 放行。
	if got := fc.count(); got != 1 {
		t.Fatalf("expected exactly 1 prompt, got %d (%v)", got, fc.prompts)
	}
	if fc.prompts[0] != "msg1" {
		t.Fatalf("expected msg1, got %q", fc.prompts[0])
	}
}

// TestInterruptAndSendCancelsAndResends:InterruptAndSend 应 cancel 当前 turn + 发新消息,
// 被打断的轮计入 cancelled,新轮正常跑。
func TestInterruptAndSendCancelsAndResends(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "msg1", nil); err != nil {
		t.Fatalf("first send: %v", err)
	}
	waitStarted(t, fc, 1)

	// 打断 msg1,立即发 msg2。
	if err := svc.InterruptAndSend(sid, "msg2", nil); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
	waitStarted(t, fc, 2) // msg2 的 Prompt 已进入

	// msg1 被取消,msg2 在跑。
	if got := fc.cancelledCount(); got != 1 {
		t.Fatalf("expected 1 cancelled prompt, got %d", got)
	}
	if got := fc.count(); got != 2 {
		t.Fatalf("expected 2 prompts, got %d (%v)", got, fc.prompts)
	}
	if fc.prompts[0] != "msg1" || fc.prompts[1] != "msg2" {
		t.Fatalf("prompt order = %v, want [msg1 msg2]", fc.prompts)
	}
}

// TestInterruptAndSendWhenIdle:无在跑 turn 时 InterruptAndSend 等价于 SendMessage。
func TestInterruptAndSendWhenIdle(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.InterruptAndSend(sid, "solo", nil); err != nil {
		t.Fatalf("interrupt when idle: %v", err)
	}
	waitStarted(t, fc, 1)
	if got := fc.count(); got != 1 {
		t.Fatalf("expected 1 prompt, got %d", got)
	}
	if fc.cancelledCount() != 0 {
		t.Fatalf("expected 0 cancellations when idle, got %d", fc.cancelledCount())
	}
}

// TestStopSessionCancelsCleanly:StopSession 应取消当前 turn(非杀进程),
// 被取消的 Prompt 计入 cancelled。
func TestStopSessionCancelsCleanly(t *testing.T) {
	svc, sid, fc := newTestService(t)

	if err := svc.SendMessage(sid, "msg1", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)

	if err := svc.StopSession(sid); err != nil {
		t.Fatalf("stop: %v", err)
	}

	waitCancelled(t, fc, 1) // runPrompt 收到取消并落定
}
