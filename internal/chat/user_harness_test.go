package chat

// user_harness_test.go:ChatService.AddHarness(声明即用 + 自检门槛)+ 启动加载用户 harness 的测试。
//
// 持久化走 SQLite(user_harnesses 表,迁移 0012);测试用 setupHarnessStoreSvc 的临时 DB。
// 不真起 harness(§5.1):注入空 fakeStubProbe 让 Discover 标记全部未装 →
// AddHarness 末尾 go probeCapabilitiesAsync() 因无 Installed 项直接 no-op,不 spawn。

import (
	"context"
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

// TestAddHarness_PersistsAndReturns AddHarness 成功路径:校验通过 → 落 SQLite →
// 合并进内存 → 返回的列表含新 harness + DB 落库正确。
func TestAddHarness_PersistsAndReturns(t *testing.T) {
	resetUserHarnessesForTest(t)
	// 空 fakeProbe:Discover 全标未装(避免真实 PATH 命中本机已装 opencode/omp 触发 probe spawn)。
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	list, err := svc.AddHarness("junie", "Junie", "junie acp")
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

	// DB 落库:user_harnesses 表含一条 junie。
	rows, err := svc.st.ListUserHarnesses(context.Background())
	if err != nil {
		t.Fatalf("ListUserHarnesses: %v", err)
	}
	var dbRow *harness.UserHarness
	for _, r := range rows {
		if r.ID == "junie" {
			r := r
			dbRow = &harness.UserHarness{ID: r.ID, Name: r.Name, Command: r.Command, Icon: r.Icon}
		}
	}
	if dbRow == nil {
		t.Fatalf("user_harnesses table missing junie: %+v", rows)
	}
	if dbRow.Name != "Junie" || dbRow.Command != "junie acp" {
		t.Fatalf("junie DB row wrong: %+v", dbRow)
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
	if _, err := svc.AddHarness("omp", "OMP", "omp acp"); err != harness.ErrUserIDConflict {
		t.Fatalf("AddHarness(omp) err=%v, want ErrUserIDConflict", err)
	}
	if _, err := svc.AddHarness("opencode", "OC", "opencode acp"); err != harness.ErrUserIDConflict {
		t.Fatalf("AddHarness(opencode) err=%v, want ErrUserIDConflict", err)
	}
}

// TestAddHarness_IDConflictExistingUser 加过的用户 ID 再加 → ErrUserIDConflict。
func TestAddHarness_IDConflictExistingUser(t *testing.T) {
	resetUserHarnessesForTest(t)
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	if _, err := svc.AddHarness("junie", "Junie", "junie acp"); err != nil {
		t.Fatalf("first AddHarness: %v", err)
	}
	if _, err := svc.AddHarness("junie", "Junie2", "junie acp"); err != harness.ErrUserIDConflict {
		t.Fatalf("second AddHarness(junie) err=%v, want ErrUserIDConflict", err)
	}
}

// TestAddHarness_Validation 校验各字段空值 → 对应哨兵错误,且不落库。
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
			_, err := svc.AddHarness(tc.id, tc.nm, tc.cmd)
			if err != tc.wantErr {
				t.Fatalf("AddHarness err=%v, want %v", err, tc.wantErr)
			}
			// 不应落库。
			rows, lerr := svc.st.ListUserHarnesses(context.Background())
			if lerr != nil {
				t.Fatalf("ListUserHarnesses: %v", lerr)
			}
			if len(rows) != 0 {
				t.Fatalf("validation failure should not persist, got %+v", rows)
			}
		})
	}
}

// TestLoadPersistedConfig_LoadsUserHarnesses 启动加载:user_harnesses 表预置 →
// loadPersistedConfig 把它灌进内存(UserHarnesses() 含之)。
func TestLoadPersistedConfig_LoadsUserHarnesses(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
	// 预置 DB 行。
	if _, err := svc.st.CreateUserHarness(context.Background(), "kimi", "Kimi", "kimi acp", ""); err != nil {
		t.Fatalf("CreateUserHarness: %v", err)
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

// TestLoadPersistedConfig_EmptyDBNoError 表空时 loadPersistedConfig 不报错(空列表,不阻塞启动)。
func TestLoadPersistedConfig_EmptyDBNoError(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
	// 不预置行;loadPersistedConfig 不应 panic / 不应留任何用户 harness。
	svc.loadPersistedConfig()
	if got := harness.UserHarnesses(); got != nil {
		t.Fatalf("empty DB should yield empty user list, got %+v", got)
	}
}
