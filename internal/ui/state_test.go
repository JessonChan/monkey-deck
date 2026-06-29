package ui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadWindowMissingReturnsZero(t *testing.T) {
	got, err := LoadWindow(filepath.Join(t.TempDir(), "nope.json"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != (WindowState{}) {
		t.Fatalf("missing file should return zero value, got %+v", got)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "ui_state.json")
	want := WindowState{X: 120, Y: 80, Width: 1280, Height: 840, Maximized: true}
	if err := SaveWindow(path, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := LoadWindow(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != want {
		t.Fatalf("round-trip mismatch:\n got  %+v\n want %+v", got, want)
	}
	// 原子写不应残留 .tmp 文件。
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temp file should not remain: %v", err)
	}
}

func TestLoadWindowCorruptReturnsError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ui_state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := LoadWindow(path); err == nil {
		t.Fatalf("corrupt file should return error")
	}
}

func TestWindowStateExportsForJSON(t *testing.T) {
	// encoding/json 只序列化导出字段(AGENTS.md §5.4 #12 教训);断言所有字段可序列化。
	s := WindowState{X: 1, Y: 2, Width: 3, Height: 4, Maximized: true}
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, k := range []string{"x", "y", "width", "height", "maximized"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("field %q missing from serialized output", k)
		}
	}
}

func TestVisibleOn(t *testing.T) {
	// 单屏 1920x1080,工作区从 (0,30) 起(顶部 30px 菜单栏)。
	primary := Bounds{X: 0, Y: 30, Width: 1920, Height: 1050}
	cases := []struct {
		name     string
		workArea []Bounds
		win      Bounds
		want     bool
	}{
		{"窗口在屏幕内", []Bounds{primary}, Bounds{X: 100, Y: 100, Width: 1280, Height: 840}, true},
		{"部分可见且 ≥100x100", []Bounds{primary}, Bounds{X: 1800, Y: 900, Width: 800, Height: 600}, true}, // 与屏幕重叠 120x180
		{"完全在屏幕外(外接显示器已拔除)", []Bounds{primary}, Bounds{X: 3000, Y: 200, Width: 1280, Height: 840}, false},
		{"重叠不足 100px(仅缝隙)", []Bounds{primary}, Bounds{X: 1919, Y: 100, Width: 800, Height: 600}, false},
		{"无屏幕数据(降级:不恢复)", nil, Bounds{X: 100, Y: 100, Width: 1280, Height: 840}, false},
	}
	for _, c := range cases {
		if got := VisibleOn(c.workArea, c.win); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}
