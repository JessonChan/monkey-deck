package acp

import (
	"context"
	"testing"
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
