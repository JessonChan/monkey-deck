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
func TestEmptyTurnDetectedAsNotice(t *testing.T) {
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

	// 等 runPrompt 收尾(跳过中间 prompting,等终态 notice/idle)。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && (lastPayload.Status == "" || lastPayload.Status == "prompting") {
		time.Sleep(2 * time.Millisecond)
	}
	// 非异常的零输出 end_turn 推 notice(温和提示,前端蓝色条),不推 error(红色,吓人)。
	if lastPayload.Status != "notice" {
		t.Fatalf("empty turn should emit notice (gentle, not error), got status=%q", lastPayload.Status)
	}
	// Code 驱动:i18n 翻译键必须是稳定 code,而非中文 Detail(§4.4 / §5.3)。
	if lastPayload.Code != ErrCodeHarnessEmptyTurn {
		t.Fatalf("empty turn notice Code=%q, want %q (回退中文 Detail 会导致英文 locale 看到 i18n 回归)",
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

// 用户主动 decline(Skip)elicitation 后,harness 命令直接 end_turn 零输出(omp /review 实测)。
// 这种空 turn 是用户自己的选择,不当错误提示 —— 静默推 idle(§3.x elicitation)。
// 对照 TestEmptyTurnDetectedAsNotice(无 decline 的空 turn → 推 notice 温和提示)。
//
// 忠实模拟:declined 标志必须在 turn 内(Prompt 进行中)置位 —— 真实流程是用户在 Prompt 期间点
// Skip。startTurn 开头会 ResetElicitDeclined,故 SendMessage 前置位会被清掉(不忠实)。用 emitHook
// 在 release 触发时(Prompt 即将返回 end_turn 前)置位,贴合真实时序。
func TestEmptyTurnAfterElicitDeclineIsSilentIdle(t *testing.T) {
	svc, sessionID, fc := newTestService(t)

	// emitHook 在 release(Prompt 返回前)触发:模拟用户在 turn 进行中 decline 了 elicitation。
	// 不产出任何 SessionUpdate(emitHook 本就不 emit),保持空 turn 语义。
	fc.emitHook = func(_ string) { fc.declined.Store(true) }

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

	// 等终态(应直接到 idle,不经 notice/error)。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && (lastPayload.Status == "" || lastPayload.Status == "prompting") {
		time.Sleep(2 * time.Millisecond)
	}
	if lastPayload.Status != "idle" {
		t.Fatalf("decline-induced empty turn should emit idle (silent), got status=%q code=%q detail=%q",
			lastPayload.Status, lastPayload.Code, lastPayload.Detail)
	}
	if lastPayload.Code != "" {
		t.Fatalf("decline-induced empty turn must carry NO error code, got %q", lastPayload.Code)
	}
}
