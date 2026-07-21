package chat

// error_code_test.go:钉死 harness 断连族 error 状态的 code 驱动分支(Task #21306 回归)。
//
// 背景见 docs/worklog/2026-07-22-harness-disconnect-i18n.md:断连/空响应的用户提示曾
// 由后端硬编码中文塞进 StatusPayload.Detail,切英文 locale 仍是中文(i18n 漏网)。
// 修复改走 emitError(code):error 状态携带稳定 Code(前端按 code 经 i18n 翻译),Detail 留空。
//
// 这两个测试钉住 disconnect 路径的 code 驱动不变量:有人把 emitError(ErrCodeHarnessDisconnected)
// 还原成 emitStatus("error", "agent 连接已重置,下条消息将自动重连") 之类的中文 Detail,
// 本测试必须红 —— 否则英文 locale 用户仍看到后端中文文案(i18n 回归)。
//
// 覆盖两条 Prompt 失败路由(§1.3):
//   - runPrompt(异步,SendMessage/InterruptAndSend 走的后台路径):chat.go:1387。
//   - SendAndWaitSync(同步驱动路径):chat.go:1310。

import (
	"errors"
	"testing"
	"time"
)

// waitErrorStatus 轮询等终态 error status(跳过中间 prompting),返回该 payload。
func waitErrorStatus(t *testing.T, last *StatusPayload) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && (last.Status == "" || last.Status == "prompting") {
		time.Sleep(2 * time.Millisecond)
	}
	if last.Status != "error" {
		t.Fatalf("disconnect should emit error status, got %q", last.Status)
	}
}

// assertDisconnectedCode 断言 disconnect error 必须走 code 驱动(Code 填、Detail 空)。
func assertDisconnectedCode(t *testing.T, p StatusPayload) {
	t.Helper()
	if p.Code != ErrCodeHarnessDisconnected {
		t.Fatalf("disconnect error Code=%q, want %q (回退中文 Detail 会导致英文 locale i18n 回归)",
			p.Code, ErrCodeHarnessDisconnected)
	}
	if p.Detail != "" {
		t.Fatalf("disconnect error must carry Code with empty Detail (no hardcoded/raw Chinese or OS error text), got Detail=%q", p.Detail)
	}
}

// TestRunPromptDisconnectEmitsCode:runPrompt(后台路径)Prompt 失败(peer 断连)
// 必须走 emitError(ErrCodeHarnessDisconnected),Detail 留空,并 teardown 连接。
func TestRunPromptDisconnectEmitsCode(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	// 模拟 SDK 在 harness 进程崩溃时返回的 peer disconnected 错。
	fc.promptErr = errors.New("peer disconnected before response")

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

	waitErrorStatus(t, &lastPayload)
	assertDisconnectedCode(t, lastPayload)

	if svc.isActive(sessionID) {
		t.Fatal("session should be torn down after disconnect")
	}
}

// TestRunPromptBrokenPipeEmitsCode:本地写已关闭管道(broken pipe)与 peer disconnected
// 等价(IsPeerDisconnected 都命中),同样走 emitError(ErrCodeHarnessDisconnected)。
// 覆盖 §5.4 #2 的两类断连信号。
func TestRunPromptBrokenPipeEmitsCode(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	fc.promptErr = errors.New(`write |1: broken pipe`)

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

	waitErrorStatus(t, &lastPayload)
	assertDisconnectedCode(t, lastPayload)
}

// TestSendAndWaitSyncDisconnectEmitsCode:同步驱动路径(SendAndWaitSync)Prompt 失败
// 同样必须走 emitError(ErrCodeHarnessDisconnected),Detail 留空。
func TestSendAndWaitSyncDisconnectEmitsCode(t *testing.T) {
	svc, sessionID, fc := newTestService(t)
	fc.promptErr = errors.New("peer disconnected before response")

	var lastPayload StatusPayload
	svc.emitHook = func(name string, data any) {
		if name == EventStatus {
			lastPayload = data.(StatusPayload)
		}
	}

	if _, err := svc.SendAndWaitSync(sessionID, "hello", nil); err == nil {
		t.Fatal("expected error from SendAndWaitSync on peer disconnect")
	}
	if lastPayload.Status != "error" {
		t.Fatalf("disconnect should emit error status, got %q", lastPayload.Status)
	}
	assertDisconnectedCode(t, lastPayload)

	if svc.isActive(sessionID) {
		t.Fatal("session should be torn down after disconnect")
	}
}
