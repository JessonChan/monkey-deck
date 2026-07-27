// user.go:用户自添加 harness 的内存合并视图 + 校验。
//
// 静态 Supported/Registry(omp/opencode)写死在源码里,用户要加新 harness(junie/jcode/goose/
// kimi 等)只能改代码。本文件提供「用户 harness」机制:service 层从 SQLite(store.user_harnesses
// 表,迁移 0012)加载用户 harness 元数据,灌进本包的内存合并视图(SetUserHarnesses),
// 让 Discover/Command/Normalize/进程回收 都能识别它们(§5.3 复用,不另起注册体系)。
//
// 设计要点:
//   - 用户 harness 也是 ACP peer(§1.2),AddHarness 只记元数据,spawn/probe 走现有 ACP 路径。
//   - 用户 harness 不查上游、不升级(无 Source/Upgrader):只做 spawn + 本地版本检测 + 能力探测。
//   - 合并只在内存(不改静态 Supported/Registry 源码);去重 by ID,静态优先,用户追加在后。
//   - 持久化走 SQLite(store 层,§2.1 store 是 SQL 唯一入口),本包不直接碰 DB —— 保持 store-free,
//     由 service 层(chat)在启动 / 增删时调 SetUserHarnesses 灌入。
package harness

import (
	"errors"
	"strings"
	"sync/atomic"
)

// UserHarness 用户自添加 harness 的内存结构(只存静态元数据四段)。
// 运行时数据(安装路径/版本/升级)由 Discover 在合并后的视图上统一填,不在此存。
// 持久化落 store.UserHarness(多一个 created_at);service 层在加载时做转换。
type UserHarness struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Command string `json:"command"`
	Icon    string `json:"icon,omitempty"` // 空 = 前端兜底(lucide Bot)
}

// 用户 harness 校验错误。后端返明确串(英文),前端做 i18n 映射或直接兜底显示。
var (
	ErrUserIDEmpty      = errors.New("harness id must not be empty")
	ErrUserIDConflict   = errors.New("harness id already exists")
	ErrUserNameEmpty    = errors.New("harness name must not be empty")
	ErrUserCommandEmpty = errors.New("harness command must not be empty")
)

// userHarnessesHolder 持有当前内存里的用户 harness 列表(启动加载 + AddHarness 更新)。
// atomic.Pointer 保证并发安全(AddHarness 写、Discover 读并行)。
var userHarnessesHolder atomic.Pointer[[]UserHarness]

// SetUserHarnesses 替换内存里的用户 harness 列表(启动加载 + AddHarness 调)。
// 传 nil 清空。静态 Supported/Registry 不受影响。
func SetUserHarnesses(u []UserHarness) {
	cp := u
	userHarnessesHolder.Store(&cp)
}

// UserHarnesses 返回当前内存里的用户 harness 列表快照(可能为空切片,不返回 nil)。
func UserHarnesses() []UserHarness {
	if p := userHarnessesHolder.Load(); p != nil {
		return *p
	}
	return nil
}

// ValidateUserHarness 校验候选用户 harness:ID/Name/Command 非空 + ID 不与静态(Supported)或
// 已有用户列表冲突。trim 后判定。返回上述 ErrUser* 哨兵错误之一(空 = 合法)。
// 纯函数(不读包级状态),existing 由调用方传入(便于测试注入)。
func ValidateUserHarness(id, name, command string, existing []UserHarness) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrUserIDEmpty
	}
	for _, h := range Supported {
		if h.ID == id {
			return ErrUserIDConflict
		}
	}
	for _, u := range existing {
		if u.ID == id {
			return ErrUserIDConflict
		}
	}
	if strings.TrimSpace(name) == "" {
		return ErrUserNameEmpty
	}
	if len(strings.Fields(strings.TrimSpace(command))) == 0 {
		return ErrUserCommandEmpty
	}
	return nil
}

// effectiveSupported 合并静态 Supported + 用户 harness,返回去重视图。
// 静态优先(顺序不变),用户追加在后;同 ID 静态赢(用户不该覆盖内置)。
// 不修改静态 Supported 源(合并只发生在返回的新切片里)。
func effectiveSupported() []Harness {
	static := Supported
	user := UserHarnesses()
	out := make([]Harness, 0, len(static)+len(user))
	seen := make(map[string]struct{}, len(static)+len(user))
	for _, h := range static {
		out = append(out, h)
		seen[h.ID] = struct{}{}
	}
	for _, u := range user {
		if u.ID == "" {
			continue
		}
		if _, ok := seen[u.ID]; ok {
			continue
		}
		out = append(out, Harness{ID: u.ID, Name: u.Name, Command: u.Command, Icon: u.Icon})
		seen[u.ID] = struct{}{}
	}
	return out
}

// effectiveRegistry 合并静态 Registry + 用户 harness 的 Spec。
// 用户 Spec 只填 BinaryName(command 首段,供 LookPath + 进程识别),无 Source/Upgrader
// (用户 harness 不查上游、不升级)。command 解析做防御:空 / 无 token 时跳过(正常情况下
// AddHarness 校验已保证 command 非空可切,这里兜底防数据被手改)。
func effectiveRegistry() []Spec {
	static := Registry
	user := UserHarnesses()
	out := make([]Spec, 0, len(static)+len(user))
	seen := make(map[string]struct{}, len(static)+len(user))
	for _, sp := range static {
		out = append(out, sp)
		seen[sp.ID] = struct{}{}
	}
	for _, u := range user {
		if u.ID == "" {
			continue
		}
		if _, ok := seen[u.ID]; ok {
			continue
		}
		fields := strings.Fields(strings.TrimSpace(u.Command))
		if len(fields) == 0 {
			continue
		}
		out = append(out, Spec{ID: u.ID, BinaryName: fields[0]})
		seen[u.ID] = struct{}{}
	}
	return out
}
