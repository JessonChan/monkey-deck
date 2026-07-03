package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestDefaultDirs 验证 Default 返回的四个目录非空、DBPath 在 DataDir 下、文件名用 AppSlug。
// 适用于所有平台(平台命名约定见 TestDefaultDirNaming_*)。
func TestDefaultDirs(t *testing.T) {
	c := Default()
	for _, tc := range []struct {
		name string
		got  string
	}{
		{"DataDir", c.DataDir},
		{"LogsDir", c.LogsDir},
		{"CachesDir", c.CachesDir},
		{"StateDir", c.StateDir},
	} {
		if tc.got == "" {
			t.Fatalf("%s is empty", tc.name)
		}
	}
	if filepath.Base(c.DBPath) != AppSlug+".db" {
		t.Fatalf("DBPath base = %q, want %q", filepath.Base(c.DBPath), AppSlug+".db")
	}
	if filepath.Dir(c.DBPath) != c.DataDir {
		t.Fatalf("DBPath dir = %q, want DataDir %q", filepath.Dir(c.DBPath), c.DataDir)
	}
}

// TestEnsureDir 验证 EnsureDir 创建全部四个目录(空值跳过不报错)。
func TestEnsureDir(t *testing.T) {
	dir := t.TempDir()
	c := TestConfig(dir)
	if err := c.EnsureDir(); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	// TestConfig 把四个目录都设为 dir,EnsureDir 应已创建(dir 本就存在,幂等)。
	for _, d := range []string{c.DataDir, c.LogsDir, c.CachesDir, c.StateDir} {
		fi, err := os.Stat(d)
		if err != nil {
			t.Fatalf("stat %s: %v", d, err)
		}
		if !fi.IsDir() {
			t.Fatalf("%s is not a directory", d)
		}
	}
}

// TestEnsureDirCreatesNested 验证 EnsureDir 能创建不存在的多级子目录。
func TestEnsureDirCreatesNested(t *testing.T) {
	root := t.TempDir()
	c := &Config{
		DataDir:   filepath.Join(root, "data", AppSlug),
		LogsDir:   filepath.Join(root, "logs", AppSlug),
		CachesDir: filepath.Join(root, "caches", AppSlug),
		StateDir:  filepath.Join(root, "state", AppSlug),
	}
	if err := c.EnsureDir(); err != nil {
		t.Fatalf("EnsureDir: %v", err)
	}
	for _, d := range []string{c.DataDir, c.LogsDir, c.CachesDir, c.StateDir} {
		if _, err := os.Stat(d); err != nil {
			t.Fatalf("EnsureDir did not create %s: %v", d, err)
		}
	}
}

// TestEnsureDirSkipsEmpty 验证空字符串目录被跳过(不 panic、不报错)。
func TestEnsureDirSkipsEmpty(t *testing.T) {
	c := &Config{} // 全空
	if err := c.EnsureDir(); err != nil {
		t.Fatalf("EnsureDir on empty config: %v", err)
	}
}

// TestTestConfigColocated 验证 TestConfig 把所有目录落在同一 dir 下、DBPath 同构。
func TestTestConfigColocated(t *testing.T) {
	dir := t.TempDir()
	c := TestConfig(dir)
	for _, d := range []string{c.DataDir, c.LogsDir, c.CachesDir, c.StateDir} {
		if d != dir {
			t.Fatalf("dir %q != test dir %q", d, dir)
		}
	}
	if c.DBPath != filepath.Join(dir, AppSlug+".db") {
		t.Fatalf("DBPath = %q, want %q", c.DBPath, filepath.Join(dir, AppSlug+".db"))
	}
}
