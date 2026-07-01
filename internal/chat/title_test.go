package chat

// title_test.go:syncSessionTitle 的回归测试 —— harness 经 session/list 给的
// 权威标题应覆盖兜底标题(§5.4 #14),无标题/相同标题不写。

import (
	"context"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/store"
)

func assertTitle(t *testing.T, se *store.Session, want string) {
	t.Helper()
	if se == nil {
		t.Fatalf("session nil")
	}
	if se.Title != want {
		t.Fatalf("title = %q, want %q", se.Title, want)
	}
}

// syncSessionTitle 应把 harness 标题写入 DB(与已存不同时覆盖)。
func TestSyncSessionTitleOverrides(t *testing.T) {
	svc, sid, fc := newTestService(t)
	fc.title = "README 翻译为中文并添加安装说明"

	svc.syncSessionTitle(svc.active[sid], sid)
	se, _ := svc.st.GetSession(context.Background(), sid)
	assertTitle(t, se, fc.title)
}

// 无标题(harness 尚未生成)时不应清空已存标题。
func TestSyncSessionTitleEmptyNoClobber(t *testing.T) {
	svc, sid, fc := newTestService(t)
	if err := svc.st.UpdateSessionTitle(context.Background(), sid, "已有标题"); err != nil {
		t.Fatal(err)
	}
	fc.title = ""
	svc.syncSessionTitle(svc.active[sid], sid)
	se, _ := svc.st.GetSession(context.Background(), sid)
	assertTitle(t, se, "已有标题")
}

// 与已存标题相同时不重复写(无变化)。
func TestSyncSessionTitleSameNoRewrite(t *testing.T) {
	svc, sid, fc := newTestService(t)
	fc.title = "同标题"
	if err := svc.st.UpdateSessionTitle(context.Background(), sid, fc.title); err != nil {
		t.Fatal(err)
	}
	svc.syncSessionTitle(svc.active[sid], sid)
	se, _ := svc.st.GetSession(context.Background(), sid)
	assertTitle(t, se, fc.title)
}
