//go:build windows

package config

import (
	"path/filepath"
	"testing"

	"github.com/adrg/xdg"
)

// TestDefaultDirNaming_windows 验证 Windows 下各目录的命名约定:
// 全部以 %LOCALAPPDATA%\<AppName> 为根,内部 Logs/Cache/State 子目录。
func TestDefaultDirNaming_windows(t *testing.T) {
	c := Default()
	root := filepath.Join(xdg.DataHome, AppName)
	if c.DataDir != root {
		t.Fatalf("DataDir = %q, want root %q", c.DataDir, root)
	}
	if c.LogsDir != filepath.Join(root, "Logs") {
		t.Fatalf("LogsDir = %q, want %q", c.LogsDir, filepath.Join(root, "Logs"))
	}
	if c.CachesDir != filepath.Join(root, "Cache") {
		t.Fatalf("CachesDir = %q, want %q", c.CachesDir, filepath.Join(root, "Cache"))
	}
	if c.StateDir != filepath.Join(root, "State") {
		t.Fatalf("StateDir = %q, want %q", c.StateDir, filepath.Join(root, "State"))
	}
}
