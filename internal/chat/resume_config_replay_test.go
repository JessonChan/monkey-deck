package chat

// resume_config_replay_test.go — #183 resume 配置重放的两层测试(§5.1:单测 mock 优先)。
//
// Layer 1 — unit (fakeChat, no real harness): the replayResumeConfigGaps
// contract — D2 replay-set computation (missing keys only / reported non-model
// keys win / model is value-difference driven per #183r), D3 call args
// (= snapshot current value), D4 per-key best-effort, anti tug-of-war
// (full resume → zero replay).
//
// Layer 2 — e2e(in-binary fake ACP agent,同 fork_fakeagent_test.go 的
// helper-process 模式):真实 startLive 的 resume 分支——重放发生在 emit +
// persist 尾巴之前(D1),FlatConfigOptions 与持久缓存恢复全量(D5 走既有
// set_config_option 持久管线,无手动回写);set 全失败时 session 照常打开、
// 缓存保持 model-only 现状(D4/D5)。

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/harness"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// resumeSnapshot is the persisted full config snapshot a session would have
// after the user picked thought/mode: model + thought_level + mode, each with a
// current value. Order defines replay order (D3: per-key, snapshot order).
func resumeSnapshot() []acp.ConfigOption {
	entry := func(value, name string) acp.ConfigOptionEntry {
		return acp.ConfigOptionEntry{Value: value, Name: name}
	}
	return []acp.ConfigOption{
		{ID: "model", Name: "Model", Category: "model", CurrentValue: "fake-model",
			Options: []acp.ConfigOptionEntry{entry("fake-model", "Fake Model")}},
		{ID: "thought", Name: "Thought", Category: "thought_level", CurrentValue: "high",
			Options: []acp.ConfigOptionEntry{entry("high", "High"), entry("low", "Low")}},
		{ID: "mode", Name: "Mode", Category: "mode", CurrentValue: "code",
			Options: []acp.ConfigOptionEntry{entry("code", "Code"), entry("plan", "Plan")}},
	}
}

// modelOnlyResume mirrors the real-omp session/resume response shape: the model
// option only — thought/mode dropped (the #183 root cause). The model's
// currentValue equals the cache (omp self-recovers), so under the #183r
// value-difference rule it is naturally skipped, not suppressed by key-hit.
func modelOnlyResume() []acp.ConfigOption {
	return []acp.ConfigOption{resumeSnapshot()[0]}
}

func seedConfigCache(t *testing.T, svc *ChatService, sessionID string, opts []acp.ConfigOption) {
	t.Helper()
	b, err := json.Marshal(opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.st.UpdateSessionConfigOptionsCache(svc.ctx, sessionID, string(b)); err != nil {
		t.Fatal(err)
	}
}

func recordedSets(fc *fakeChat) []string {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return append([]string{}, fc.configSets...)
}

// TestResumeConfigReplayRestoresMissingKeys (D7 场景一,unit):resume 只回 model →
// 缺失键按快照当前值逐键重放;FlatConfigOptions 恢复全量;helper 本身不回写缓存(D5)。
func TestResumeConfigReplayRestoresMissingKeys(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	seedConfigCache(t, svc, sid, resumeSnapshot())
	fc := newFakeChat()
	fc.configOpts = modelOnlyResume() // session/resume 报了 model,丢了 thought/mode

	svc.replayResumeConfigGaps(fc, sid)

	// D2/D3: replay set is exactly the missing keys, args = snapshot current
	// values, order = snapshot order; model reported with its cached value → skipped.
	want := []string{"thought=high", "mode=code"}
	if got := recordedSets(fc); !reflect.DeepEqual(got, want) {
		t.Fatalf("replay calls = %v, want %v", got, want)
	}
	// FlatConfigOptions(emit 数据源)恢复全量、值为快照当前值。
	byID := map[string]string{}
	for _, o := range fc.FlatConfigOptions() {
		byID[o.ID] = o.CurrentValue
	}
	if byID["model"] != "fake-model" || byID["thought"] != "high" || byID["mode"] != "code" {
		t.Fatalf("FlatConfigOptions not restored to full snapshot: %v", byID)
	}
	// D5:重放层不手动回写缓存——缓存修正属于 startLive 尾部的既有持久管线。
	cached, err := svc.GetSessionCachedConfigOptions(sid)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached) != 3 {
		t.Fatalf("replay must not touch the persisted cache itself, got %d entries", len(cached))
	}
}

// TestResumeConfigReplayFailureIsBestEffort (D7 场景二,unit):单键 set 失败 →
// slog warn 后继续下一键(D4),成功的键照常恢复。
func TestResumeConfigReplayFailureIsBestEffort(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	seedConfigCache(t, svc, sid, resumeSnapshot())
	fc := newFakeChat()
	fc.configOpts = modelOnlyResume()
	fc.failSet = map[string]bool{"thought": true} // 第一个重放键被 harness 拒绝

	svc.replayResumeConfigGaps(fc, sid) // 不 panic、不外抛错误

	// 失败不阻断:两个键都被尝试(failSet 只挡状态更新,不挡调用序列)。
	want := []string{"thought=high", "mode=code"}
	if got := recordedSets(fc); !reflect.DeepEqual(got, want) {
		t.Fatalf("replay must try every missing key despite failures, got %v", got)
	}
	// 被拒键不进状态,成功键照常恢复。
	var restored []string
	for _, o := range fc.FlatConfigOptions() {
		restored = append(restored, o.ID+"="+o.CurrentValue)
	}
	if !reflect.DeepEqual(restored, []string{"model=fake-model", "mode=code"}) {
		t.Fatalf("post-replay state = %v, want model + restored mode only", restored)
	}
}

// TestResumeConfigReplayFullResumeNoReplay (D7 场景三,unit):resume 回全量 →
// 零重放调用(防拉锯)。
func TestResumeConfigReplayFullResumeNoReplay(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	seedConfigCache(t, svc, sid, resumeSnapshot())
	fc := newFakeChat()
	fc.configOpts = resumeSnapshot() // resume 自报全量

	svc.replayResumeConfigGaps(fc, sid)

	if sets := recordedSets(fc); len(sets) != 0 {
		t.Fatalf("full resume must not trigger any replay call (anti tug-of-war), got %v", sets)
	}
}

// TestResumeConfigReplayReportedKeyWinsOverSnapshot: the other anti tug-of-war
// side of D3 — a reported NON-model key wins over the snapshot even when the
// values differ (the harness owns its own session state; #183r made model the
// sole value-difference-driven exception).
func TestResumeConfigReplayReportedKeyWinsOverSnapshot(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	snap := resumeSnapshot()
	snap[1].CurrentValue = "low" // 快照说 thought=low
	seedConfigCache(t, svc, sid, snap)
	fc := newFakeChat()
	fc.configOpts = resumeSnapshot() // resume 响应说 thought=high

	svc.replayResumeConfigGaps(fc, sid)

	if sets := recordedSets(fc); len(sets) != 0 {
		t.Fatalf("resume-reported keys are authoritative and must never be re-set, got %v", sets)
	}
}

// TestResumeConfigReplayModelValueDiffReplays (#183r D2, unit): codebuddy
// resume shape (wire-verified: set glm-5.2, fresh-process resume still reports
// the hy3 default with the full options list) — the model option IS reported,
// but its currentValue differs from the cache and the cached value is still in
// the reported options list → replay set_config_option("model") with the
// cached value; missing thought/mode replay unchanged.
func TestResumeConfigReplayModelValueDiffReplays(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	snap := resumeSnapshot()
	snap[0].CurrentValue = "glm-5.2" // user picked a non-default model
	snap[0].Options = append(snap[0].Options, acp.ConfigOptionEntry{Value: "glm-5.2", Name: "GLM 5.2"})
	seedConfigCache(t, svc, sid, snap)
	fc := newFakeChat()
	reported := modelOnlyResume()
	reported[0].CurrentValue = "fake-model" // harness self-reports its default
	reported[0].Options = append(reported[0].Options, acp.ConfigOptionEntry{Value: "glm-5.2", Name: "GLM 5.2"})
	fc.configOpts = reported

	svc.replayResumeConfigGaps(fc, sid)

	// Model first (snapshot order) with the cached value as the set arg.
	want := []string{"model=glm-5.2", "thought=high", "mode=code"}
	if got := recordedSets(fc); !reflect.DeepEqual(got, want) {
		t.Fatalf("replay calls = %v, want %v (differing cached model must be replayed)", got, want)
	}
	// Post-replay state: the set value landed in FlatConfigOptions.
	byID := map[string]string{}
	for _, o := range fc.FlatConfigOptions() {
		byID[o.ID] = o.CurrentValue
	}
	if byID["model"] != "glm-5.2" {
		t.Fatalf("model state = %q, want glm-5.2 after replay", byID["model"])
	}
}

// TestResumeConfigReplayModelValueNotInListKeepsReported (#183r D2, unit): the
// cached model value is absent from the reported options list (delisted) →
// silent skip (warn log only): no set call for model, resume unaffected, and
// missing thought/mode replay unchanged (D5 semantics: never force an illegal set).
func TestResumeConfigReplayModelValueNotInListKeepsReported(t *testing.T) {
	svc, _, sid := newLazyTestService(t)
	seedConfigCache(t, svc, sid, resumeSnapshot()) // cached model = fake-model
	fc := newFakeChat()
	reported := modelOnlyResume()
	reported[0].CurrentValue = "fake-model-v2" // harness default, menu no longer lists fake-model
	reported[0].Options = []acp.ConfigOptionEntry{{Value: "fake-model-v2", Name: "Fake Model v2"}}
	fc.configOpts = reported

	svc.replayResumeConfigGaps(fc, sid)

	want := []string{"thought=high", "mode=code"}
	if got := recordedSets(fc); !reflect.DeepEqual(got, want) {
		t.Fatalf("replay calls = %v, want %v (delisted cached model must not be set)", got, want)
	}
}

// TestResumeConfigReplaySkipsNothingToRestore:D2/D3 边界——无缓存、纯 model 快照、
// 无有效选中值的快照项,都零重放(或跳过该项)。
func TestResumeConfigReplaySkipsNothingToRestore(t *testing.T) {
	t.Run("no cache", func(t *testing.T) {
		svc, _, sid := newLazyTestService(t) // 从未 spawn,无缓存
		fc := newFakeChat()
		fc.configOpts = modelOnlyResume()
		svc.replayResumeConfigGaps(fc, sid)
		if sets := recordedSets(fc); len(sets) != 0 {
			t.Fatalf("no snapshot → no replay, got %v", sets)
		}
	})
	t.Run("model-only snapshot", func(t *testing.T) {
		svc, _, sid := newLazyTestService(t)
		seedConfigCache(t, svc, sid, modelOnlyResume()) // model reported equal to cache → skipped (#183r value-difference rule)
		fc := newFakeChat()
		fc.configOpts = modelOnlyResume()
		svc.replayResumeConfigGaps(fc, sid)
		if sets := recordedSets(fc); len(sets) != 0 {
			t.Fatalf("model reported equal to cache must not be replayed, got %v", sets)
		}
	})
	t.Run("empty current value skipped", func(t *testing.T) {
		svc, _, sid := newLazyTestService(t)
		snap := resumeSnapshot()
		snap[1].CurrentValue = "" // thought 无有效选中值 → 跳过(D3)
		seedConfigCache(t, svc, sid, snap)
		fc := newFakeChat()
		fc.configOpts = modelOnlyResume()
		svc.replayResumeConfigGaps(fc, sid)
		want := []string{"mode=code"}
		if got := recordedSets(fc); !reflect.DeepEqual(got, want) {
			t.Fatalf("replay calls = %v, want %v (empty-value key skipped)", got, want)
		}
	})
}

// ---- Layer 2: real startLive resume branch against the in-binary fake agent ----

// newResumeFakeAgentSvc wires the full production resume path (ensureLive →
// startLive → spawn fakeagent → Initialize → session/resume) with the fake
// agent registered as a user harness. The session row is pinned to fake-sess-1
// and its config cache is seeded with the full snapshot, so ContinueSession
// takes the resume branch with something to restore.
func newResumeFakeAgentSvc(t *testing.T, setLog string) (*ChatService, *store.Session) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// NewRunner splits the command on whitespace (no quoting), so a test
	// binary path with spaces cannot be spawned.
	if strings.ContainsAny(exe, " \t") {
		t.Skipf("test binary path contains spaces: %s", exe)
	}
	t.Setenv("MD_CHAT_FAKE_AGENT_CHILD", "1")
	t.Setenv("MD_CHAT_FAKE_SET_LOG", setLog)

	cmd := fmt.Sprintf("%s -test.run=^TestChatForkFakeAgentHelper$ --", exe)
	prev := harness.UserHarnesses()
	harness.SetUserHarnesses(append(prev, harness.UserHarness{ID: "fakeresume", Name: "Fake Resume", Command: cmd}))
	t.Cleanup(func() { harness.SetUserHarnesses(prev) })

	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewChatService(config.TestConfig(t.TempDir()))
	svc.spawnFn = svc.startLive // REAL spawn path (ServiceStartup wires the same)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	svc.ctx = ctx
	svc.st = st
	t.Cleanup(cancel)
	t.Cleanup(func() { _ = svc.ServiceShutdown() })

	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err := st.CreateSession(svc.ctx, proj.ID, "resume replay", "", "fakeresume")
	if err != nil {
		t.Fatal(err)
	}
	// Pin the ACP session id so the open takes the resume path (§1.4).
	if err := st.UpdateSessionACP(svc.ctx, se.ID, "fake-sess-1", se.Title); err != nil {
		t.Fatal(err)
	}
	seedConfigCache(t, svc, se.ID, resumeSnapshot())
	return svc, se
}

// readSetLog parses the fake agent's received set_config_option trace; a missing
// file means zero attempts.
func readSetLog(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("read set log: %v", err)
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func assertFullSnapshotOptions(t *testing.T, opts []acp.ConfigOption) {
	t.Helper()
	byID := map[string]string{}
	for _, o := range opts {
		byID[o.ID] = o.CurrentValue
	}
	if byID["model"] != "fake-model" || byID["thought"] != "high" || byID["mode"] != "code" {
		t.Fatalf("config options not restored to full snapshot: %v", byID)
	}
}

// TestResumeConfigReplayFakeAgentRestoresFull (D7 场景一,e2e):resume 只回 model
// (真实 omp 形态)→ 缺失键被重放(调用参数 = 快照当前值),emit 源 FlatConfigOptions
// 与持久缓存都恢复全量(D1:重放在 emit + persist 之前;D5:缓存经既有管线修正)。
func TestResumeConfigReplayFakeAgentRestoresFull(t *testing.T) {
	setLog := filepath.Join(t.TempDir(), "sets.log")
	svc, se := newResumeFakeAgentSvc(t, setLog)

	if err := svc.ContinueSession(se.ID); err != nil {
		t.Fatalf("open (resume) session: %v", err)
	}

	// D2/D3:恰重放缺失键 thought/mode,参数 = 快照当前值;model 已报不重放。
	if got, want := readSetLog(t, setLog), []string{"thought=high", "mode=code"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("replay set_config_option trace = %v, want %v", got, want)
	}
	// D1:emit 数据源(FlatConfigOptions)一次拿全量。
	flat, err := svc.GetSessionConfigOptions(se.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertFullSnapshotOptions(t, flat)
	// D5:持久缓存经既有 set_config_option 管线恢复全量。
	cached, err := svc.GetSessionCachedConfigOptions(se.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertFullSnapshotOptions(t, cached)
}

// TestResumeConfigReplayFakeAgentSetFailureStillOpens (D7 场景二,e2e):set_config
// 全部失败 → 静默不阻断,session 照常打开成功;缓存保持 model-only 现状,不回填
// 旧快照(D4/D5)。
func TestResumeConfigReplayFakeAgentSetFailureStillOpens(t *testing.T) {
	setLog := filepath.Join(t.TempDir(), "sets.log")
	t.Setenv("MD_CHAT_FAKE_SET_FAIL", "thought,mode")
	svc, se := newResumeFakeAgentSvc(t, setLog)

	// D4:重放失败绝不阻断 session 打开。
	if err := svc.ContinueSession(se.ID); err != nil {
		t.Fatalf("session open must survive replay failures: %v", err)
	}
	// 两个缺失键都被尝试(agent 对被拒请求也留痕)。
	if got, want := readSetLog(t, setLog), []string{"thought=high", "mode=code"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("replay attempts = %v, want %v", got, want)
	}
	if !svc.isActive(se.ID) {
		t.Fatal("session should be live after open despite replay failures")
	}
	// D5:全失败保持 model-only 现状(不回填旧快照)。
	cached, err := svc.GetSessionCachedConfigOptions(se.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached) != 1 || cached[0].ID != "model" {
		t.Fatalf("all-fail must keep the model-only status quo, got %+v", cached)
	}
}

// TestResumeConfigReplayFakeAgentFullResumeNoReplay (D7 场景三,e2e):resume 回全量
// → 零重放调用(防拉锯)。
func TestResumeConfigReplayFakeAgentFullResumeNoReplay(t *testing.T) {
	t.Setenv("MD_CHAT_FAKE_RESUME_OPTS", "full")
	setLog := filepath.Join(t.TempDir(), "sets.log")
	svc, se := newResumeFakeAgentSvc(t, setLog)

	if err := svc.ContinueSession(se.ID); err != nil {
		t.Fatalf("open (resume) session: %v", err)
	}

	if got := readSetLog(t, setLog); len(got) != 0 {
		t.Fatalf("full resume must not trigger any replay call (anti tug-of-war), got %v", got)
	}
	flat, err := svc.GetSessionConfigOptions(se.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertFullSnapshotOptions(t, flat)
}
