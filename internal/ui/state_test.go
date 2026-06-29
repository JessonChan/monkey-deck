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
