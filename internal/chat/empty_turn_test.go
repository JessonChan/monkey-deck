package chat

import (
	"testing"
	"time"
)

// 回归(AGENTS.md §5.3):Prompt 成功返回但零输出时,runPrompt 曾静默 emit idle → 用户发消息没反应。
// 修复:检测空 turn(segments+tools 全空)→ emit error(用户可见提示)。
//
// 钉死 code 驱动分支(Task #21306 回归):error 状态必须携带稳定 Code
// (ErrCodeHarnessEmptyTurn)且 Detail 留空 —— 不许回退到后端硬编码中文 Detail
// (如 "agent 未产生响应…")。否则切英文 locale 用户仍看到中文文案(i18n 回归)。
// 有人把 emitError 还原成 emitStatus("error", "<中文硬编码>"),本测试必须红。
//
// 2026-08-02 修正:不再 teardown/重连。end_turn + 零输出是协议合法结果(实测 omp /review 在
// client 无 elicitation 时命中),连接本身是好的 —— 只提示、保留连接供用户继续操作。
func TestEmptyTurnDetectedAsError(t *testing.T) {
	svc, sessionID, fc := newTestService(t)

	// 去掉 emitHook,模拟 harness 返回空 turn(无 SessionUpdate)。
	fc.emitHook = nil

	// 注入 emit 捕获,记录最终 status payload(含 Code / Detail)。
	var lastPayload StatusPayload
	svc.emitHook = func(name string, data any) {
		if name == EventStatus {
			lastPayload = data.(StatusPayload)
		}
	}

	if err := svc.SendMessage(sessionID, "hello", nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitStarted(t, fc, 1)
	fc.release()

	// 等 runPrompt 收尾(跳过中间 prompting,等终态 error/idle)。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && (lastPayload.Status == "" || lastPayload.Status == "prompting") {
		time.Sleep(2 * time.Millisecond)
	}
	if lastPayload.Status != "error" {
		t.Fatalf("empty turn should emit error, got status=%q", lastPayload.Status)
	}
	// Code 驱动:i18n 翻译键必须是稳定 code,而非中文 Detail(§4.4 / §5.3)。
	if lastPayload.Code != ErrCodeHarnessEmptyTurn {
		t.Fatalf("empty turn error Code=%q, want %q (回退中文 Detail 会导致英文 locale 看到 i18n 回归)",
			lastPayload.Code, ErrCodeHarnessEmptyTurn)
	}
	if lastPayload.Detail != "" {
		t.Fatalf("empty turn error must carry Code with empty Detail (no hardcoded/raw text), got Detail=%q", lastPayload.Detail)
	}

	// 连接必须保留(不 teardown):end_turn + 零输出是协议合法结果,连接本身是好的。
	// 用户可见提示后可继续操作(发下条消息、换命令);原来一刀切 teardown+重连是过度反应。
	if !svc.isActive(sessionID) {
		t.Fatal("session must stay active after empty turn (connection preserved)")
	}
}
