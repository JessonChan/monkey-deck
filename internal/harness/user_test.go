package harness

import (
	"context"
	"testing"
)

// restoreUserHarnesses 还原 userHarnessesHolder(t.Cleanup 自动注册)。
// 避免上一个测试的 user 列表污染下一个(全局状态,测试串行但须自洁)。
func restoreUserHarnesses(t *testing.T) {
	t.Helper()
	prev := UserHarnesses()
	t.Cleanup(func() { SetUserHarnesses(prev) })
}

// 注:user harness 的持久化(JSON 落盘)测试已随持久化层迁移到 SQLite(store 包)删除。
// harness 包不再做 I/O,只持有内存合并视图;CRUD 落库由 store.UserHarness 测试覆盖。

// TestEffectiveSupportedMerge 校验合并视图:静态优先 + 用户追加 + 按 ID 去重(静态赢,用户覆盖无效)。
func TestEffectiveSupportedMerge(t *testing.T) {
	restoreUserHarnesses(t)
	SetUserHarnesses([]UserHarness{
		{ID: "junie", Name: "Junie", Command: "junie acp"},
		{ID: "omp", Name: "ShouldBeDropped", Command: "ignored"}, // 与静态冲突 → 去重丢弃(静态赢)
		{ID: "goose", Name: "Goose", Command: "goose acp", Icon: "x.svg"},
	})
	got := effectiveSupported()
	// 静态全部在前,顺序不变。
	if got[0].ID != "omp" || got[1].ID != "opencode" {
		t.Fatalf("static must come first unchanged: %+v", got)
	}
	if got[0].Name != "Oh My Pi" {
		t.Fatalf("static omp must keep its name, got %q (user override must not win)", got[0].Name)
	}
	byID := map[string]Harness{}
	for _, h := range got {
		byID[h.ID] = h
	}
	if byID["junie"].Name != "Junie" || byID["junie"].Command != "junie acp" {
		t.Fatalf("user junie missing/wrong: %+v", byID["junie"])
	}
	if byID["goose"].Icon != "x.svg" {
		t.Fatalf("user goose icon lost: %+v", byID["goose"])
	}
	if dup, ok := byID["ShouldBeDropped"]; ok {
		t.Fatalf("conflicting user entry must be dropped, got %+v", dup)
	}
}

// TestEffectiveRegistryMerge 校验用户 Spec 合并:BinaryName 取 command 首段,无 Source/Upgrader。
func TestEffectiveRegistryMerge(t *testing.T) {
	restoreUserHarnesses(t)
	SetUserHarnesses([]UserHarness{
		{ID: "junie", Name: "Junie", Command: "junie acp"},
		{ID: "goose", Name: "Goose", Command: "/usr/local/bin/goose --stdio acp"},
		{ID: "omp", Name: "dup", Command: "ignored"}, // 静态赢
	})
	reg := effectiveRegistry()
	byID := map[string]Spec{}
	for _, sp := range reg {
		byID[sp.ID] = sp
	}
	if _, ok := byID["junie"]; !ok {
		t.Fatalf("user spec junie missing")
	}
	if byID["junie"].BinaryName != "junie" {
		t.Fatalf("junie BinaryName = %q, want %q", byID["junie"].BinaryName, "junie")
	}
	if byID["junie"].Source != nil || byID["junie"].Upgrader != nil {
		t.Fatalf("user spec must have no Source/Upgrader, got %+v", byID["junie"])
	}
	// 多段 command:BinaryName 取首段。
	if byID["goose"].BinaryName != "/usr/local/bin/goose" {
		t.Fatalf("goose BinaryName = %q, want first token", byID["goose"].BinaryName)
	}
	// 静态 omp 保留 Source/Upgrader(不被用户空 Spec 覆盖)。
	if byID["omp"].Source == nil || byID["omp"].Upgrader == nil {
		t.Fatalf("static omp must keep Source/Upgrader, got %+v", byID["omp"])
	}
}

// TestDiscoverIncludesUserHarness 校验 Discover 在合并视图上跑:用户 harness 出现在结果里,
// 且 Source 为 nil → LatestVersion 空 → UpgradeAvailable 恒 false(用户 harness 不升级)。
// 复用 fakeProbe2(§5.1:不真起子进程)。
func TestDiscoverIncludesUserHarness(t *testing.T) {
	restoreUserHarnesses(t)
	restore := SetProbeForTest(fakeProbe2{
		paths: map[string]string{"junie": "/fake/junie"},
		vers:  map[string]string{"junie": "0.1.0"},
	})
	t.Cleanup(restore)

	SetUserHarnesses([]UserHarness{{ID: "junie", Name: "Junie", Command: "junie acp"}})
	got := Discover(context.Background())
	var junie *Harness
	for i := range got {
		if got[i].ID == "junie" {
			junie = &got[i]
			break
		}
	}
	if junie == nil {
		t.Fatalf("user harness junie missing from Discover result: %+v", got)
	}
	if !junie.Installed || junie.Path != "/fake/junie" || junie.InstalledVersion != "0.1.0" {
		t.Fatalf("user harness not discovered as installed: %+v", junie)
	}
	if junie.LatestVersion != "" || junie.UpgradeAvailable {
		t.Fatalf("user harness must not have upstream/upgrade: %+v", junie)
	}
	if junie.Name != "Junie" || junie.Command != "junie acp" {
		t.Fatalf("user harness static metadata lost: %+v", junie)
	}
}

// TestCommandsAndNormalizeIncludeUser 校验 Normalize/Command/Commands 在合并视图上识别用户 harness。
func TestCommandsAndNormalizeIncludeUser(t *testing.T) {
	restoreUserHarnesses(t)
	SetUserHarnesses([]UserHarness{{ID: "junie", Name: "Junie", Command: "junie acp"}})
	if got := Normalize("junie"); got != "junie" {
		t.Fatalf(`Normalize("junie")=%q, want "junie"`, got)
	}
	if got := Command("junie"); got != "junie acp" {
		t.Fatalf(`Command("junie")=%q, want "junie acp"`, got)
	}
	cmds := Commands()
	found := false
	for _, c := range cmds {
		if c == "junie acp" {
			found = true
		}
	}
	if !found {
		t.Fatalf("user command missing from Commands(): %+v", cmds)
	}
}
