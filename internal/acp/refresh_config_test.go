package acp

// refresh_config_test.go:RefreshConfig 的模型回退 bug 修复的纯函数单测。
//
// bug:RefreshConfig(打开 model 下拉触发)spawn 全新 probe → probe 的 configOptions(当前模型=默认)
// 整列覆盖活 session → 用户刚切的模型几秒后回退默认。修法:mergeConfigCurrentValues 只刷新可选列表、
// 保留活 session 的 CurrentValue(仅当仍在新列表里)。

import (
	"testing"

	"github.com/coder/acp-go-sdk"
)

// sel 构造一个 Select 型 configOption:id、当前值、可选 value 列表(Ungrouped)。
func sel(id, cur string, values ...string) acp.SessionConfigOption {
	opts := make(acp.SessionConfigSelectOptionsUngrouped, 0, len(values))
	for _, v := range values {
		opts = append(opts, acp.SessionConfigSelectOption{Value: acp.SessionConfigValueId(v)})
	}
	return acp.SessionConfigOption{
		Select: &acp.SessionConfigOptionSelect{
			Id:           acp.SessionConfigId(id),
			CurrentValue: acp.SessionConfigValueId(cur),
			Options:      acp.SessionConfigSelectOptions{Ungrouped: &opts},
		},
	}
}

// cur 取合并结果里某 id 的 CurrentValue。
func cur(opts []acp.SessionConfigOption, id string) string {
	for _, o := range opts {
		if o.Select != nil && string(o.Select.Id) == id {
			return string(o.Select.CurrentValue)
		}
	}
	return ""
}

// TestMergeConfigCurrentValues_PreservesLiveSelection 活 session 选了 qwen/plan,probe 刷新可选列表
// (currentValue 是默认 glm/normal)→ 合并后活 session 的选择保留,不被 probe 默认覆盖。
func TestMergeConfigCurrentValues_PreservesLiveSelection(t *testing.T) {
	old := []acp.SessionConfigOption{
		sel("model", "zai/qwen"),
		sel("mode", "plan"),
	}
	fresh := []acp.SessionConfigOption{
		sel("model", "zai/glm-5.2", "zai/glm-5.2", "zai/qwen", "openai/gpt"),
		sel("mode", "normal", "normal", "plan"),
	}
	got := mergeConfigCurrentValues(old, fresh)
	if c := cur(got, "model"); c != "zai/qwen" {
		t.Fatalf("model current = %q, want zai/qwen (live 选择应保留)", c)
	}
	if c := cur(got, "mode"); c != "plan" {
		t.Fatalf("mode current = %q, want plan (live 选择应保留)", c)
	}
	// 可选列表仍是 probe 的(同步外部新加的模型),没被 old 的旧列表覆盖。
	var modelOpt *acp.SessionConfigOption
	for i := range got {
		if got[i].Select != nil && string(got[i].Select.Id) == "model" {
			modelOpt = &got[i]
		}
	}
	if modelOpt == nil || modelOpt.Select.Options.Ungrouped == nil || len(*modelOpt.Select.Options.Ungrouped) != 3 {
		t.Fatalf("model 可选列表应为 probe 的 3 项,被覆盖了: %+v", modelOpt)
	}
}

// TestMergeConfigCurrentValues_DropsRemovedSelection 活 session 选了 qwen,但 probe 新列表里没有
// qwen(已下架)→ 不还原,保留 probe 默认(不强行设一个不存在的模型)。
func TestMergeConfigCurrentValues_DropsRemovedSelection(t *testing.T) {
	old := []acp.SessionConfigOption{sel("model", "zai/qwen")}
	fresh := []acp.SessionConfigOption{sel("model", "zai/glm-5.2", "zai/glm-5.2", "openai/gpt")}
	got := mergeConfigCurrentValues(old, fresh)
	if c := cur(got, "model"); c != "zai/glm-5.2" {
		t.Fatalf("已下架的模型不应还原: got %q, want zai/glm-5.2 (probe 默认)", c)
	}
}

// TestMergeConfigCurrentValues_NoOldKeepsFresh 活 session 没有该选项(old 空)→ 直接用 probe 的。
func TestMergeConfigCurrentValues_NoOldKeepsFresh(t *testing.T) {
	got := mergeConfigCurrentValues(nil, []acp.SessionConfigOption{sel("model", "zai/glm-5.2", "zai/glm-5.2")})
	if c := cur(got, "model"); c != "zai/glm-5.2" {
		t.Fatalf("old 为空应保留 probe 默认: got %q", c)
	}
}

// TestSelectOptionAvailable_Grouped Grouped 可选项也能正确判定。
func TestSelectOptionAvailable_Grouped(t *testing.T) {
	grp := acp.SessionConfigSelectOptionsGrouped{
		{Options: []acp.SessionConfigSelectOption{{Value: "a"}, {Value: "b"}}},
		{Options: []acp.SessionConfigSelectOption{{Value: "c"}}},
	}
	opts := acp.SessionConfigSelectOptions{Grouped: &grp}
	if !selectOptionAvailable(opts, "b") {
		t.Fatal("b 应在 Grouped 可选项里")
	}
	if selectOptionAvailable(opts, "z") {
		t.Fatal("z 不应在可选项里")
	}
}
