package chat

// catalog_harness_test.go:KnownCatalog PATH 命中项的「可用性落地」测试(#187)。
//
// 覆盖两条边界:
//  1. 用户选中目录命中项建 session → ensureCatalogHarness 按 AddHarness 同款静默落
//     user harness 行(BinaryName=Alias),Normalize 不再把它弹回默认(omp);幂等。
//  2. AddHarness 派生 id 撞目录命中项 → 目录版保住裸 id,手动项消歧成 -2(去重)。
//
// 不真起 harness(§5.1):合成目录条目用不存在的二进制名(mdcatgoose),Discover 走
// fakeStubProbe 伪 PATH 命中;materialize 后的 spawn 探测因二进制不存在立即失败(静默降级)。

import (
	"testing"

	"github.com/jessonchan/monkey-deck/internal/harness"
)

// swapKnownCatalogForTest 替换全局 KnownCatalog 并在测试结束还原(t.Cleanup)。
// 合成条目不依赖 knownSeed 内容(测试对种子变化免疫)。
func swapKnownCatalogForTest(t *testing.T, cat []harness.KnownHarness) {
	t.Helper()
	prev := harness.KnownCatalog
	harness.KnownCatalog = cat
	t.Cleanup(func() { harness.KnownCatalog = prev })
}

// catalogTestHarness 返回合成目录条目 + 命中它的伪 PATH Probe 还原函数。
func catalogTestHarness(t *testing.T) harness.KnownHarness {
	t.Helper()
	kh := harness.KnownHarness{ID: "mdcatgoose", Name: "Catalog Goose", BinaryName: "mdcatgoose"}
	swapKnownCatalogForTest(t, []harness.KnownHarness{kh})
	restore := harness.SetProbeForTest(fakeStubProbe{
		paths: map[string]string{"mdcatgoose": "/fake/mdcatgoose"},
		vers:  map[string]string{"mdcatgoose": "mdcatgoose version 1.2.3\n"},
	})
	t.Cleanup(restore)
	return kh
}

// TestCreateSessionMaterializesCatalogHarness 用户选中目录命中项建 session:
// 静默落 user harness 行(BinaryName=Alias),session.harness 钉目录 id(不弹回 omp);再次建 session 幂等。
func TestCreateSessionMaterializesCatalogHarness(t *testing.T) {
	resetUserHarnessesForTest(t)
	kh := catalogTestHarness(t)
	svc := setupHarnessStoreSvc(t)

	proj, err := svc.st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}

	se, err := svc.CreateSession(proj.ID, "t", kh.ID, false, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if se.Harness != kh.ID {
		t.Fatalf("session.Harness = %q, want %q (must not bounce to default)", se.Harness, kh.ID)
	}
	// GetLastHarness 记住的也是目录 id(下次默认选中)。
	if got := svc.GetLastHarness(); got != kh.ID {
		t.Fatalf("GetLastHarness = %q, want %q", got, kh.ID)
	}

	// 落库断言:一行 user harness,Command = BinaryName + " acp",Name 取目录显示名。
	row, err := svc.st.GetUserHarness(svc.ctx, kh.ID)
	if err != nil {
		t.Fatalf("GetUserHarness: %v", err)
	}
	if row == nil {
		t.Fatal("catalog hit was not materialized as a user harness row")
	}
	if row.Command != "mdcatgoose acp" || row.Name != kh.Name {
		t.Fatalf("materialized row wrong: %+v", row)
	}

	// 幂等:再次建 session 不重复落行。
	if _, err := svc.CreateSession(proj.ID, "t2", kh.ID, false, "", nil); err != nil {
		t.Fatalf("CreateSession #2: %v", err)
	}
	rows, err := svc.st.ListUserHarnesses(svc.ctx)
	if err != nil {
		t.Fatalf("ListUserHarnesses: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("user harness rows = %d, want 1 (idempotent): %+v", len(rows), rows)
	}
}

// TestCreateSession_UnknownCatalogIDUntouched 非 catalog id 走原路径:不落任何 user 行,
// 未知 id 照旧 Normalize 回退 omp。
func TestCreateSession_UnknownCatalogIDUntouched(t *testing.T) {
	resetUserHarnessesForTest(t)
	catalogTestHarness(t)
	svc := setupHarnessStoreSvc(t)

	proj, err := svc.st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatalf("CreateProject: %v", err)
	}
	se, err := svc.CreateSession(proj.ID, "t", "no-such-harness", false, "", nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if se.Harness != harness.DefaultID {
		t.Fatalf("unknown id must fall back to default, got %q", se.Harness)
	}
	rows, err := svc.st.ListUserHarnesses(svc.ctx)
	if err != nil {
		t.Fatalf("ListUserHarnesses: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("no user row should exist, got %+v", rows)
	}
}

// TestAddHarness_CatalogHitKeepsPlainID 手动添加撞目录命中项:目录版保住裸 id,
// 手动项消歧成 -2;列表无重复 id。
func TestAddHarness_CatalogHitKeepsPlainID(t *testing.T) {
	resetUserHarnessesForTest(t)
	kh := catalogTestHarness(t)
	svc := setupHarnessStoreSvc(t)

	// 预热发现缓存:mdcatgoose 以 Source=catalog 出现在列表里。
	discovered := harness.Discover(svc.ctx)
	svc.harnessCache.Store(&discovered)

	list, err := svc.AddHarness("mdcatgoose acp", "Manual Goose")
	if err != nil {
		t.Fatalf("AddHarness: %v", err)
	}

	// 去重断言:无重复 id;目录条目(UserDefined=false)+ 手动条目(-2,UserDefined=true)并存。
	seen := map[string]int{}
	var catalogEntry, manualEntry *harness.Harness
	for i := range list {
		seen[list[i].ID]++
		switch {
		case list[i].ID == kh.ID:
			catalogEntry = &list[i]
		case list[i].ID == kh.ID+"-2":
			manualEntry = &list[i]
		}
	}
	for id, n := range seen {
		if n > 1 {
			t.Fatalf("duplicate id %q in list: %+v", id, list)
		}
	}
	if catalogEntry == nil || catalogEntry.Source != harness.SourceCatalog || catalogEntry.UserDefined {
		t.Fatalf("catalog entry must keep the plain id untouched: %+v", catalogEntry)
	}
	if manualEntry == nil || !manualEntry.UserDefined {
		t.Fatalf("manual add must be disambiguated to -2: %+v", manualEntry)
	}

	// 落库断言:只有手动项这一行,目录命中项不落行。
	rows, err := svc.st.ListUserHarnesses(svc.ctx)
	if err != nil {
		t.Fatalf("ListUserHarnesses: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != kh.ID+"-2" {
		t.Fatalf("user rows = %+v, want only %s-2", rows, kh.ID)
	}
}
