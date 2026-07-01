package chat

import (
	"testing"
	"time"
)

// 回归(AGENTS.md §5.3):Prompt 成功返回但零输出(resume 后 harness 内部状态损坏)
// 时,runPrompt 曾静默 emit idle → 用户发消息没反应。
// 修复:检测空 turn(segments+tools 全空)→ teardown + emit error,下条消息自动重连。
func TestEmptyTurnDetectedAsError(t *testing.T) {
	svc, sessionID, fc := newTestService(t)

	// 去掉 emitHook,模拟 harness 返回空 turn(无 SessionUpdate)。
	fc.emitHook = nil

	// 注入 emit 捕获,记录最终 status。
	var lastStatus string
	svc.emitHook = func(name string, data any) {
		if name == EventStatus {
			lastStatus = data.(StatusPayload).Status
		}
	}

	if err := svc.SendMessage(sessionID, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	fc.release()

	// 等 runPrompt 收尾(跳过中间 prompting,等终态 error/idle)。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && (lastStatus == "" || lastStatus == "prompting") {
		time.Sleep(2 * time.Millisecond)
	}
	if lastStatus != "error" {
		t.Fatalf("empty turn should emit error, got status=%q", lastStatus)
	}

	// session 应已被 teardown(active 中不应再有该 session)。
	if svc.isActive(sessionID) {
		t.Fatal("session should be torn down after empty turn")
	}
}
