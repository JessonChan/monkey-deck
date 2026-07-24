package chat

// declarative_harness_test.go:声明即用 harness 向导的 binding 端到端(不 spawn 真 harness)。
// 验证 AddUserHarness/RemoveUserHarness + 合并层(ListHarnesses 含用户行、命令解析、id 归一化)。
// ProbeNewHarness(真 spawn)由 probe_integration_test.go 覆盖。

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/harness"
	"github.com/jessonchan/monkey-deck/internal/store"
)

func TestDeclarativeAddUserHarness(t *testing.T) {
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

	// 1. AddUserHarness:id 由命令首 token 派生。
	h, err := svc.AddUserHarness("fakecli acp", "Fake CLI", "")
	if err != nil {
		t.Fatalf("add: %v", err)
	}
	if h.ID != "fakecli" || h.Command != "fakecli acp" || h.Name != "Fake CLI" {
		t.Fatalf("added row wrong: %+v", h)
	}

	// 2. ListHarnesses 含用户行(cache 已在 add 时刷新)。
	if !harnessInList(svc.ListHarnesses(), "fakecli") {
		t.Fatal("user harness not in ListHarnesses after add")
	}

	// 3. harnessCommand 解析用户命令;normalizeHarnessID 保留用户 id;未知 id 回退默认。
	if cmd := svc.harnessCommand("fakecli"); cmd != "fakecli acp" {
		t.Fatalf("harnessCommand: %q", cmd)
	}
	if id := svc.normalizeHarnessID("fakecli"); id != "fakecli" {
		t.Fatalf("normalize user id: %q", id)
	}
	if id := svc.normalizeHarnessID("nope"); id != harness.DefaultID {
		t.Fatalf("normalize unknown should fallback default: %q", id)
	}
	// 内置仍走内置命令。
	if cmd := svc.harnessCommand("omp"); cmd != harness.Command("omp") {
		t.Fatalf("builtin command resolve: %q", cmd)
	}

	// 4. 冲突:内置 id 不可用。
	if _, err := svc.AddUserHarness("omp acp", "", ""); err == nil {
		t.Fatal("builtin id should conflict")
	}
	// 5. 冲突:重复用户 id。
	if _, err := svc.AddUserHarness("fakecli acp", "", ""); err == nil {
		t.Fatal("duplicate user id should error")
	}
	// 6. 空命令。
	if _, err := svc.AddUserHarness("   ", "", ""); err == nil {
		t.Fatal("empty command should error")
	}

	// 7. RemoveUserHarness;内置不可删。
	if err := svc.RemoveUserHarness("fakecli"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := svc.RemoveUserHarness("omp"); err == nil {
		t.Fatal("builtin should not be removable")
	}
	if harnessInList(svc.ListHarnesses(), "fakecli") {
		t.Fatal("fakecli still in list after remove")
	}
}

func harnessInList(list []harness.Harness, id string) bool {
	for _, h := range list {
		if h.ID == id {
			return true
		}
	}
	return false
}
