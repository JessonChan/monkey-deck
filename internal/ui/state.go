// Package ui 持久化 UI 运行时状态(AGENTS.md §0.5「少量 JSON」)。
// 与 internal/config(结构性应用配置)区分:这里只放自动记住的运行时 UI 状态,
// 不进 SQLite(那是业务数据的唯一真相,AGENTS.md §1.5)。
package ui

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// MinWidth/MinHeight 是恢复时的最小尺寸护栏,防止持久化的过小值导致窗口不可用。
const (
	MinWidth  = 600
	MinHeight = 400
)

// WindowState 是窗口几何/状态的持久化表示(ui_state.json)。
// X/Y/Width/Height 记录的是「正常(非最大化)」几何,
// Maximized 标记是否应最大化打开。
type WindowState struct {
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	Maximized bool `json:"maximized"`
}

// LoadWindow 从 path 读取窗口状态。文件不存在视为无记录(零值 + nil)。
func LoadWindow(path string) (WindowState, error) {
	var s WindowState
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return WindowState{}, nil
		}
		return WindowState{}, err
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return WindowState{}, err
	}
	return s, nil
}

// SaveWindow 把窗口状态原子写入 path(先写 .tmp 再 rename,避免半截文件)。
func SaveWindow(path string, s WindowState) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
