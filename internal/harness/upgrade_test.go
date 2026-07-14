package harness

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestCommandUpgrader_RunsConfiguredCommand 校验 CommandUpgrader 跑通真命令 + 失败时返 wrapped err。
//
// 用跨平台必有的命令做最小验证(不依赖外部环境):
//   - 成功:sh -c "exit 0" / cmd /c "exit 0"(无副作用)。
//   - 失败:sh -c "exit 3" / cmd /c "exit 1"。
func TestCommandUpgrader_RunsConfiguredCommand(t *testing.T) {
	// 跨平台分流以保证 CI 稳定(Unix: sh;Windows: cmd)。
	var okCmd, badCmd []string
	if runtime.GOOS == "windows" {
		okCmd = []string{"cmd", "/c", "exit 0"}
		badCmd = []string{"cmd", "/c", "exit 1"}
	} else {
		// sh 几乎所有 Unix 都有(/bin/sh 标准)。
		okCmd = []string{"sh", "-c", "exit 0"}
		badCmd = []string{"sh", "-c", "exit 3"}
	}

	if err := (CommandUpgrader{Cmd: okCmd}).Upgrade(context.Background()); err != nil {
		t.Fatalf("Upgrade(okCmd) err=%v, want nil", err)
	}

	err := (CommandUpgrader{Cmd: badCmd}).Upgrade(context.Background())
	if err == nil {
		t.Fatalf("Upgrade(badCmd) err=nil, want non-nil")
	}
	// 失败信息里含命令名(诊断价值)。
	if !strings.Contains(err.Error(), filepath.Base(badCmd[0])) {
		t.Fatalf("Upgrade error should contain cmd name %q: %v", filepath.Base(badCmd[0]), err)
	}
}

// TestCommandUpgrader_EmptyCmd 空 Cmd 配置直接报错(不静默成功)。
func TestCommandUpgrader_EmptyCmd(t *testing.T) {
	if err := (CommandUpgrader{}).Upgrade(context.Background()); err == nil {
		t.Fatalf("Upgrade(empty cmd) err=nil, want non-nil")
	}
}

// TestUpgrade_RoutesBySpecID id 在 Registry 配了 Upgrader → 调用之;未配 → ErrUpgraderNotConfigured。
func TestUpgrade_RoutesBySpecID(t *testing.T) {
	prevReg := Registry
	t.Cleanup(func() { Registry = prevReg })

	called := false
	Registry = []Spec{
		{
			ID: "withup",
			Upgrader: fakeUpgrader{
				fn: func() error { called = true; return nil },
			},
		},
		{ID: "withoutup"}, // 无 Upgrader
	}

	if err := Upgrade(context.Background(), "withup"); err != nil {
		t.Fatalf("Upgrade(withup)=%v, want nil", err)
	}
	if !called {
		t.Fatalf("Upgrader.Upgrade not called for 'withup'")
	}

	err := Upgrade(context.Background(), "withoutup")
	if !errors.Is(err, ErrUpgraderNotConfigured) {
		t.Fatalf("Upgrade(withoutup)=%v, want ErrUpgraderNotConfigured", err)
	}

	// 未知 id 也走「未配置」错误(防御)。
	if err := Upgrade(context.Background(), "bogus"); !errors.Is(err, ErrUpgraderNotConfigured) {
		t.Fatalf("Upgrade(bogus)=%v, want ErrUpgraderNotConfigured", err)
	}
}

// fakeUpgrader 测试用 Upgrader(可注入成功/失败行为 + 捕获调用)。
type fakeUpgrader struct {
	fn func() error
}

func (f fakeUpgrader) Upgrade(context.Context) error { return f.fn() }
