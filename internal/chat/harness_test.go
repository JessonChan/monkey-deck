package chat

// harness_test.go:ChatService 层的 harness 缓存 / 升级 / 事件行为测试。
// 不真启 harness(§5.1):走 harness.Discover(可注入 Probe/Source)+ harness.Upgrade(可注入 Upgrader)。

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/harness"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// stubUpgrader 测试用 Upgrader,捕获调用 + 返回预设错误。
type stubUpgrader struct {
	called atomic.Bool
	err    error
}

func (s *stubUpgrader) Upgrade(context.Context) error {
	s.called.Store(true)
	return s.err
}

// setupHarnessSvc 构造最小 ChatService(不开 store、不起 ServiceStartup),只测 harness 相关方法。
func setupHarnessSvc(t *testing.T) *ChatService {
	t.Helper()
	cfg := config.TestConfig(t.TempDir())
	svc := NewChatService(cfg)
	svc.ctx = context.Background()
	t.Cleanup(func() { _ = svc.ServiceShutdown() })
	return svc
}

// TestListHarnesses_StaticFallbackBeforeRefresh 缓存未就绪时 ListHarnesses 返回静态 Supported,
// 而不是空列表(前端启动时能继续选 harness,不会因为 discovery 慢而退化)。
func TestListHarnesses_StaticFallbackBeforeRefresh(t *testing.T) {
	svc := setupHarnessSvc(t)
	got := svc.ListHarnesses()
	if len(got) != len(harness.Supported) {
		t.Fatalf("ListHarnesses len=%d, want %d (static fallback)", len(got), len(harness.Supported))
	}
	// 静态项不含运行时字段(Installed/Path 等)。
	for _, h := range got {
		if h.Installed || h.Path != "" || h.InstalledVersion != "" {
			t.Fatalf("static fallback should not include runtime fields: %+v", h)
		}
	}
}

// TestRefreshHarnesses_UpdatesCacheAndEmits RefreshHarnesses 写缓存 + 发 EventHarnesses 事件 + 返回 enriched 列表。
func TestRefreshHarnesses_UpdatesCacheAndEmits(t *testing.T) {
	prevProbe := harness.SetProbeForTest(fakeStubProbe{
		paths: map[string]string{"opencode": "/fake/bin/opencode"},
		vers:  map[string]string{"opencode": "opencode version 1.4.0"},
	})
	t.Cleanup(prevProbe)

	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode"},
	})
	t.Cleanup(prevReg)

	svc := setupHarnessSvc(t)
	var emitCalled atomic.Bool
	svc.emitHook = func(name string, _ any) {
		if name == EventHarnesses {
			emitCalled.Store(true)
		}
	}

	got, err := svc.RefreshHarnesses()
	if err != nil {
		t.Fatalf("RefreshHarnesses err=%v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d entries, want 1", len(got))
	}
	if !got[0].Installed || got[0].Path != "/fake/bin/opencode" || got[0].InstalledVersion != "1.4.0" {
		t.Fatalf("RefreshHarnesses result not enriched: %+v", got[0])
	}
	if !emitCalled.Load() {
		t.Fatalf("EventHarnesses not emitted")
	}

	// 缓存后:ListHarnesses 返回 enriched(不是静态)。
	got2 := svc.ListHarnesses()
	if !got2[0].Installed {
		t.Fatalf("ListHarnesses after refresh should return cached enriched list")
	}
}

// TestUpgradeHarness_CallsUpgraderAndRefreshes UpgradeHarness 调用 Registry 配置的 Upgrader,
// 升级后重发现(版本应已变),返回新列表 + 把错误塞进对应字段。
func TestUpgradeHarness_CallsUpgraderAndRefreshes(t *testing.T) {
	up := &stubUpgrader{}

	prevProbe := harness.SetProbeForTest(fakeStubProbe{
		paths: map[string]string{"opencode": "/fake/bin/opencode"},
		vers:  map[string]string{"opencode": "opencode version 1.5.0"}, // 升级后的版本
	})
	t.Cleanup(prevProbe)
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode", Upgrader: up},
	})
	t.Cleanup(prevReg)

	svc := setupHarnessSvc(t)
	got, err := svc.UpgradeHarness("opencode")
	if err != nil {
		t.Fatalf("UpgradeHarness err=%v, want nil (stubUpgrader returns nil)", err)
	}
	if !up.called.Load() {
		t.Fatalf("configured Upgrader.Upgrade not called")
	}
	if !got[0].Installed || got[0].InstalledVersion != "1.5.0" {
		t.Fatalf("UpgradeHarness result should reflect re-discovery: %+v", got[0])
	}
}

// TestUpgradeHarness_PropagatesError 未配置 Upgrader → ErrUpgraderNotConfigured,
// 返回列表 + 错误塞进 UpgradeError 字段(前端展示具体原因,而非吞错)。
func TestUpgradeHarness_PropagatesError(t *testing.T) {
	prevReg := harness.SwapRegistryForTest([]harness.Spec{
		{ID: "opencode", BinaryName: "opencode"}, // 无 Upgrader
	})
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessSvc(t)
	got, err := svc.UpgradeHarness("opencode")
	if !errors.Is(err, harness.ErrUpgraderNotConfigured) {
		t.Fatalf("err=%v, want ErrUpgraderNotConfigured", err)
	}
	if got[0].UpgradeError == "" {
		t.Fatalf("UpgradeError should be populated on failure")
	}
}

// TestUpgradeHarness_UnknownHarness 未知 id 同样走「未配置」错误,不崩。
func TestUpgradeHarness_UnknownHarness(t *testing.T) {
	prevReg := harness.SwapRegistryForTest(nil)
	t.Cleanup(prevReg)
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)

	svc := setupHarnessSvc(t)
	if _, err := svc.UpgradeHarness("bogus"); !errors.Is(err, harness.ErrUpgraderNotConfigured) {
		t.Fatalf("err=%v, want ErrUpgraderNotConfigured for unknown id", err)
	}
}

// fakeStubProbe 测试 Probe(本测试包内),纯字段映射。
type fakeStubProbe struct {
	paths map[string]string
	vers  map[string]string
}

func (f fakeStubProbe) LookPath(bin string) (string, error) {
	if p, ok := f.paths[bin]; ok {
		return p, nil
	}
	return "", errFakeNotFound
}
func (f fakeStubProbe) Version(_ context.Context, bin string, _ []string) (string, error) {
	for b, p := range f.paths {
		if p == bin {
			if v, ok := f.vers[b]; ok {
				// 用 harness 内部 extractVersion 解析(同 defaultProbe 一致行为)。
				return harness.ExtractVersionForTest(v), nil
			}
		}
	}
	return "", errFakeNotFound
}

var errFakeNotFound = errors.New("fake probe: not found")

// ─── check_harness_updates 设置开关 + 周期刷新 ticker ──────────────────────────

// setupHarnessStoreSvc 构造带 store 的 ChatService(可读写 settings),不起 ServiceStartup。
// 周期刷新间隔设为 0(默认不启 ticker),由具体测试按需注入短间隔。
func setupHarnessStoreSvc(t *testing.T) *ChatService {
	t.Helper()
	dir := t.TempDir()
	st, err := store.New(filepath.Join(dir, config.AppSlug+".db"))
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	cfg := config.TestConfig(dir)
	svc := NewChatService(cfg)
	svc.ctx = context.Background()
	svc.st = st
	t.Cleanup(func() { _ = svc.ServiceShutdown() })
	return svc
}

// TestSettingBool 校验 setting 字符串 → bool 解析(空/未知按默认)。
func TestSettingBool(t *testing.T) {
	cases := []struct {
		in   string
		def  bool
		want bool
	}{
		{"true", false, true}, {"TRUE", false, true}, {"1", false, true},
		{"on", false, true}, {"yes", false, true},
		{"false", true, false}, {"0", true, false}, {"off", true, false},
		{"no", true, false},
		{"", true, true}, {"", false, false}, // 空 → def
		{"garbage", true, true}, {"garbage", false, false}, // 未知 → def
	}
	for _, c := range cases {
		if got := settingBool(c.in, c.def); got != c.want {
			t.Errorf("settingBool(%q, def=%v) = %v, want %v", c.in, c.def, got, c.want)
		}
	}
}

// TestGetCheckHarnessUpdates_DefaultTrue 缺省(setting 未写)时默认开启,与 ServiceStartup 默认一致。
func TestGetCheckHarnessUpdates_DefaultTrue(t *testing.T) {
	svc := setupHarnessStoreSvc(t)
	if !svc.GetCheckHarnessUpdates() {
		t.Fatalf("GetCheckHarnessUpdates default = false, want true")
	}
	// GetConfig 也应暴露该字段且为 "true"。
	cfg := svc.GetConfig()
	if cfg["checkHarnessUpdates"] != "true" {
		t.Fatalf("GetConfig.checkHarnessUpdates = %q, want %q", cfg["checkHarnessUpdates"], "true")
	}
}

// TestSetCheckHarnessUpdates_PersistsAndReadsBack SetCheckHarnessUpdates(false) 持久化,
// GetCheckHarnessUpdates / GetConfig 读回 false;再设回 true 读回 true。
func TestSetCheckHarnessUpdates_PersistsAndReadsBack(t *testing.T) {
	svc := setupHarnessStoreSvc(t)
	// 设短间隔避免 SetCheckHarnessUpdates(true) 起真实长周期 ticker 干扰(此处只验设置读写)。
	svc.harnessRefreshEvery = 0

	if err := svc.SetCheckHarnessUpdates(false); err != nil {
		t.Fatalf("SetCheckHarnessUpdates(false): %v", err)
	}
	if svc.GetCheckHarnessUpdates() {
		t.Fatalf("after set false, GetCheckHarnessUpdates = true, want false")
	}
	if got := svc.GetConfig()["checkHarnessUpdates"]; got != "false" {
		t.Fatalf("GetConfig.checkHarnessUpdates = %q, want false", got)
	}
	// 再设回 true。
	if err := svc.SetCheckHarnessUpdates(true); err != nil {
		t.Fatalf("SetCheckHarnessUpdates(true): %v", err)
	}
	if !svc.GetCheckHarnessUpdates() {
		t.Fatalf("after set true, GetCheckHarnessUpdates = false, want true")
	}
}

// TestHarnessRefreshTicker_RunsPeriodically 周期 ticker 启用后确实周期性跑 refreshHarnessesAsync
// (EventHarnesses 事件被多次触发),关闭 SetCheckHarnessUpdates(false) 后不再触发。
// 隔离网络:注入空 Probe + 空 Registry,Discover 不打 GitHub。
func TestHarnessRefreshTicker_RunsPeriodically(t *testing.T) {
	prevProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(prevProbe)
	prevReg := harness.SwapRegistryForTest([]harness.Spec{{ID: "opencode", BinaryName: "opencode"}}) // 无 Source,不打网络
	t.Cleanup(prevReg)

	svc := setupHarnessStoreSvc(t)
	svc.harnessRefreshEvery = 15 * time.Millisecond // 短间隔加速

	var emits atomic.Int64
	svc.emitHook = func(name string, _ any) {
		if name == EventHarnesses {
			emits.Add(1)
		}
	}

	// 开启 → 起 ticker;等至少 3 次 tick。
	if err := svc.SetCheckHarnessUpdates(true); err != nil {
		t.Fatalf("SetCheckHarnessUpdates(true): %v", err)
	}
	waitFor(t, 2*time.Second, func() bool { return emits.Load() >= 3 })

	// 关闭 → 停 ticker;记录当前计数,等一段后确认不再增长。
	before := emits.Load()
	if err := svc.SetCheckHarnessUpdates(false); err != nil {
		t.Fatalf("SetCheckHarnessUpdates(false): %v", err)
	}
	time.Sleep(80 * time.Millisecond) // > 5 个 tick 周期
	if got := emits.Load(); got != before {
		t.Fatalf("after disable, emits grew %d → %d, want stop", before, got)
	}
}

// TestHarnessRefreshToggle_Idempotent 多次 start/stop 不 panic、不泄漏(等待落定)。
func TestHarnessRefreshToggle_Idempotent(t *testing.T) {
	svc := setupHarnessStoreSvc(t)
	svc.harnessRefreshEvery = 50 * time.Millisecond

	// 双重 start 幂等。
	svc.startHarnessRefresh()
	svc.startHarnessRefresh()
	// 双重 stop 幂等。
	svc.stopHarnessRefresh()
	svc.stopHarnessRefresh()
	// 再开再关一轮。
	svc.startHarnessRefresh()
	svc.stopHarnessRefresh()
}

// waitFor 轮询直到 cond 返回 true 或超时(周期 ticker 的确定性等待)。
func waitFor(t *testing.T, max time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", max)
}
