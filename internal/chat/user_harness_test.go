package chat

// user_harness_test.go:ChatService.AddHarness(命令派生 id + 自检门槛)/ UpdateUserHarness
// + 启动加载用户 harness 的测试。
//
// 持久化走 SQLite(user_harnesses 表,迁移 0012);测试用 setupHarnessStoreSvc 的临时 DB。
// 不真起 harness(§5.1):注入空 fakeStubProbe 让 Discover 标记全部未装 →
// AddHarness 末尾 go probeCapabilitiesAsync() 因无 Installed 项直接 no-op,不 spawn。

import (
	"context"
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

// TestHarnessCommandID 校验 id 派生:首段 token 的 basename。
func TestHarnessCommandID(t *testing.T) {
	cases := []struct{ in, want string }{
		{"junie acp", "junie"},
		{"/usr/local/bin/goose --stdio acp", "goose"},
		{"goose", "goose"},
		{"  kimi   acp  ", "kimi"},
		{"", ""},
		{"   ", ""},
	}
	for _, tc := range cases {
		if got := harnessCommandID(tc.in); got != tc.want {
			t.Fatalf("harnessCommandID(%q)=%q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestAddHarness_PersistsAndReturns 成功路径:命令派生 id → 落 SQLite → 合并进内存
// → 返回列表含新 harness + DB 落库正确(id = 命令首段 basename)。
func TestAddHarness_PersistsAndReturns(t *testing.T) {
	resetUserHarnessesForTest(t)
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	list, err := svc.AddHarness("junie acp", "Junie")
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
	if got.Name != "Junie" || got.Command != "junie acp" || !got.UserDefined {
		t.Fatalf("junie metadata wrong: %+v", got)
	}

	// DB 落库:user_harnesses 表含一条 id=junie。
	rows, err := svc.st.ListUserHarnesses(context.Background())
	if err != nil {
		t.Fatalf("ListUserHarnesses: %v", err)
	}
	var dbID, dbName, dbCmd string
	for _, r := range rows {
		if r.ID == "junie" {
			dbID, dbName, dbCmd = r.ID, r.Name, r.Command
		}
	}
	if dbID != "junie" || dbName != "Junie" || dbCmd != "junie acp" {
		t.Fatalf("junie DB row wrong: id=%q name=%q cmd=%q", dbID, dbName, dbCmd)
	}
}

// TestAddHarness_DerivesIDFromPath 命令首段是绝对路径 → id 取 basename(不拿整段路径当 id)。
func TestAddHarness_DerivesIDFromPath(t *testing.T) {
	resetUserHarnessesForTest(t)
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	list, err := svc.AddHarness("/usr/local/bin/goose --stdio acp", "Goose")
	if err != nil {
		t.Fatalf("AddHarness: %v", err)
	}
	found := false
	for _, h := range list {
		if h.ID == "goose" {
			found = true
		}
	}
	if !found {
		t.Fatalf("derived id should be basename 'goose', list=%+v", list)
	}
}

// TestAddHarness_NameOptionalDefaultsToID name 空 → store 兜底成 id(不报错)。
func TestAddHarness_NameOptionalDefaultsToID(t *testing.T) {
	resetUserHarnessesForTest(t)
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	if _, err := svc.AddHarness("junie acp", ""); err != nil {
		t.Fatalf("AddHarness with empty name should succeed: %v", err)
	}
	rows, _ := svc.st.ListUserHarnesses(context.Background())
	for _, r := range rows {
		if r.ID == "junie" && r.Name != "junie" {
			t.Fatalf("empty name should default to id, got name=%q", r.Name)
		}
	}
}

// TestAddHarness_ConflictBuiltin 派生 id 撞内置(omp/opencode)→ 报错。
func TestAddHarness_ConflictBuiltin(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
	for _, cmd := range []string{"omp acp", "opencode acp"} {
		_, err := svc.AddHarness(cmd, "X")
		if err == nil || !strings.Contains(err.Error(), "内置") {
			t.Fatalf("AddHarness(%q) err=%v, want builtin conflict", cmd, err)
		}
	}
}

// TestAddHarness_ConflictExisting 同命令再加 → 派生同 id → 报已存在。
func TestAddHarness_ConflictExisting(t *testing.T) {
	resetUserHarnessesForTest(t)
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	if _, err := svc.AddHarness("junie acp", "Junie"); err != nil {
		t.Fatalf("first AddHarness: %v", err)
	}
	_, err := svc.AddHarness("junie acp", "Junie2")
	if err == nil || !strings.Contains(err.Error(), "已存在") {
		t.Fatalf("second AddHarness err=%v, want already-exists", err)
	}
}

// TestAddHarness_CommandEmpty 命令空 → ErrUserCommandEmpty。
func TestAddHarness_CommandEmpty(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
	if _, err := svc.AddHarness("   ", "X"); err != harness.ErrUserCommandEmpty {
		t.Fatalf("AddHarness(empty cmd) err=%v, want ErrUserCommandEmpty", err)
	}
}

// TestUpdateUserHarness 改 name + command(id 不变);内置不可改;不存在报错。
func TestUpdateUserHarness(t *testing.T) {
	resetUserHarnessesForTest(t)
	restoreProbe := harness.SetProbeForTest(fakeStubProbe{})
	t.Cleanup(restoreProbe)

	svc := setupHarnessStoreSvc(t)
	if _, err := svc.AddHarness("junie acp", "Junie"); err != nil {
		t.Fatalf("AddHarness: %v", err)
	}

	// 改名 + 改命令,id 保持 junie。
	list, err := svc.UpdateUserHarness("junie", "Junie Pro", "junie --stdio acp")
	if err != nil {
		t.Fatalf("UpdateUserHarness: %v", err)
	}
	var got *harness.Harness
	for i := range list {
		if list[i].ID == "junie" {
			got = &list[i]
		}
	}
	if got == nil || got.Name != "Junie Pro" || got.Command != "junie --stdio acp" {
		t.Fatalf("update not applied: %+v", got)
	}
	// DB 行 id 仍是 junie,内容已改。
	row, _ := svc.st.GetUserHarness(context.Background(), "junie")
	if row == nil || row.Name != "Junie Pro" || row.Command != "junie --stdio acp" {
		t.Fatalf("DB row not updated: %+v", row)
	}

	// 内置不可改。
	if _, err := svc.UpdateUserHarness("omp", "X", "omp acp"); err == nil {
		t.Fatalf("UpdateUserHarness(omp) should reject builtin")
	}
	// 不存在报错。
	if _, err := svc.UpdateUserHarness("nope", "X", "nope acp"); err == nil {
		t.Fatalf("UpdateUserHarness(nope) should error on missing")
	}
}

// TestLoadPersistedConfig_LoadsUserHarnesses 启动加载:user_harnesses 表预置 →
// loadPersistedConfig 把它灌进内存(UserHarnesses() 含之)。
func TestLoadPersistedConfig_LoadsUserHarnesses(t *testing.T) {
	resetUserHarnessesForTest(t)
	svc := setupHarnessStoreSvc(t)
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
	svc.loadPersistedConfig()
	if got := harness.UserHarnesses(); got != nil {
		t.Fatalf("empty DB should yield empty user list, got %+v", got)
	}
}
