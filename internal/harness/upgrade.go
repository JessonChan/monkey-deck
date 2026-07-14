// upgrade.go:升级 harness 到最新版本。
//
// Upgrader 是接口(同 ReleaseSource 思路):生产用 CommandUpgrader 委托外部安装脚本,
// 单测注入 mock(不真跑命令)。
//
// 升级策略选择(§3.5 「外部事实是设计前提时先验证」):
//   - opencode/npm/bun 类 harness 的安装状态由外部包管理器(npm/bun/curl-install)持有,
//     本应用直接覆写可执行文件会与包管理器冲突(版本回写、权限、卸载残留)。故默认策略是
//     **委托**:CommandUpgrader 跑 harness 官方安装脚本/命令,由其自身幂等地升级到最新。
//   - 直接下载 release asset 到约定目录的 AssetUpgrader 留作后续按需实现(范围:本次不做,
//     避免与包管理器打架)。
package harness

import (
	"context"
	"fmt"
	"os/exec"
)

// ErrUpgraderNotConfigured 该 harness 未配置 Upgrader(Registry 里 Upgrader=nil)。
// 调用方据此给前端「暂不支持升级」的提示,而非把它当普通错误。
var ErrUpgraderNotConfigured = fmt.Errorf("harness upgrade: no upgrader configured for this harness")

// Upgrader 把指定 harness 升级到最新版本。
// 实现应阻塞到升级流程结束(成功/失败),由调用方包 ctx 控制超时/取消。
type Upgrader interface {
	Upgrade(ctx context.Context) error
}

// CommandUpgrader 跑一条外部命令来升级 harness(委托给官方安装脚本/包管理器)。
// 命令输出直透到 stderr/ stdout(供诊断),不捕获到内存(避免大日志撑爆)。
//
// 例:opencode 官方安装脚本 → Cmd: []string{"bash","-c","curl -fsSL https://opencode.ai/install | bash"}。
type CommandUpgrader struct {
	Cmd []string // [name, args...] 形如 {"bash","-c","..."}
}

// Upgrade 跑配置好的命令;命令非 0 退出则返 wrapped error。
func (c CommandUpgrader) Upgrade(ctx context.Context) error {
	if len(c.Cmd) == 0 {
		return fmt.Errorf("command upgrader: empty cmd")
	}
	cmd := exec.CommandContext(ctx, c.Cmd[0], c.Cmd[1:]...)
	// 不连 stdin(否则会 hang 等待输入),输出透到本应用自己的 stderr/log(诊断用)。
	cmd.Stdin = nil
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("command upgrader(%s): %w: %s", c.Cmd[0], err, string(out))
	}
	return nil
}

// Upgrade 对 harness id 触发升级;id 未配置 Upgrader 返 ErrUpgraderNotConfigured。
// 升级完成后不会自动重查版本 —— 调用方应再调 Discover 刷新缓存。
func Upgrade(ctx context.Context, id string) error {
	sp := specByID(id)
	if sp == nil || sp.Upgrader == nil {
		return ErrUpgraderNotConfigured
	}
	return sp.Upgrader.Upgrade(ctx)
}
