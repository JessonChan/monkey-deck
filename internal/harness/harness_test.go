package harness

import "testing"

// TestRegistry 校验受支持 harness 注册表的基础不变量(§2.1)。
func TestRegistry(t *testing.T) {
	if len(Supported) < 3 {
		t.Fatalf("expected at least 3 harnesses, got %d", len(Supported))
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
	for _, id := range []string{"opencode", "mino", "omp"} {
		if !seen[id] {
			t.Fatalf("expected harness %s in Supported", id)
		}
	}
}

func TestNormalizeAndCommand(t *testing.T) {
	// 已知 id 原样返回。
	if got := Normalize("mino"); got != "mino" {
		t.Fatalf(`Normalize("mino")=%q, want "mino"`, got)
	}
	if got := Normalize(""); got != DefaultID {
		t.Fatalf(`Normalize("")=%q, want %q`, got, DefaultID)
	}
	if got := Normalize("bogus"); got != DefaultID {
		t.Fatalf(`Normalize("bogus")=%q, want %q`, got, DefaultID)
	}
	// Command 解析 + 未知回退 opencode。
	if got := Command("omp"); got != "omp acp" {
		t.Fatalf(`Command("omp")=%q, want "omp acp"`, got)
	}
	if got := Command("bogus"); got != "opencode acp" {
		t.Fatalf(`Command("bogus")=%q, want "opencode acp"`, got)
	}
}

func TestIsOpenCode(t *testing.T) {
	if !IsOpenCode("opencode") {
		t.Fatal(`IsOpenCode("opencode") = false, want true`)
	}
	if IsOpenCode("mino") {
		t.Fatal(`IsOpenCode("mino") = true, want false`)
	}
	if !IsOpenCode("") { // 空归一化到 opencode
		t.Fatal(`IsOpenCode("") = false, want true`)
	}
}
