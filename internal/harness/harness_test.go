package harness

import "testing"

// TestRegistry 校验受支持 harness 注册表的基础不变量(§2.1)。
func TestRegistry(t *testing.T) {
	if len(Supported) < 2 {
		t.Fatalf("expected at least 2 harnesses, got %d", len(Supported))
	}
	seen := map[string]bool{}
	for _, h := range Supported {
		if h.ID == "" || h.Name == "" || h.Command == "" {
			t.Fatalf("harness has empty field: %+v", h)
		}
		if seen[h.ID] {
			t.Fatalf("duplicate harness id: %s", h.ID)
		}
		seen[h.ID] = true
	}
	for _, id := range []string{"omp", "opencode"} {
		if !seen[id] {
			t.Fatalf("expected harness %s in Supported", id)
		}
	}
	if Supported[0].ID != DefaultID {
		t.Fatalf("first Supported harness must be default: got %q, want %q", Supported[0].ID, DefaultID)
	}
}

func TestNormalizeAndCommand(t *testing.T) {
	// 已知 id 原样返回。
	if got := Normalize("opencode"); got != "opencode" {
		t.Fatalf(`Normalize("opencode")=%q, want "opencode"`, got)
	}
	// 空 / 未知回退默认(omp)。
	if got := Normalize(""); got != DefaultID {
		t.Fatalf(`Normalize("")=%q, want %q`, got, DefaultID)
	}
	if got := Normalize("bogus"); got != DefaultID {
		t.Fatalf(`Normalize("bogus")=%q, want %q`, got, DefaultID)
	}
	// Command 解析 + 未知回退默认(omp)。
	if got := Command("opencode"); got != "opencode acp" {
		t.Fatalf(`Command("opencode")=%q, want "opencode acp"`, got)
	}
	if got := Command("bogus"); got != "omp acp" {
		t.Fatalf(`Command("bogus")=%q, want "omp acp"`, got)
	}
}
