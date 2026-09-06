package harness

// catalog_discover_test.go:Discover 阶段 4 的 KnownCatalog PATH 探测测试(#187)。
//
// 三态:LookPath 命中(Installed=true 入列表)/ 未命中(不出现)/ 撞车去重(已有条目优先,
// 目录条目跳过);--version 失败静默(Installed 保持 true,版本空)。
// 不真起子进程(§5.1):复用 fakeProbe2(map 注入的伪 PATH)。
//
// KnownCatalog 是包级全局:swapCatalogForTest 换入合成目录 + t.Cleanup 还原,
// 不依赖 knownSeed 内容(测试对种子变化免疫)。

import (
	"context"
	"testing"
)

// swapCatalogForTest 替换全局 KnownCatalog 并在测试结束还原(t.Cleanup)。
func swapCatalogForTest(t *testing.T, cat []KnownHarness) {
	t.Helper()
	prev := KnownCatalog
	KnownCatalog = cat
	t.Cleanup(func() { KnownCatalog = prev })
}

// findHarnessByID 在 Discover 结果里按 id 找条目(nil = 不在列表)。
func findHarnessByID(list []Harness, id string) *Harness {
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

// TestDiscover_CatalogHit hit with a pinned ACPCommand (#196): the catalog entry
// is appended after the Registry results, Installed=true + Source=catalog marker,
// and Command carries the verified ACP entry — NOT the "<BinaryName> acp" default.
func TestDiscover_CatalogHit(t *testing.T) {
	prevProbe := currentProbe()
	t.Cleanup(func() { SetProbe(prevProbe) })
	swapCatalogForTest(t, []KnownHarness{
		{ID: "mdcatgoose", Name: "Catalog Goose", BinaryName: "mdcatgoose", Keywords: []string{"mdcatgoose"}, ACPCommand: "mdgoose-acp"},
	})
	SetProbe(fakeProbe2{
		paths: map[string]string{"mdcatgoose": "/fake/bin/mdcatgoose"},
		vers:  map[string]string{"mdcatgoose": "mdcatgoose version 2.1.0\n"},
	})

	out := Discover(context.Background())
	got := findHarnessByID(out, "mdcatgoose")
	if got == nil {
		t.Fatalf("catalog hit missing from Discover result: %+v", out)
	}
	// 追加在 Registry 结果之后(目录条目永远在尾部)。
	if out[len(out)-1].ID != "mdcatgoose" {
		t.Fatalf("catalog entry must be appended last, got tail: %+v", out[len(out)-1])
	}
	if !got.Installed || got.Path != "/fake/bin/mdcatgoose" {
		t.Fatalf("hit must be Installed with Path: %+v", got)
	}
	if got.Source != SourceCatalog {
		t.Fatalf("Source = %q, want %q", got.Source, SourceCatalog)
	}
	if got.InstalledVersion != "2.1.0" {
		t.Fatalf("InstalledVersion = %q, want 2.1.0", got.InstalledVersion)
	}
	if got.Command != "mdgoose-acp" {
		t.Fatalf("Command = %q, want the pinned ACPCommand", got.Command)
	}
	if got.NeedsAdapter {
		t.Fatalf("pinned ACPCommand must not set NeedsAdapter: %+v", got)
	}
	if got.Name != "Catalog Goose" {
		t.Fatalf("Name = %q, want Catalog Goose", got.Name)
	}
	// 目录条目无 Spec:不进升级链(LatestVersion/UpgradeAvailable 恒零),非用户条目。
	if got.LatestVersion != "" || got.UpgradeAvailable || got.UserDefined {
		t.Fatalf("catalog entry must be inert: %+v", got)
	}
}

// TestDiscover_CatalogHitWithoutACPCommandGray hit WITHOUT a pinned ACPCommand
// (#196): the entry stays listed (discovery info is kept, not silently dropped) —
// Installed=true, Source=catalog — but Command falls back to the conventional
// "<BinaryName> acp" and NeedsAdapter flags the missing ACP channel for the UI
// (gray + non-selectable).
func TestDiscover_CatalogHitWithoutACPCommandGray(t *testing.T) {
	prevProbe := currentProbe()
	t.Cleanup(func() { SetProbe(prevProbe) })
	swapCatalogForTest(t, []KnownHarness{
		{ID: "mdcatgoose", Name: "Catalog Goose", BinaryName: "mdcatgoose", Keywords: []string{"mdcatgoose"}},
	})
	SetProbe(fakeProbe2{
		paths: map[string]string{"mdcatgoose": "/fake/bin/mdcatgoose"},
		vers:  map[string]string{"mdcatgoose": "mdcatgoose version 2.1.0\n"},
	})

	out := Discover(context.Background())
	got := findHarnessByID(out, "mdcatgoose")
	if got == nil {
		t.Fatalf("no-ACP-channel hit must stay listed: %+v", out)
	}
	if !got.Installed || got.Source != SourceCatalog {
		t.Fatalf("hit must stay Installed with the catalog marker: %+v", got)
	}
	if got.Command != "mdcatgoose acp" {
		t.Fatalf("Command = %q, want the conventional fallback", got.Command)
	}
	if !got.NeedsAdapter {
		t.Fatalf("missing ACPCommand must set NeedsAdapter: %+v", got)
	}
}

// TestDiscover_CatalogMissNotListed 未命中:二进制不在(伪)PATH → 目录项不出现。
func TestDiscover_CatalogMissNotListed(t *testing.T) {
	prevProbe := currentProbe()
	t.Cleanup(func() { SetProbe(prevProbe) })
	swapCatalogForTest(t, []KnownHarness{
		{ID: "mdcatgoose", Name: "Catalog Goose", BinaryName: "mdcatgoose", Keywords: []string{"mdcatgoose"}},
	})
	SetProbe(fakeProbe2{paths: map[string]string{}, vers: map[string]string{}})

	out := Discover(context.Background())
	if got := findHarnessByID(out, "mdcatgoose"); got != nil {
		t.Fatalf("catalog miss must not appear in list, got: %+v", got)
	}
}

// TestDiscover_CatalogVersionFailureSilent --version 失败静默:Installed 保持 true,
// 版本空(增强非门控),不影响入列。
func TestDiscover_CatalogVersionFailureSilent(t *testing.T) {
	prevProbe := currentProbe()
	t.Cleanup(func() { SetProbe(prevProbe) })
	swapCatalogForTest(t, []KnownHarness{
		{ID: "mdcatgoose", Name: "Catalog Goose", BinaryName: "mdcatgoose", Keywords: []string{"mdcatgoose"}},
	})
	// paths 有命中、vers 空 → fakeProbe2.Version 返 error。
	SetProbe(fakeProbe2{paths: map[string]string{"mdcatgoose": "/fake/bin/mdcatgoose"}})

	out := Discover(context.Background())
	got := findHarnessByID(out, "mdcatgoose")
	if got == nil {
		t.Fatal("catalog hit must stay listed even when --version fails")
	}
	if !got.Installed {
		t.Fatalf("Installed must stay true on version failure: %+v", got)
	}
	if got.InstalledVersion != "" {
		t.Fatalf("InstalledVersion = %q, want empty on version failure", got.InstalledVersion)
	}
}

// TestDiscover_CatalogYieldsToExistingID 撞车去重:目录项撞内置 / 用户 harness 已有 id
// → 已有条目优先,目录条目跳过(列表无重复 id,Source 标记不落在既有条目上)。
func TestDiscover_CatalogYieldsToExistingID(t *testing.T) {
	restoreUserHarnesses(t) // registers its own cleanup; call before SetUserHarnesses below
	prevProbe := currentProbe()
	prevReg := Registry
	t.Cleanup(func() {
		SetProbe(prevProbe)
		Registry = prevReg
	})
	swapCatalogForTest(t, []KnownHarness{
		// 撞用户 harness id(junie)。
		{ID: "junie", Name: "Catalog Junie", BinaryName: "junie", Keywords: []string{"junie"}},
		// 撞内置 id(omp)——正常种子不含内置,这里防御性覆盖守卫本身。
		{ID: "omp", Name: "Catalog Impostor", BinaryName: "omp", Keywords: []string{"omp"}},
	})
	SetProbe(fakeProbe2{
		paths: map[string]string{"junie": "/fake/junie", "omp": "/fake/omp"},
		vers:  map[string]string{"junie": "1.0.0", "omp": "9.9.9"},
	})
	Registry = []Spec{{ID: "omp", BinaryName: "omp"}}
	SetUserHarnesses([]UserHarness{{ID: "junie", Name: "Junie", Command: "junie acp"}})

	out := Discover(context.Background())

	// 用户 harness junie 赢:唯一一条,UserDefined,无 catalog 标记。
	junies := 0
	var junie *Harness
	for i := range out {
		if out[i].ID == "junie" {
			junies++
			junie = &out[i]
		}
	}
	if junies != 1 || junie == nil {
		t.Fatalf("junie must appear exactly once, got %d: %+v", junies, out)
	}
	if !junie.UserDefined || junie.Source != "" {
		t.Fatalf("existing user entry must win untouched: %+v", junie)
	}
	// 内置 omp 赢:唯一一条,无 catalog 标记,版本走 Registry Spec 路径。
	omps := 0
	var omp *Harness
	for i := range out {
		if out[i].ID == "omp" {
			omps++
			omp = &out[i]
		}
	}
	if omps != 1 || omp == nil {
		t.Fatalf("omp must appear exactly once, got %d: %+v", omps, out)
	}
	if omp.Source != "" || omp.InstalledVersion != "9.9.9" {
		t.Fatalf("builtin entry must win untouched: %+v", omp)
	}
}
