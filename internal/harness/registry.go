// registry.go:已知 harness 的发现/版本/升级配置(每 harness 一条 Spec)。
//
// Spec 是「静态元数据 + 行为接口」的组合:发现参数(BinaryName/VersionArgs/ExtraDirs)
// + 可选 ReleaseSource(查上游最新版本)+ 可选 Upgrader(触发升级)。
// Registry 是 Discovered 的输入,把「我们认识哪些 harness、各自怎么找/怎么升」收敛到一处。
//
// 不硬编码可执行文件路径:实际路径由 Discover 在运行时经 PATH + ExtraDirs 解析得到(§3.2
// 进程回收 harness 无关化的同源思想:此处也对 harness 安装方式不作假设)。
//
// 委派优先原则(§5.3 外部事实先验证):harness 自己最清楚发布渠道(npm/brew/curl/自建 CDN),
// 我们替它操心会做不全。因此 Source/Upgrader 优先委派给 harness 自带的 update/upgrade 子命令,
// 仅当 harness 无此能力时才回退到外部源(如 GitHubSource)。
package harness

import "regexp"

// Spec 单个已知 harness 的发现 + 版本 + 升级配置。
type Spec struct {
	ID          string   // 与 Harness.ID 对齐(omp/opencode)
	BinaryName  string   // 可执行文件名(不含扩展;Windows 上 Discover 自动加 .exe)
	VersionArgs []string // 拉本地版本的参数(如 ["--version"] / ["version"]);空 = 用默认 ["--version"]
	ExtraDirs   []string // 额外发现目录(绝对路径;如 ~/.bun/bin 等用户级安装位);空 = 仅 PATH

	// Source 查上游最新版本(可空 = 无已知发布源 → LatestVersion 永远空)。
	Source ReleaseSource
	// Upgrader 触发升级(可空 = 不支持升级 → Upgrade 返 ErrUpgraderNotConfigured)。
	Upgrader Upgrader
}

// versionArgs 返回该 Spec 的版本查询参数(空则回退默认 ["--version"])。
func (s Spec) versionArgs() []string {
	if len(s.VersionArgs) > 0 {
		return s.VersionArgs
	}
	return []string{"--version"}
}

// Registry 已知 harness 的 Spec 列表,顺序与 Supported 对齐(DefaultID 在首位)。
//
// 当前配置:
//   - opencode:无纯 check 命令(opencode upgrade 只装不查)→ Source 继续走 GitHub Releases;
//     Upgrader 委派给 `opencode upgrade`(它自带 --method 选 curl/npm/bun/brew/...,按用户原安装
//     方式升级,避免我们写死 curl 与 npm 全局副本打架)。官方文档 https://opencode.ai/docs。
//   - omp:自带 `omp update --check`(check-only,输出 "New version available: <ver>")→ Source 委派,
//     Pattern 锚定关键词提取(无匹配 = 已是最新 → Latest 空 → 前端显示「已是最新」);
//     Upgrader 委派给 `omp update`(幂等,与 omp 自身升级逻辑一致)。
var Registry = []Spec{
	{
		ID:         "opencode",
		BinaryName: "opencode",
		Source:     &GitHubSource{Repo: "sst/opencode"},
		Upgrader:   CommandUpgrader{Cmd: []string{"opencode", "upgrade"}},
	},
	{
		ID:         "omp",
		BinaryName: "omp",
		Source: &CommandSource{
			Cmd:     []string{"omp", "update", "--check"},
			Pattern: regexp.MustCompile(`New version available:\s*(\S+)`),
		},
		Upgrader: CommandUpgrader{Cmd: []string{"omp", "update"}},
	},
}

// specByID 查 Spec;未找到返回 nil(调用方负责降级)。
func specByID(id string) *Spec {
	for i := range Registry {
		if Registry[i].ID == id {
			return &Registry[i]
		}
	}
	return nil
}
