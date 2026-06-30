package chat

// finalize_race_test.go:确定性复现并锁定 runPrompt 收尾 ↔ InterruptAndSend 的「覆盖竞态」。
//
// 现象(用户实证):用了「立即发送」插队后,session 表面显示空闲,但下次普通发送报
// "session busy: 一轮对话进行中,请等待或打断"。
//
// 根因(§5.4 覆盖竞态):runPrompt 收尾「先清 busy、后 emit」,且不持 sendMu ——
// 与 startTurn 无互斥。InterruptAndSend 用 ls.busy 判断「是否有在跑 turn」。若它恰好
// 在「busy 已清、旧 emit 未发」窗口被调用,会读到 busy=false → 误判无 turn → 直接
// startTurn(置 busy=true、emit 新 prompting)。随后旧 turn 的延迟 emit(idle/error)
// 把前端 status 从「新 prompting」覆盖成「idle」→ 后端 busy=true、前端显示空闲 →
// 下一次普通发送(前端见 status≠prompting 走直发)撞 busy 守卫。
//
// 修复:① runPrompt 收尾段(清 busy→persist→emit)持 sendMu,与 startTurn 互斥,
//   保证「busy=false 时旧 emit 必已完成」;② InterruptAndSend 的 busy 分支改为
//   释放 sendMu 后再等 turnDone,避免与收尾段持同一把锁死锁。
//
// 本测试用 persistHook 卡在收尾窗口(busy 已清、emit 未发),并给 InterruptAndSend
// 一个抢占窗口:修复前(不持 sendMu)会立刻起 msg2 Prompt、覆盖旧 turn;修复后
// (收尾持 sendMu)InterruptAndSend 被阻塞,msg2 不起。最终断言旧 turn 的 idle 必须
// 出现在新 turn 的 prompting 之前。修复前 statuses[1]=="prompting"(失败),修复后
// statuses[1]=="idle"(通过)。

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestInterruptNoRaceWithRunPromptFinalize(t *testing.T) {
	svc, sid, fc := newTestService(t)

	// 捕获 chat:status 事件序列(emitHook 替代 Wails3 event)。
	var (
		mu       sync.Mutex
		statuses []string
	)
	svc.emitHook = func(name string, data any) {
		if name != EventStatus {
			return
		}
		p, ok := data.(StatusPayload)
		if !ok {
			return
		}
		mu.Lock()
		statuses = append(statuses, p.Status)
		mu.Unlock()
	}

	// persistHook:第一次(旧 turn 收尾)阻塞以放大窗口,之后(新 turn)直通。
	var persistCount int32
	persistEntered := make(chan struct{}, 1)
	persistBlock := make(chan struct{})
	svc.persistHook = func() {
		if atomic.AddInt32(&persistCount, 1) == 1 {
			persistEntered <- struct{}{} // 通知:已进入收尾(busy 已清、emit 未发)
			<-persistBlock               // 阻塞直到测试放行
		}
	}

	// 1) 旧 turn:发 msg1。Prompt 阻塞(fakeChat 等 release)。
	if err := svc.SendMessage(sid, "msg1", nil); err != nil {
		t.Fatalf("send msg1: %v", err)
	}
	waitStarted(t, fc, 1)

	// 2) 放行 msg1 的 Prompt 返回 success → runPrompt 进收尾 → persistHook 阻塞(busy 已清)。
	fc.release()
	<-persistEntered

	// 3) 在「busy=false、旧 emit 未发」窗口发起 InterruptAndSend(用户「立即发送」插队)。
	interruptErr := make(chan error, 1)
	go func() { interruptErr <- svc.InterruptAndSend(sid, "msg2", nil) }()

	// 3a) 给 InterruptAndSend 抢占窗口:修复前(runPrompt 收尾不持 sendMu)会立刻起 msg2
	//     Prompt 并 emit 新 prompting —— 覆盖就此发生;修复后(收尾持 sendMu)它被阻塞,
	//     msg2 Prompt 不会起。用轮询探测,不 fatal —— 两种实现都要能继续往下。
	deadline := time.Now().Add(100 * time.Millisecond)
	for time.Now().Before(deadline) && fc.count() < 2 {
		time.Sleep(time.Millisecond)
	}

	// 4) 放行旧 turn 收尾:emit idle(msg1) → 释放 sendMu(修复后)。
	close(persistBlock)

	// 5) 等两个 Prompt 都起 + InterruptAndSend 返回。
	waitStarted(t, fc, 2)
	if err := <-interruptErr; err != nil {
		t.Fatalf("interrupt: %v", err)
	}

	// 6) 断言:旧 idle 必须在新 prompting 之前(无覆盖)。
	//    修复后序列 = [prompting(msg1), idle(msg1), prompting(msg2), ...]  → statuses[1]=="idle"
	//    修复前(覆盖)= [prompting(msg1), prompting(msg2), idle(msg1), ...] → statuses[1]=="prompting"
	mu.Lock()
	got := append([]string(nil), statuses...)
	mu.Unlock()

	if len(got) < 3 {
		t.Fatalf("expected >=3 status events, got %v", got)
	}
	if got[1] != "idle" {
		t.Fatalf("覆盖竞态未修复:status 序列 %v\n"+
			"  期望 [prompting, idle, prompting, ...](旧 idle 在新 prompting 前)\n"+
			"  实际第 2 个是 %q —— 新 prompting 抢跑、旧 idle 延迟覆盖 → 前端误显示空闲 → 下次发送撞 busy 守卫",
			got, got[1])
	}
}
