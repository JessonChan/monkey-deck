package chat

// config_select_test.go:首条消息前 model selector 的缓存逻辑单测(AGENTS.md §5.1:不启真 harness)。
//
// 覆盖「新建/打开会话时即展示 model 下拉」的核心纯逻辑(冷缓存时预热 spawn keep alive 拿到列表,
// 此处直接灌 cfgCache 测缓存派生逻辑,不 spawn 真 harness):
//  1. buildSessionConfig:从缓存只取 model 项,currentValue = session.Model(mode/effort 不返回)。
//  2. 缓存未就绪时 buildSessionConfig 返回 nil(maybeWarmSession 会预热 spawn 兜底)。
//  3. SetSessionConfigOption 未活跃分支:model 写 DB(首条消息 NewSession 钉死),不 spawn harness。
//  4. 未活跃时 mode/effort 配置变更被忽略(运行时热切项,首条消息前不展示也不处理)。

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// newConfigService 建一个临时 store + 项目 + session(无需 git,不启 harness)。
func newConfigService(t *testing.T) (svc *ChatService, se *store.Session) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := store.New(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc = NewChatService(&config.Config{DataDir: t.TempDir(), DBPath: dbPath, HarnessCmd: "opencode acp"})
	svc.ctx = context.Background()
	svc.st = st
	proj, err := st.CreateProject(svc.ctx, "p", t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	se, err = st.CreateSession(svc.ctx, proj.ID, "t", "zai/glm-4.6", "opencode")
	if err != nil {
		t.Fatal(err)
	}
	return svc, se
}

func modelOptions() []acp.ConfigOption {
	return []acp.ConfigOption{
		{ID: "model", Name: "Model", Category: "model", CurrentValue: "zai/glm-4.6",
			Options: []acp.ConfigOptionEntry{{Value: "zai/glm-4.6", Name: "GLM-4.6"}, {Value: "zai/glm-5.2", Name: "GLM-5.2"}}},
		{ID: "mode", Name: "Mode", Category: "mode", CurrentValue: "build",
			Options: []acp.ConfigOptionEntry{{Value: "build", Name: "Build"}, {Value: "plan", Name: "Plan"}}},
		{ID: "effort", Name: "Effort", Category: "thought_level", CurrentValue: "high",
			Options: []acp.ConfigOptionEntry{{Value: "high", Name: "High"}}},
	}
}

// buildSessionConfig 只返回 model 项,currentValue 取 session.Model(而非缓存里的探测默认值)。
func TestBuildSessionConfigModelOnly(t *testing.T) {
	svc, se := newConfigService(t)
	svc.cfgCache[configCacheKey(se.Harness, se.ProjectID)] = modelOptions()
	se.Model = "zai/glm-5.2" // 用户在 DB 里钉的 model(与探测默认 glm-4.6 不同)

	got := svc.buildSessionConfig(se)
	if len(got) != 1 {
		t.Fatalf("want exactly 1 option (model only), got %d: %+v", len(got), got)
	}
	if got[0].Category != "model" {
		t.Fatalf("want model category, got %q", got[0].Category)
	}
	if got[0].CurrentValue != "zai/glm-5.2" {
		t.Fatalf("currentValue should follow session.Model, got %q", got[0].CurrentValue)
	}
	if len(got[0].Options) != 2 {
		t.Fatalf("model options list should be passed through, got %d", len(got[0].Options))
	}
}

// 缓存未就绪(首次、探测未完成或失败)时返回 nil —— 调用方不发空事件。
func TestBuildSessionConfigColdCacheNil(t *testing.T) {
	svc, se := newConfigService(t)
	// 不填 cfgCache(冷缓存)
	if got := svc.buildSessionConfig(se); got != nil {
		t.Fatalf("cold cache should return nil, got %+v", got)
	}
}

// 未活跃改 model:写 DB(首条消息 NewSession 钉死),推 config_option(新 currentValue),不 spawn。
func TestSetSessionConfigOptionPreLiveWritesModel(t *testing.T) {
	svc, se := newConfigService(t)
	svc.cfgCache[configCacheKey(se.Harness, se.ProjectID)] = modelOptions()

	var captured *acp.SessionEvent
	svc.emitHook = func(name string, data any) {
		if ev, ok := data.(acp.SessionEvent); ok {
			e := ev
			captured = &e
		}
	}

	if err := svc.SetSessionConfigOption(se.ID, "model", "zai/glm-5.2"); err != nil {
		t.Fatalf("SetSessionConfigOption: %v", err)
	}

	// DB 已更新(首条消息 ensureLive 会用这个 model 写 opencode.json)。
	got, err := svc.st.GetSession(context.Background(), se.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "zai/glm-5.2" {
		t.Fatalf("model not persisted to DB: got %q", got.Model)
	}
	// 未 spawn harness(active 仍空)。
	if svc.isActive(se.ID) {
		t.Fatal("pre-live config change must NOT spawn harness (idle disconnect, §5.4 #9)")
	}
	// 推了 config_option,新 currentValue 生效。
	if captured == nil || captured.Kind != "config_option" || captured.SessionID != se.ID {
		t.Fatalf("expected config_option emit, got %+v", captured)
	}
	if len(captured.ConfigOptions) != 1 || captured.ConfigOptions[0].CurrentValue != "zai/glm-5.2" {
		t.Fatalf("emitted currentValue mismatch: %+v", captured.ConfigOptions)
	}
}

// 未活跃时 mode/effort 变更被忽略(运行时热切项,首条消息前不处理、不 emit、不动 DB)。
func TestSetSessionConfigOptionPreLiveIgnoresNonModel(t *testing.T) {
	svc, se := newConfigService(t)
	svc.cfgCache[configCacheKey(se.Harness, se.ProjectID)] = modelOptions()

	emitted := false
	svc.emitHook = func(name string, data any) { emitted = true }

	if err := svc.SetSessionConfigOption(se.ID, "mode", "plan"); err != nil {
		t.Fatalf("SetSessionConfigOption(mode) pre-live: %v", err)
	}
	if emitted {
		t.Fatal("pre-live mode change must not emit (dropdown not shown; change wouldn't apply)")
	}
}
