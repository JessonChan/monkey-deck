// Package harness 提供受支持的 ACP harness 注册表与运行时发现/版本检测/升级管理。
// monkey-deck 是纯 ACP client(§1.1):harness 是 peer,我们 spawn 它的 stdio ACP server。
// 目前已知 harness:omp(默认)/ opencode / goose。
//
// 三层概念(分层以避免硬编码,§5.3 KISS):
//   - Supported(var):注册表静态默认(ID/Name/Command/Icon 四段),供 Command/Normalize/进程回收/
//     前端取图标用,始终全量、顺序稳定(DefaultID 在首位)。这部分不变,保持现有契约。
//   - Discovered(func):运行时发现结果 —— 在 Supported 基础上补 Path/Installed/InstalledVersion/
//     LatestVersion/UpgradeAvailable,供前端 harness 管理面板展示「装了没 / 是否最新 / 能否升级」。
//   - Registry(per-Spec 配置):每个已知 harness 的发现参数(BinaryName/VersionArgs)+ 可选的
//     ReleaseSource(查上游最新版本)+ 可选的 Upgrader(触发升级)。Registry 是 Discovered 的输入。
//
// 各 harness 的 ACP 实现差异仍在此包抹平(§2.1)。
package harness

// Harness 一个受支持的 ACP harness。
//
// 字段分两组:
//   - 静态(Supported 注册表填充):ID/Name/Command/Icon,始终非空(ID/Name/Command;Icon 空表示无官方图标)。
//   - 运行时(Discovered 填充):Path/Installed/InstalledVersion/LatestVersion/UpgradeAvailable/
//     UpgradeError,在静态基础上补充本地安装状态与上游版本信息。
type Harness struct {
	ID      string `json:"id"`      // 标识(omp/opencode),存进 session.harness
	Name    string `json:"name"`    // 显示名
	Command string `json:"command"` // stdio ACP 启动命令(规范形,如 "omp acp")
	Icon    string `json:"icon"`    // 官方图标资源路径(如 "assets/harness-icons/omp.svg");空 = 无 / 走兜底

	// 运行时(发现 + 版本检测填充)。Supported 静态默认里这些为零值。
	Path             string `json:"path,omitempty"`             // 可执行文件绝对路径(空 = 未发现)
	Installed        bool   `json:"installed"`                   // 本地是否已安装(能 LookPath 到)
	InstalledVersion string `json:"installedVersion,omitempty"` // `<bin> --version` 解析版本(空 = 未装/解析失败)
	LatestVersion    string `json:"latestVersion,omitempty"`    // 上游 release 最新版本(空 = 未查/无源)
	UpgradeAvailable bool   `json:"upgradeAvailable"`            // InstalledVersion < LatestVersion
	UpgradeError     string `json:"upgradeError,omitempty"`     // 上次升级报错(前端展示;空 = 无)
}

// Supported 受支持 harness 的静态注册表(前端选择器 + 进程回收 + Command/Normalize 用)。
// 第一项为默认 harness。始终全量、顺序稳定;不掺运行时数据(运行时数据走 Discovered)。
//
// Icon 指向 assets/harness-icons/ 下的官方图标资源路径(单一事实源:文件名 = ID,
// 扩展名随源项目原图格式——svg 或 png,见 assets/harness-icons/README.md)。前端据此取图,
// 未知 harness 的 Icon 为空时由前端走 lucide Bot 兜底。
var Supported = []Harness{
	{ID: "omp", Name: "Oh My Pi", Command: "omp acp", Icon: "assets/harness-icons/omp.svg"},
	{ID: "opencode", Name: "OpenCode", Command: "opencode acp", Icon: "assets/harness-icons/opencode.svg"},
	{ID: "goose", Name: "Goose", Command: "goose acp", Icon: "assets/harness-icons/goose.svg"},
}

// DefaultID 默认 harness(omp)。
const DefaultID = "omp"

// Normalize 把 harness id 归一化:空或未知回退到默认(omp)。
func Normalize(id string) string {
	for _, h := range Supported {
		if h.ID == id {
			return id
		}
	}
	return DefaultID
}

// Command 返回 harness id 对应的 stdio ACP 启动命令;未知 id 回退到默认 harness。
func Command(id string) string {
	for _, h := range Supported {
		if h.ID == id {
			return h.Command
		}
	}
	return Command(DefaultID)
}

// Commands 返回所有受支持 harness 的 stdio ACP 启动命令(如 ["omp acp","opencode acp"])。
// 供进程回收层识别本应用派生的 harness(§3.2):启动时注入 acp.SetHarnessCommands。
func Commands() []string {
	cmds := make([]string, 0, len(Supported))
	for _, h := range Supported {
		cmds = append(cmds, h.Command)
	}
	return cmds
}
