package chat

// auto_upgrade_test.go:auto_harness_upgrade 设置 + maybeAutoUpgrade 行为单测。
//
// 覆盖:
//   - 设置缺省(默认关闭)+ 持久化往返。
//   - 自动关闭时 maybeAutoUpgrade 不触发 UpgradeHarness。
//   - 开启 + UpgradeAvailable + 无运行中进程 → 触发升级 + 成功清冷却。
//   - §5.3 运行中进程安全:有活跃 session 使用该 harness → 跳过(不升级运行中的 harness)。
//   - 失败冷却:首次失败置冷却,冷却期内不再重试;冷却到期后重试;成功清冷却。
//   - ticker OR 语义:check 关 + auto 开 → ticker 仍运行;二者皆关 → ticker 停。
//   - 端到端:周期 ticker tick → refreshHarnessesAsync(Discover 置 UpgradeAvailable)→ maybeAutoUpgrade 触发升级。
//
// 不真启 harness(§5.1):注入 Probe / Source / Upgrader(均 stub)。

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/harness"
)

// stubReleaseSource 测试用 ReleaseSource(chat test 包内),返回预设版本。
type stubReleaseSource struct {
	v   string
	err error
}

func (s stubReleaseSource) Latest(context.Context) (harness.Release, error) {
	if s.err != nil {
		return harness.Release{}, s.err
	}
	return harness.Release{Version: s.v}, nil
}

// cacheWithUpgrade 构造一个 UpgradeAvailable=true 的 harness 缓存(直接注入,免网络/免 Discover)。
// 供 maybeAutoUpgrade 的「读取缓存」路径用(safety / cooldown 测不需要真 Discover)。
func cacheWithUpgrade(id string) []harness.Harness {
	return []harness.Harness{{
		ID: id, Name: id, Command: id + " acp",
		Installed: true, InstalledVersion: "1.0.0", LatestVersion: "2.0.0",
		UpgradeAvailable: true,
	}}
}

// disableTicker 把 harnessRefreshEvery 置 0,使 syncHarnessRefreshTicker 起真实周期 ticker 失效
// (startHarnessRefresh 在 every<=0 时直接返回),避免后台 tick 干扰确定性断言。
func disableTicker(svc *ChatService) {
	svc.harnessRefreshEvery = 0
}

// ─── 设置缺省 + 持久化往返 ───────────────────────────────────────────────────

// TestGetAutoHarnessUpgrade_DefaultFalse 缺省默认关闭(跑官方安装脚本较重,显式开启)。
func TestGetAutoHarnessUpgrade_DefaultFalse(t *testing.T) {
	svc := setupHarnessStoreSvc(t)
	if svc.GetAutoHarnessUpgrade() {
		t.Fatalf("GetAutoHarnessUpgrade default = true, want false")
	}
	if got := svc.GetConfig()["autoHarnessUpgrade"]; got != "false" {
		t.Fatalf("GetConfig.autoHarnessUpgrade = %q, want %q", got, "false")
	}
}

// TestSetAutoHarnessUpgrade_PersistsAndReadsBack 往返:true→false→true 持久化 + 读回一致。
func TestSetAutoHarnessUpgrade_PersistsAndReadsBack(t *testing.T) {
	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)

	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	if !svc.GetAutoHarnessUpgrade() {
		t.Fatalf("after set true, GetAutoHarnessUpgrade = false, want true")
	}
	if got := svc.GetConfig()["autoHarnessUpgrade"]; got != "true" {
		t.Fatalf("GetConfig.autoHarnessUpgrade = %q, want true", got)
	}
	if err := svc.SetAutoHarnessUpgrade(false); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(false): %v", err)
	}
	if svc.GetAutoHarnessUpgrade() {
		t.Fatalf("after set false, GetAutoHarnessUpgrade = true, want false")
	}
}

// ─── maybeAutoUpgrade 核心行为 ──────────────────────────────────────────────

// TestMaybeAutoUpgrade_DisabledByDefault 自动升级关闭时,即使缓存里有 UpgradeAvailable 也不触发。
func TestMaybeAutoUpgrade_DisabledByDefault(t *testing.T) {
	up := &stubUpgrader{}
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: up},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)

	list := cacheWithUpgrade("opencode")
	svc.harnessCache.Store(&list)

	// 不开 auto。
	svc.maybeAutoUpgrade()
	if up.called.Load() {
		t.Fatalf("UpgradeHarness called while auto disabled")
	}
}

// TestMaybeAutoUpgrade_UpgradesAvailableHarness 开启 + UpgradeAvailable + 无运行中进程 → 触发升级,
// 成功后冷却为空。
func TestMaybeAutoUpgrade_UpgradesAvailableHarness(t *testing.T) {
	up := &stubUpgrader{}
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: up},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	list := cacheWithUpgrade("opencode")
	svc.harnessCache.Store(&list)

	svc.maybeAutoUpgrade()
	if !up.called.Load() {
		t.Fatalf("Upgrader.Upgrade not called (auto on, upgrade available, not in use)")
	}
	// 成功:无冷却残留。
	svc.mu.RLock()
	_, has := svc.autoUpgradeCooldown["opencode"]
	svc.mu.RUnlock()
	if has {
		t.Fatalf("cooldown should be empty after successful upgrade")
	}
}

// TestMaybeAutoUpgrade_SkipsRunningHarness §5.3 运行中进程安全:有活跃 session 使用该 harness → 跳过。
// 升级一个运行中的 harness 可能与进程冲突(Windows 无法覆写运行中 .exe / 官方脚本可能重启服务),
// 故先验证「无运行中进程」再动手。
func TestMaybeAutoUpgrade_SkipsRunningHarness(t *testing.T) {
	up := &stubUpgrader{}
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: up},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	list := cacheWithUpgrade("opencode")
	svc.harnessCache.Store(&list)

	// 模拟一个使用 opencode 的活跃 session(运行中进程)。
	svc.mu.Lock()
	svc.active["s1"] = &liveSession{chat: &mockChatConn{}, harnessID: "opencode", index: map[string]*turnEntry{}}
	svc.mu.Unlock()

	svc.maybeAutoUpgrade()
	if up.called.Load() {
		t.Fatalf("Upgrader.Upgrade should NOT be called while harness in use (running process safety)")
	}
	// 无冷却(没尝试过,不该记冷却)。
	svc.mu.RLock()
	_, has := svc.autoUpgradeCooldown["opencode"]
	svc.mu.RUnlock()
	if has {
		t.Fatalf("cooldown should not be set for a skipped (in-use) harness")
	}
}

// TestMaybeAutoUpgrade_DifferentHarnessInUse 只跳过「正被使用的那个」harness;
// 另一个无运行中进程的 harness 仍可升级。
func TestMaybeAutoUpgrade_DifferentHarnessInUse(t *testing.T) {
	upOpencode := &stubUpgrader{}
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: upOpencode},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	// omp 在用;opencode 可升级。
	cache := []harness.Harness{
		{ID: "opencode", Name: "opencode", Installed: true, InstalledVersion: "1.0.0", LatestVersion: "2.0.0", UpgradeAvailable: true},
		{ID: "omp", Name: "omp", Installed: true, InstalledVersion: "1.0.0", LatestVersion: "2.0.0", UpgradeAvailable: true},
	}
	svc.harnessCache.Store(&cache)
	svc.mu.Lock()
	svc.active["s1"] = &liveSession{chat: &mockChatConn{}, harnessID: "omp", index: map[string]*turnEntry{}}
	svc.mu.Unlock()

	svc.maybeAutoUpgrade()
	if !upOpencode.called.Load() {
		t.Fatalf("opencode (not in use) should be upgraded")
	}
}

// ─── 失败冷却 ───────────────────────────────────────────────────────────────

// TestMaybeAutoUpgrade_FailureCooldown 首次失败置冷却 → 冷却期内再次 maybeAutoUpgrade 不重试;
// 冷却到期后重试。
func TestMaybeAutoUpgrade_FailureCooldown(t *testing.T) {
	up := &stubUpgrader{err: errors.New("install failed")}
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: up},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)
	svc.autoUpgradeCooldownDur = time.Minute // 显式(避免依赖 NewChatService 默认)
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	list := cacheWithUpgrade("opencode")
	svc.harnessCache.Store(&list)

	// 第一次:失败 → upgrader 被调一次 + 冷却置位。
	svc.maybeAutoUpgrade()
	if !up.called.Load() {
		t.Fatalf("first attempt: Upgrader.Upgrade should be called")
	}
	svc.mu.RLock()
	until, has := svc.autoUpgradeCooldown["opencode"]
	svc.mu.RUnlock()
	if !has {
		t.Fatalf("cooldown should be set after failure")
	}
	if !until.After(time.Now()) {
		t.Fatalf("cooldown should be in the future, got %v", until)
	}

	// 第二次:冷却期内 → 不重试。先恢复缓存(UpgradeHarness 已用空 Probe 覆盖它),
	// 使「跳过」只能归因于冷却,而非缓存里 UpgradeAvailable=false(强断言)。
	list = cacheWithUpgrade("opencode")
	svc.harnessCache.Store(&list)
	up.called.Store(false)
	svc.maybeAutoUpgrade()
	if up.called.Load() {
		t.Fatalf("within cooldown: Upgrader.Upgrade should NOT be called")
	}

	// 第三次:手动把冷却置到过去(模拟到期)→ 重试。
	// 注意:前两次里的 UpgradeHarness 会经 Discover 覆写缓存(空 Probe → Installed=false →
	// UpgradeAvailable=false),故重置缓存恢复「可升级」态再测。
	svc.mu.Lock()
	svc.autoUpgradeCooldown["opencode"] = time.Now().Add(-time.Second)
	svc.mu.Unlock()
	list = cacheWithUpgrade("opencode")
	svc.harnessCache.Store(&list)
	up.called.Store(false)
	svc.maybeAutoUpgrade()
	if !up.called.Load() {
		t.Fatalf("after cooldown expired: Upgrader.Upgrade should be called again")
	}
}

// TestMaybeAutoUpgrade_SuccessClearsCooldown 升级成功清掉既有冷却。
func TestMaybeAutoUpgrade_SuccessClearsCooldown(t *testing.T) {
	up := &stubUpgrader{} // 成功
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: up},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	list := cacheWithUpgrade("opencode")
	svc.harnessCache.Store(&list)

	// 预置一个已到期的冷却(允许进 candidates);成功后应被清。
	svc.mu.Lock()
	svc.autoUpgradeCooldown["opencode"] = time.Now().Add(-time.Second)
	svc.mu.Unlock()

	svc.maybeAutoUpgrade()
	if !up.called.Load() {
		t.Fatalf("Upgrader.Upgrade should be called (cooldown expired)")
	}
	svc.mu.RLock()
	_, has := svc.autoUpgradeCooldown["opencode"]
	svc.mu.RUnlock()
	if has {
		t.Fatalf("cooldown should be cleared after successful upgrade")
	}
}

// TestMaybeAutoUpgrade_NoUpgradeAvailableNotAttempted UpgradeAvailable=false 的 harness 不被尝试升级。
func TestMaybeAutoUpgrade_NoUpgradeAvailableNotAttempted(t *testing.T) {
	up := &stubUpgrader{}
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: up},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	disableTicker(svc)
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	// 已是最新(UpgradeAvailable=false)。
	cache := []harness.Harness{{
		ID: "opencode", Installed: true, InstalledVersion: "1.0.0", LatestVersion: "1.0.0", UpgradeAvailable: false,
	}}
	svc.harnessCache.Store(&cache)

	svc.maybeAutoUpgrade()
	if up.called.Load() {
		t.Fatalf("Upgrader.Upgrade should NOT be called when no upgrade available")
	}
}

// ─── ticker OR 语义 ──────────────────────────────────────────────────────────

// TestRefreshTicker_OrLogic check 关 + auto 开 → ticker 仍运行(check 关不再单独决定停止);
// 二者皆关 → ticker 停。
func TestRefreshTicker_OrLogic(t *testing.T) {
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)
	prevReg := harness.SwapRegistryForTest([]harness.Spec{{ID: "opencode", BinaryName: "opencode"}})
	t.Cleanup(prevReg)

	svc := setupHarnessStoreSvc(t)
	svc.harnessRefreshEvery = 20 * time.Millisecond

	var emits atomic.Int64
	svc.emitHook = func(name string, _ any) {
		if name == EventHarnesses {
			emits.Add(1)
		}
	}

	// 关 check,开 auto → ticker 应仍运行(OR 语义)。
	if err := svc.SetCheckHarnessUpdates(false); err != nil {
		t.Fatalf("SetCheckHarnessUpdates(false): %v", err)
	}
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return emits.Load() >= 2 })

	// 再关 auto → 二者皆关 → ticker 停。
	before := emits.Load()
	if err := svc.SetAutoHarnessUpgrade(false); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(false): %v", err)
	}
	time.Sleep(100 * time.Millisecond) // > 5 个 tick
	if got := emits.Load(); got != before {
		t.Fatalf("after both off, emits grew %d → %d, want stop", before, got)
	}
}

// ─── 端到端:ticker tick → Discover 置 UpgradeAvailable → 自动升级 ──────────

// TestAutoUpgradeTicker_EndToEnd 周期 ticker 真触发自动升级:
// Probe 报本地 1.0.0、Source 报上游 2.0.0 → Discover 置 UpgradeAvailable →
// maybeAutoUpgrade 调 Upgrader。证明 ticker hook 端到端生效(不只是单测 maybeAutoUpgrade)。
func TestAutoUpgradeTicker_EndToEnd(t *testing.T) {
	up := &stubUpgrader{}
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{
			ID: "opencode", BinaryName: "opencode",
			Source:   stubReleaseSource{v: "2.0.0"},
			Upgrader: up,
		},
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{
		paths: map[string]string{"opencode": "/fake/bin/opencode"},
		vers:  map[string]string{"opencode": "1.0.0"}, // 本地旧版本
	})
	t.Cleanup(prevProbe)

	svc := setupHarnessStoreSvc(t)
	svc.harnessRefreshEvery = 20 * time.Millisecond

	// 开 auto(check 默认开,OR 语义下 ticker 会跑)。
	if err := svc.SetAutoHarnessUpgrade(true); err != nil {
		t.Fatalf("SetAutoHarnessUpgrade(true): %v", err)
	}

	// 等待 ticker 至少跑一轮(refresh + maybeAutoUpgrade)。
	waitFor(t, 3*time.Second, func() bool { return up.called.Load() })
}
