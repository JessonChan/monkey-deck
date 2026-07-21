package chat

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// TestCreateSessionPersistsLastHarness 验证 CreateSession 把用户选的 harness 记进 lastHarness setting,
// GetLastHarness 读回;空/未知 id 经 Normalize 回退到默认(omp)。
// 不变量:新建对话默认选中上次用的 harness(§5.3 本地是真相来源)。
func TestCreateSessionPersistsLastHarness(t *testing.T) {
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

	// 建一个非 git 项目目录(useWorktree=false 不需要 git)。
	proj, err := st.CreateProject(svc.ctx, "p", dir, "")
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	// 未建过 session:无记录。
	if got := svc.GetLastHarness(); got != "" {
		t.Fatalf("GetLastHarness before any session = %q, want empty", got)
	}

	// 选 opencode → 记下 opencode。
	if _, err := svc.CreateSession(proj.ID, "t", "opencode", false); err != nil {
		t.Fatalf("CreateSession opencode: %v", err)
	}
	if got := svc.GetLastHarness(); got != "opencode" {
		t.Fatalf("GetLastHarness after opencode = %q, want opencode", got)
	}

	// 空 id → Normalize 回退 omp → 记下 omp。
	if _, err := svc.CreateSession(proj.ID, "t", "", false); err != nil {
		t.Fatalf("CreateSession empty: %v", err)
	}
	if got := svc.GetLastHarness(); got != "omp" {
		t.Fatalf("GetLastHarness after empty = %q, want omp", got)
	}

	// 未知 id → Normalize 回退 omp。
	if _, err := svc.CreateSession(proj.ID, "t", "nope", false); err != nil {
		t.Fatalf("CreateSession unknown: %v", err)
	}
	if got := svc.GetLastHarness(); got != "omp" {
		t.Fatalf("GetLastHarness after unknown = %q, want omp", got)
	}
}
