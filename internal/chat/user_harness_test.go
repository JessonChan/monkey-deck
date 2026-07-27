package chat

// user_harness_test.go:ChatService.AddHarness + 启动加载用户 harness 的测试。
//
// 不真起 harness(§5.1):注入空 fakeStubProbe 让 Discover 标记全部未装 →
// AddHarness 末尾 go probeCapabilitiesAsync() 因无 Installed 项直接 no-op,不 spawn。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jessonchan/monkey-deck/internal/harness"
)

// resetUserHarnessesForTest 清空全局用户 harness 列表并在测试结束还原(t.Cleanup)。
// 避免跨测试污染(harness.SetUserHarnesses 是包级全局状态)。
func resetUserHarnessesForTest(t *testing.T) {
	t.Helper()
	prev := harness.UserHarnesses()
	harness.SetUserHarnesses(nil)
	t.Cleanup(func() { harness.SetUserHarnesses(prev) })
}

// TestAddHarness_PersistsAndReturns AddHarness 成功路径:校验通过 → 写文件 →
// 合并进内存 → 返回的列表含新 harness + 文件落盘正确。
func TestAddHarness_PersistsAndReturns(t *testing.T) {
	resetUserHarnessesForTest(t)
	// 空 fakeProbe:Discover 全标未装(避免真实 PATH 命中本机已装 opencode/omp 触发 probe spawn)。
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	list, err := svc.AddHarness("junie", "Junie", "junie acp", "")
	if err != nil {
		t.Fatalf("AddHarness: %v", err)
	}
	var got *harness.Harness
	for i := range list {
		if list[i].ID == "junie" {
			got = &list[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("returned list missing junie: %+v", list)
	}
	if got.Name != "Junie" || got.Command != "junie acp" {
		t.Fatalf("junie metadata wrong: %+v", got)
	}

	// 文件落盘:DataDir/harnesses.json 含一条 junie。
	data, err := os.ReadFile(filepath.Join(svc.cfg.DataDir, harness.UserHarnessesFile))
	if err != nil {
		t.Fatalf("read harnesses.json: %v", err)
	}
	if !strings.Contains(string(data), "junie") {
		t.Fatalf("harnesses.json missing junie: %s", data)
	}
	// 内存合并视图:UserHarnesses() 含 junie。
	found := false
	for _, u := range harness.UserHarnesses() {
		if u.ID == "junie" {
			found = true
		}
	}
	if !found {
		t.Fatalf("UserHarnesses() missing junie after AddHarness: %+v", harness.UserHarnesses())
	}
}

// TestAddHarness_IDConflictStatic 与静态 Supported(omp/opencode)冲突 → ErrUserIDConflict。
func TestAddHarness_IDConflictStatic(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
	if _, err := svc.AddHarness("omp", "OMP", "omp acp", ""); err != harness.ErrUserIDConflict {
		t.Fatalf("AddHarness(omp) err=%v, want ErrUserIDConflict", err)
	}
	if _, err := svc.AddHarness("opencode", "OC", "opencode acp", ""); err != harness.ErrUserIDConflict {
		t.Fatalf("AddHarness(opencode) err=%v, want ErrUserIDConflict", err)
	}
}

// TestAddHarness_IDConflictExistingUser 加过的用户 ID 再加 → ErrUserIDConflict。
func TestAddHarness_IDConflictExistingUser(t *testing.T) {
	resetUserHarnessesForTest(t)
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	if _, err := svc.AddHarness("junie", "Junie", "junie acp", ""); err != nil {
		t.Fatalf("first AddHarness: %v", err)
	}
	if _, err := svc.AddHarness("junie", "Junie2", "junie acp", ""); err != harness.ErrUserIDConflict {
		t.Fatalf("second AddHarness(junie) err=%v, want ErrUserIDConflict", err)
	}
}

// TestAddHarness_Validation 校验各字段空值 → 对应哨兵错误,且不写文件。
func TestAddHarness_Validation(t *testing.T) {
	resetUserHarnessesForTest(t)
	cases := []struct {
		name    string
		id      string
		nm      string
		cmd     string
		wantErr error
	}{
		{"id empty", "  ", "N", "x acp", harness.ErrUserIDEmpty},
		{"name empty", "k1", "  ", "x acp", harness.ErrUserNameEmpty},
		{"command empty", "k2", "N", "   ", harness.ErrUserCommandEmpty},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc := setupHarnessStoreSvc(t)
			_, err := svc.AddHarness(tc.id, tc.nm, tc.cmd, "")
			if err != tc.wantErr {
				t.Fatalf("AddHarness err=%v, want %v", err, tc.wantErr)
			}
			// 不应落盘文件。
			if _, statErr := os.Stat(filepath.Join(svc.cfg.DataDir, harness.UserHarnessesFile)); statErr == nil {
				t.Fatalf("harnesses.json should not be created on validation failure")
			}
		})
	}
}

// TestLoadPersistedConfig_LoadsUserHarnesses 启动加载:DataDir/harnesses.json 预置 →
// loadPersistedConfig 把它合并进内存(UserHarnesses() 含之)。
func TestLoadPersistedConfig_LoadsUserHarnesses(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
	// 预置 harnesses.json。
	preset := []harness.UserHarness{{ID: "kimi", Name: "Kimi", Command: "kimi acp"}}
	if err := harness.SaveUserHarnesses(filepath.Join(svc.cfg.DataDir, harness.UserHarnessesFile), preset); err != nil {
		t.Fatalf("SaveUserHarnesses: %v", err)
	}
	svc.loadPersistedConfig()

	found := false
	for _, u := range harness.UserHarnesses() {
		if u.ID == "kimi" {
			found = true
		}
	}
	if !found {
		t.Fatalf("loadPersistedConfig did not load kimi: %+v", harness.UserHarnesses())
	}
}

// TestLoadPersistedConfig_MissingFileNoError 文件不存在时 loadPersistedConfig 不报错(空列表,不阻塞启动)。
func TestLoadPersistedConfig_MissingFileNoError(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
	// 不预置文件;loadPersistedConfig 不应 panic / 不应留任何用户 harness。
	svc.loadPersistedConfig()
	if got := harness.UserHarnesses(); got != nil {
		t.Fatalf("missing file should yield empty user list, got %+v", got)
	}
}
