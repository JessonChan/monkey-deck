package chat

// harness_test.go:ChatService 层的 harness 缓存 / 升级 / 事件行为测试。
// 不真启 harness(§5.1):走 harness.Discover(可注入 Probe/Source)+ harness.Upgrade(可注入 Upgrader)。

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/harness"
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
