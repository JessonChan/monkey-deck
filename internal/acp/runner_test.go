package acp

import (
	"context"
	"fmt"
	"strings"
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

// TestFindSessionTitle:findSessionTitle 按 sessionId 在 cwd 过滤的分页结果里找标题
// (Task #22117 探针确认:OMP/opencode 均支持 cwd 过滤 + cursor 分页)。
// 覆盖:首页命中 / 翻页命中 / 无更多页终止 / 标题为 nil 跳过 / 全部 nil 标题返回空 /
// maxListPages 防死循环 / list 报错透传。
func TestFindSessionTitle(t *testing.T) {
	sid := acp.SessionId("ses-target")
	strPtr := func(v string) *string { return &v }
	ctx := context.Background()

	t.Run("first page hit", func(t *testing.T) {
		calls := 0
		list := func(_ context.Context, cwd string, cursor *string) ([]acp.SessionInfo, *string, error) {
			calls++
			if cwd != "/proj" {
				t.Fatalf("expected cwd filter /proj, got %q", cwd)
			}
			if cursor != nil {
				t.Fatalf("first page cursor should be nil, got %q", *cursor)
			}
			return []acp.SessionInfo{
				{SessionId: "other", Cwd: "/proj"},
				{SessionId: sid, Cwd: "/proj", Title: strPtr("权威标题")},
			}, nil, nil
		}
		got, err := findSessionTitle(ctx, list, "/proj", sid)
		if err != nil || got != "权威标题" {
			t.Fatalf("got=%q err=%v", got, err)
		}
		if calls != 1 {
			t.Fatalf("expected single list call, got %d", calls)
		}
	})

	t.Run("paginates until hit", func(t *testing.T) {
		calls := 0
		list := func(_ context.Context, _ string, cursor *string) ([]acp.SessionInfo, *string, error) {
			calls++
			switch calls {
			case 1:
				if cursor != nil {
					t.Fatal("first page cursor not nil")
				}
				return []acp.SessionInfo{{SessionId: "a"}, {SessionId: "b"}}, strPtr("c2"), nil
			case 2:
				if cursor == nil || *cursor != "c2" {
					t.Fatalf("page2 cursor want c2, got %v", cursor)
				}
				return []acp.SessionInfo{{SessionId: "c"}}, strPtr("c3"), nil
			case 3:
				return []acp.SessionInfo{{SessionId: sid, Title: strPtr("翻页标题")}}, nil, nil
			}
			t.Fatal("unexpected extra call")
			return nil, nil, nil
		}
		got, err := findSessionTitle(ctx, list, "/proj", sid)
		if err != nil || got != "翻页标题" {
			t.Fatalf("got=%q err=%v", got, err)
		}
		if calls != 3 {
			t.Fatalf("expected 3 pages, got %d", calls)
		}
	})

	t.Run("stops when next cursor nil", func(t *testing.T) {
		calls := 0
		list := func(_ context.Context, _ string, _ *string) ([]acp.SessionInfo, *string, error) {
			calls++
			return []acp.SessionInfo{{SessionId: "x"}}, nil, nil // no next, no match
		}
		got, err := findSessionTitle(ctx, list, "/proj", sid)
		if err != nil || got != "" {
			t.Fatalf("got=%q err=%v", got, err)
		}
		if calls != 1 {
			t.Fatalf("expected 1 call (nil cursor stops), got %d", calls)
		}
	})

	t.Run("skips nil title, returns empty", func(t *testing.T) {
		list := func(_ context.Context, _ string, _ *string) ([]acp.SessionInfo, *string, error) {
			return []acp.SessionInfo{{SessionId: sid, Title: nil}}, nil, nil
		}
		got, err := findSessionTitle(ctx, list, "/proj", sid)
		if err != nil || got != "" {
			t.Fatalf("nil Title must be skipped, got=%q err=%v", got, err)
		}
	})

	t.Run("empty next cursor terminates", func(t *testing.T) {
		empty := ""
		calls := 0
		list := func(_ context.Context, _ string, _ *string) ([]acp.SessionInfo, *string, error) {
			calls++
			return []acp.SessionInfo{{SessionId: "x"}}, &empty, nil // empty-string cursor == no more
		}
		got, err := findSessionTitle(ctx, list, "/proj", sid)
		if err != nil || got != "" {
			t.Fatalf("got=%q err=%v", got, err)
		}
		if calls != 1 {
			t.Fatalf("empty-string cursor must terminate, got %d calls", calls)
		}
	})

	t.Run("maxListPages bounds runaway cursor", func(t *testing.T) {
		calls := 0
		alwaysNext := "more"
		list := func(_ context.Context, _ string, _ *string) ([]acp.SessionInfo, *string, error) {
			calls++
			return []acp.SessionInfo{{SessionId: "x"}}, &alwaysNext, nil // never resolves, never matches
		}
		got, err := findSessionTitle(ctx, list, "/proj", sid)
		if err != nil || got != "" {
			t.Fatalf("got=%q err=%v", got, err)
		}
		if calls != maxListPages {
			t.Fatalf("expected exactly %d bounded calls, got %d", maxListPages, calls)
		}
	})

	t.Run("list error propagated", func(t *testing.T) {
		list := func(_ context.Context, _ string, _ *string) ([]acp.SessionInfo, *string, error) {
			return nil, nil, fmt.Errorf("boom")
		}
		_, err := findSessionTitle(ctx, list, "/proj", sid)
		if err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("expected boom error, got %v", err)
		}
	})
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

// TestRefreshConfigSpawnFailure 验证 probe harness spawn 失败时的错误路径:
// harness 命令不存在 → spawnAndInit 返回 exec 错误 → RefreshConfig 包成
// "spawn probe" 错误返回,不 panic、不留孤儿进程(killProcessGroup 幂等处理 nil cmd)。
// 复现 §3.2 回收安全性:probe 失败也要干净退出。
func TestRefreshConfigSpawnFailure(t *testing.T) {
	cs := &ChatSession{
		Runner:  NewRunner("/nonexistent/harness-binary", nil),
		WorkDir: t.TempDir(),
	}
	_, err := cs.RefreshConfig(context.Background())
	if err == nil {
		t.Fatal("expected error when harness command does not exist")
	}
	if !strings.Contains(err.Error(), "spawn probe") {
		t.Fatalf("expected spawn probe error, got %v", err)
	}
}
