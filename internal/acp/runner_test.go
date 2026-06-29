package acp

import (
	"context"
	"fmt"
	"testing"

	"github.com/coder/acp-go-sdk"
)

// TestSessionTitleCapabilityGuard:协议硬约束 —— agent 未声明 session/list
// 能力时(SessionTitle.CanListSessions==false),SessionTitle 不得调用
// Conn.ListSessions(session-list.mdx:Clients MUST verify capability before calling)。
// 构造 CanListSessions=false 且 Conn=nil 的 ChatSession,断言它早返("", nil)而不
// 触碰 Conn(否则 nil 解引用 panic)。
func TestSessionTitleCapabilityGuard(t *testing.T) {
	cs := &ChatSession{CanListSessions: false} // Conn 故意留 nil
	title, err := cs.SessionTitle(context.Background())
	if err != nil {
		t.Fatalf("expected nil error when capability absent, got %v", err)
	}
	if title != "" {
		t.Fatalf("expected empty title when capability absent, got %q", title)
	}
}

// TestIsPeerDisconnectedBrokenPipe 复现 §5.4 实证 bug:harness 退出后,本地写其已关闭的
// stdin 管道失败,SDK 经 toReqErr 包成 *RequestError{-32603,"Internal error",
// data:{error:"write |1: broken pipe"}}(见 acp-go-sdk errors.go)。
// 旧 IsPeerDisconnected 只查 re.Message(="Internal error"),漏判 → runPrompt 走 error
// 分支:不拆死 harness(session 卡死,每条消息都 broken pipe)+ 裸 JSON 推前端(§4.4)。
// 断言:broken pipe 必须被识别为 peer disconnected(走拆连接 + LoadSession 重连路径)。
func TestIsPeerDisconnectedBrokenPipe(t *testing.T) {
	re := acp.NewInternalError(map[string]any{"error": "write |1: broken pipe"})
	err := fmt.Errorf("prompt: %w", re) // 与 runner.go Prompt 的 %w 包装一致
	if !IsPeerDisconnected(err) {
		t.Fatalf("broken pipe 应识别为 peer disconnected, got false; err=%v", err)
	}
}

// TestIsPeerDisconnectedDoesNotOvermatch 断言不误判无关错误(避免把真 bug 当断连吞掉),
// 同时确认旧路径 "peer disconnected" 仍命中(无回归)。
func TestIsPeerDisconnectedDoesNotOvermatch(t *testing.T) {
	unrelated := fmt.Errorf("prompt: %w", acp.NewInternalError(map[string]any{"error": "别的错误"}))
	if IsPeerDisconnected(unrelated) {
		t.Fatal("无关 Internal error 被误判为 peer disconnected")
	}
	if !IsPeerDisconnected(fmt.Errorf("peer disconnected before response")) {
		t.Fatal("旧路径 peer disconnected 不再命中(回归)")
	}
	if IsPeerDisconnected(nil) {
		t.Fatal("nil 不应判为 peer disconnected")
	}
}
