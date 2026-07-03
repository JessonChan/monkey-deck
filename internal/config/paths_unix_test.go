//go:build !darwin && !windows

package config

import (
	"path/filepath"
	"testing"

	"github.com/adrg/xdg"
)

// TestDefaultDirNaming_unix 验证 Linux/Unix 下各目录的命名约定:
// 全部用 kebab-case slug(monkey-deck),符合 Linux 目录惯例;
// 日志与应用状态放 StateHome(非 cache)。
func TestDefaultDirNaming_unix(t *testing.T) {
	c := Default()
	for name, d := range map[string]string{
		"DataDir":   c.DataDir,
		"CachesDir": c.CachesDir,
		"StateDir":  c.StateDir,
	} {
		if filepath.Base(d) != AppSlug {
			t.Fatalf("%s base = %q, want slug %q", name, filepath.Base(d), AppSlug)
		}
	}
	if c.DataDir != filepath.Join(xdg.DataHome, AppSlug) {
		t.Fatalf("DataDir = %q, want %q", c.DataDir, filepath.Join(xdg.DataHome, AppSlug))
	}
	if c.CachesDir != filepath.Join(xdg.CacheHome, AppSlug) {
		t.Fatalf("CachesDir = %q, want %q", c.CachesDir, filepath.Join(xdg.CacheHome, AppSlug))
	}
	// 日志必须落在 StateHome 下,不能是 cache(cache 会被系统清理)
	if filepath.Dir(c.LogsDir) != filepath.Join(xdg.StateHome, AppSlug) {
		t.Fatalf("LogsDir = %q, want under %q", c.LogsDir, filepath.Join(xdg.StateHome, AppSlug))
	}
}
