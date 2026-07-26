package chat

// capability_test.go:ChatService 层的 harness 能力探测(probeCapabilitiesAsync /
// ListHarnessCapabilities / EventHarnessCapabilities)测试。
//
// 不真启 harness(§5.1):走 harness.Discover(注入 fakeStubProbe)+ acp.ProbeCapabilities
// 的 spawn 失败路径(不存在的二进制 → exec 报错 → 矩阵带 ProbeErr,静默降级)。
// 测的是「Discover 之后异步触发 probe → 缓存填充 + 事件下发」的编排,不是 ACP 细节
// (那部分在 internal/acp/capability_test.go)。

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/harness"
)

// TestListHarnessCapabilities_NilBeforeProbe 缓存未就绪时 ListHarnessCapabilities 返回 nil
// (前端据此显示「检测中」或不展示,不会拿到空 map 误判为「无能力」)。
func TestListHarnessCapabilities_NilBeforeProbe(t *testing.T) {
	svc := setupHarnessStoreSvc(t)
	if got := svc.ListHarnessCapabilities(); got != nil {
		t.Fatalf("ListHarnessCapabilities before probe = %v, want nil", got)
	}
}

// TestProbeCapabilitiesAsync_NoInstalledHarnesses harnessCache 全为未安装时,probeCapabilitiesAsync
// 是无操作:不填缓存、不发事件(避免无意义 spawn)。
func TestProbeCapabilitiesAsync_NoInstalledHarnesses(t *testing.T) {
	prevProbe := harness.SetProbeForTest(fakeStubProbe{}) // 空 paths:全部 LookPath 失败 → Installed=false
	t.Cleanup(prevProbe)
	prevReg := harness.SwapRegistryForTest([]harness.Spec{{ID: "testprobe", BinaryName: "testprobe"}})
	t.Cleanup(prevReg)

	svc := setupHarnessStoreSvc(t)
	svc.refreshHarnessesAsync() // 填 harnessCache(全部 Installed=false)

	var emitted atomic.Bool
	svc.emitHook = func(name string, _ any) {
		if name == EventHarnessCapabilities {
			emitted.Store(true)
		}
	}
	svc.probeCapabilitiesAsync()

	if emitted.Load() {
		t.Fatal("EventHarnessCapabilities 不应下发(无 Installed harness)")
	}
	if got := svc.ListHarnessCapabilities(); got != nil {
		t.Fatalf("capabilityCache 不应被填充(无 Installed harness),got %v", got)
	}
}

// TestProbeCapabilitiesAsync_NoCache 未 Discover(harnessCache nil)时直接 no-op,不 panic。
func TestProbeCapabilitiesAsync_NoCache(t *testing.T) {
	svc := setupHarnessStoreSvc(t)
	// 不调 refreshHarnessesAsync:harnessCache 保持 nil。
	svc.probeCapabilitiesAsync() // 应直接返回,不 panic
	if got := svc.ListHarnessCapabilities(); got != nil {
		t.Fatalf("capabilityCache 应为 nil,got %v", got)
	}
}

// TestProbeCapabilitiesAsync_ProbesInstalledAndEmits 端到端:Discover 标记某 harness Installed
// → probeCapabilitiesAsync 对它 spawn probe(spawn 失败因二进制不存在)→ 矩阵带 ProbeErr 入缓存
// + 下发 EventHarnessCapabilities。验证「Discover 之后异步触发」的编排成立。
func TestProbeCapabilitiesAsync_ProbesInstalledAndEmits(t *testing.T) {
	// fakeStubProbe 让 Discover 把 "testprobe" 标记为 Installed(给个假 path);
	// Supported 不含 "testprobe",Discover 给它回退 Command "testprobe acp"——
	// 该命令在 PATH 里不存在 → probeCapabilitiesAsync 内部 spawn 必失败 → 矩阵带 ProbeErr。
	prevProbe := harness.SetProbeForTest(fakeStubProbe{
		paths: map[string]string{"testprobe": "/fake/testprobe"},
	})
	t.Cleanup(prevProbe)
	prevReg := harness.SwapRegistryForTest([]harness.Spec{{ID: "testprobe", BinaryName: "testprobe"}})
	t.Cleanup(prevReg)

	svc := setupHarnessStoreSvc(t)
	svc.refreshHarnessesAsync() // 填 harnessCache(testprobe Installed=true)

	var emitted atomic.Bool
	svc.emitHook = func(name string, _ any) {
		if name == EventHarnessCapabilities {
			emitted.Store(true)
		}
	}
	svc.probeCapabilitiesAsync()

	if !emitted.Load() {
		t.Fatal("EventHarnessCapabilities 应在 probe 完成后下发")
	}
	got := svc.ListHarnessCapabilities()
	if got == nil {
		t.Fatal("capabilityCache 应已填充")
	}
	m, ok := got["testprobe"]
	if !ok {
		t.Fatalf("capabilityCache 应含 testprobe,got=%v", got)
	}
	if m.HarnessID != "testprobe" {
		t.Fatalf("HarnessID=%q, want testprobe", m.HarnessID)
	}
	if m.ProbeErr == "" {
		t.Fatalf("ProbeErr 应非空(spawn 应失败——二进制不存在)")
	}
}

// TestProbeCapabilitiesAsync_MergesPreservingAbsentEntries 后续 probe 的 installed 集合不含
// 某历史项时,该历史项应保留在缓存里(不因本次没 probe 就抹掉)——避免 harness 临时未装
// 就丢失之前已探测的能力位。
func TestProbeCapabilitiesAsync_MergesPreservingAbsentEntries(t *testing.T) {
	// 预填一个历史探测结果(模拟上轮 probe 的产物)。
	stale := map[string]acp.CapabilityMatrix{
		"other-harness": {HarnessID: "other-harness", SessionList: true, ProbedAt: time.Now()},
	}
	svc := setupHarnessStoreSvc(t)
	svc.capabilityCache.Store(&stale)

	// 本轮 probe 只含 "testprobe"(Installed);"other-harness" 不在 installed 集合里。
	prevProbe := harness.SetProbeForTest(fakeStubProbe{
		paths: map[string]string{"testprobe": "/fake/testprobe"},
	})
	t.Cleanup(prevProbe)
	prevReg := harness.SwapRegistryForTest([]harness.Spec{{ID: "testprobe", BinaryName: "testprobe"}})
	t.Cleanup(prevReg)

	svc.refreshHarnessesAsync()
	svc.probeCapabilitiesAsync()

	got := svc.ListHarnessCapabilities()
	if got == nil {
		t.Fatal("capabilityCache 应已填充")
	}
	// 历史项应保留(未被抹掉)。
	if _, ok := got["other-harness"]; !ok {
		t.Fatalf("历史项 other-harness 应保留在缓存里,got=%v", got)
	}
	// 本轮 probe 项应存在。
	if _, ok := got["testprobe"]; !ok {
		t.Fatalf("本轮 probe 项 testprobe 应在缓存里,got=%v", got)
	}
}

// TestProbeWorkDirCreated probeCapabilitiesAsync 会创建 CachesDir/probe 目录(spawn 需要 cwd 存在)。
// 验证目录确实被建出来(否则后续真实 probe 会因 cwd 不存在失败)。
func TestProbeWorkDirCreated(t *testing.T) {
	prevProbe := harness.SetProbeForTest(fakeStubProbe{
		paths: map[string]string{"testprobe": "/fake/testprobe"},
	})
	t.Cleanup(prevProbe)
	prevReg := harness.SwapRegistryForTest([]harness.Spec{{ID: "testprobe", BinaryName: "testprobe"}})
	t.Cleanup(prevReg)

	svc := setupHarnessStoreSvc(t)
	svc.refreshHarnessesAsync()
	svc.probeCapabilitiesAsync()

	// probe 目录应在 CachesDir 下被创建。
	probeDir := filepath.Join(svc.cfg.CachesDir, "probe")
	if _, err := os.Stat(probeDir); err != nil {
		t.Fatalf("probe workDir 未被创建: %v (dir=%s)", err, probeDir)
	}
}
