package store

import (
	"context"
	"testing"
)

func TestPermissionRulesCRUD(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// 初始为空
	list, err := s.ListPermissionRules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("initial list not empty: %d", len(list))
	}

	// 新建两条
	r1, err := s.CreatePermissionRule(ctx, PermissionRule{ToolName: "edit", ActionType: "write", Level: "ask", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if r1.ID == "" || r1.SortOrder != 0 {
		t.Fatalf("bad r1: %+v", r1)
	}
	r2, err := s.CreatePermissionRule(ctx, PermissionRule{ActionType: "read", Level: "allow", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if r2.SortOrder != 1 {
		t.Fatalf("r2 sort_order should be 1, got %d", r2.SortOrder)
	}

	// 列表按优先级返回
	list, _ = s.ListPermissionRules(ctx)
	if len(list) != 2 || list[0].ID != r1.ID || list[1].ID != r2.ID {
		t.Fatalf("list order wrong: %+v", list)
	}

	// 更新
	r2.Level = "deny"
	r2.Enabled = false
	if err := s.UpdatePermissionRule(ctx, *r2); err != nil {
		t.Fatal(err)
	}
	got, _ := s.ListPermissionRules(ctx)
	if got[1].Level != "deny" || got[1].Enabled {
		t.Fatalf("update not applied: %+v", got[1])
	}

	// 重排
	if err := s.ReorderPermissionRules(ctx, []string{r2.ID, r1.ID}); err != nil {
		t.Fatal(err)
	}
	got, _ = s.ListPermissionRules(ctx)
	if got[0].ID != r2.ID || got[1].ID != r1.ID {
		t.Fatalf("reorder wrong: %+v", got)
	}

	// 删除
	if err := s.DeletePermissionRule(ctx, r1.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = s.ListPermissionRules(ctx)
	if len(got) != 1 || got[0].ID != r2.ID {
		t.Fatalf("after delete: %+v", got)
	}
}

func TestSeedDefaultPermissionRules(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	defs := []PermissionRule{
		{ID: "d1", ActionType: "read", Level: "allow", Enabled: true, SortOrder: 0},
		{ID: "d2", ActionType: "write", Level: "ask", Enabled: true, SortOrder: 1},
	}
	// 首次播种应写入
	seeded, err := s.SeedDefaultPermissionRules(ctx, defs)
	if err != nil {
		t.Fatal(err)
	}
	if !seeded {
		t.Fatal("应播种(表空时)")
	}
	got, _ := s.ListPermissionRules(ctx)
	if len(got) != 2 {
		t.Fatalf("seeded count: %d", len(got))
	}
	if got[0].SortOrder != 0 || got[1].SortOrder != 1 {
		t.Fatalf("seeded sort_order: %d %d", got[0].SortOrder, got[1].SortOrder)
	}

	// 再次调用不应覆盖(已有规则)
	seeded2, _ := s.SeedDefaultPermissionRules(ctx, defs)
	if seeded2 {
		t.Fatal("已有规则时不应再播种")
	}
}
