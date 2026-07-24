package store

import (
	"context"
	"testing"
)

func TestUserHarnessCRUD(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// Create
	h, err := s.CreateUserHarness(ctx, "jcode", "Jcode", "jcode acp", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if h.ID != "jcode" || h.Command != "jcode acp" || h.Name != "Jcode" {
		t.Fatalf("unexpected created row: %+v", h)
	}
	if h.Icon != "" {
		t.Fatalf("icon should default empty, got %q", h.Icon)
	}

	// 空名兜底为 id
	h2, err := s.CreateUserHarness(ctx, "crush", "", "crush acp", "")
	if err != nil {
		t.Fatalf("create empty-name: %v", err)
	}
	if h2.Name != "crush" {
		t.Fatalf("empty name should fall back to id, got %q", h2.Name)
	}

	// id 必填
	if _, err := s.CreateUserHarness(ctx, "", "x", "x acp", ""); err == nil {
		t.Fatal("create with empty id should error")
	}
	// command 必填
	if _, err := s.CreateUserHarness(ctx, "z", "z", "", ""); err == nil {
		t.Fatal("create with empty command should error")
	}

	// 重复 id 冲突(SQL PK)
	if _, err := s.CreateUserHarness(ctx, "jcode", "dup", "dup", ""); err == nil {
		t.Fatal("duplicate id should error")
	}

	// List(按 created_at ASC:先 jcode 后 crush)
	list, err := s.ListUserHarnesses(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 || list[0].ID != "jcode" || list[1].ID != "crush" {
		t.Fatalf("unexpected list: %+v", list)
	}

	// Get
	got, err := s.GetUserHarness(ctx, "jcode")
	if err != nil || got == nil || got.Command != "jcode acp" {
		t.Fatalf("get jcode: %v %+v", err, got)
	}
	// 不存在 → nil,nil(不报错)
	miss, err := s.GetUserHarness(ctx, "nope")
	if err != nil || miss != nil {
		t.Fatalf("get missing should be nil,nil; got %v %+v", err, miss)
	}

	// Delete + 幂等
	if err := s.DeleteUserHarness(ctx, "jcode"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := s.DeleteUserHarness(ctx, "jcode"); err != nil {
		t.Fatalf("delete again should be idempotent: %v", err)
	}
	list2, _ := s.ListUserHarnesses(ctx)
	if len(list2) != 1 || list2[0].ID != "crush" {
		t.Fatalf("after delete list wrong: %+v", list2)
	}
}
