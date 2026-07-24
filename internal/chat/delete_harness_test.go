package chat

// delete_harness_test.go:删 harness 后,绑定它的 session 不能再继续对话(startLive 守卫拒绝 spawn)。

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

func TestDeleteHarnessBlocksSessionSpawn(t *testing.T) {
	dir := t.TempDir()
	st, err := store.New(filepath.Join(dir, config.AppSlug+".db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	cfg := config.TestConfig(dir)
	svc := NewChatService(cfg)
	svc.ctx = context.Background()
	svc.st = st

	proj, err := st.CreateProject(svc.ctx, "p", dir, "")
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	// 1. 声明一个用户 harness。
	if _, err := svc.AddUserHarness("fakecli acp", "Fake", ""); err != nil {
		t.Fatalf("add: %v", err)
	}
	if !svc.harnessExists("fakecli") {
		t.Fatal("fakecli 应存在(刚加)")
	}

	// 2. 一个绑定 fakecli 的 session(直接构造 store.Session,无需真建)。
	se := &store.Session{ID: "s1", ProjectID: proj.ID, Harness: "fakecli"}

	// 3. 删除 harness。
	if err := svc.RemoveUserHarness("fakecli"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if svc.harnessExists("fakecli") {
		t.Fatal("fakecli 删除后应不存在")
	}

	// 4. 该 session 再 startLive 必须被拒(harness 已删,不能继续对话;历史保留)。
	err = svc.startLive(se, proj, "", false)
	if err == nil {
		t.Fatal("startLive 对已删 harness 的 session 应报错,却返回 nil")
	}
	if !strings.Contains(err.Error(), "已删除") {
		t.Fatalf("错误信息应含「已删除」,实际:%v", err)
	}

	// 5. 内置 harness 不受影响(仍可存在)。
	if !svc.harnessExists("omp") {
		t.Fatal("内置 omp 应始终存在")
	}
}
