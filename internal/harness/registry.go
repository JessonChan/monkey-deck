// registry.go:已知 harness 的发现/版本/升级配置(每 harness 一条 Spec)。
//
// Spec 是「静态元数据 + 行为接口」的组合:发现参数(BinaryName/VersionArgs/ExtraDirs)
// + 可选 ReleaseSource(查上游最新版本)+ 可选 Upgrader(触发升级)。
// Registry 是 Discovered 的输入,把「我们认识哪些 harness、各自怎么找/怎么升」收敛到一处。
//
// 不硬编码可执行文件路径:实际路径由 Discover 在运行时经 PATH + ExtraDirs 解析得到(§3.2
// 进程回收 harness 无关化的同源思想:此处也对 harness 安装方式不作假设)。
package harness

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
// Discovered 遍历此表生成运行时 Harness 列表。
//
// 当前配置:
//   - opencode:GitHub Releases(sst/opencode)查最新版本;升级走官方安装脚本(幂等,
//     已装则升级到最新)。opencode 官方安装/升级方式见 https://opencode.ai/docs。
//   - omp:暂无公开发布源(Source=nil);Upgrader 暂缺。装了就显示版本,没装就标未安装。
//     后续确定发布源/包管理器后在此处补 Source/Upgrader 即可,无需改其它代码。
var Registry = []Spec{
	{
		ID:         "opencode",
		BinaryName: "opencode",
		Source:     &GitHubSource{Repo: "sst/opencode"},
		Upgrader:   CommandUpgrader{Cmd: []string{"bash", "-c", "curl -fsSL https://opencode.ai/install | bash"}},
	},
	{
		ID:         "omp",
		BinaryName: "omp",
		// Source/Upgrader 暂缺 —— 待 omp 的发布源确定后补(见上方注释)。
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
