//go:build darwin

package config

import (
	"path/filepath"
	"testing"
)

// TestDefaultDirNaming_darwin 验证 macOS 下各目录的命名约定:
// DataDir/LogsDir 用显示名(AppName)、CachesDir/StateDir 用 BundleID。
func TestDefaultDirNaming_darwin(t *testing.T) {
	c := Default()
	if filepath.Base(c.DataDir) != AppName {
		t.Fatalf("DataDir base = %q, want display name %q", filepath.Base(c.DataDir), AppName)
	}
	if filepath.Base(c.CachesDir) != BundleID {
		t.Fatalf("CachesDir base = %q, want BundleID %q", filepath.Base(c.CachesDir), BundleID)
	}
	if filepath.Base(c.StateDir) != BundleID+".savedState" {
		t.Fatalf("StateDir base = %q, want %q.savedState", filepath.Base(c.StateDir), BundleID)
	}
	if filepath.Base(c.LogsDir) != AppName {
		t.Fatalf("LogsDir base = %q, want %q", filepath.Base(c.LogsDir), AppName)
	}
}
