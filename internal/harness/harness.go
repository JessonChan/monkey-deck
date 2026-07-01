// Package harness 提供受支持的 ACP harness 注册表。
// monkey-deck 是纯 ACP client(§1.1):harness 是 peer,我们 spawn 它的 stdio ACP server。
// 目前支持:omp(默认)/ opencode。各 harness 的 ACP 实现差异在此抹平(§2.1)。
package harness

// Harness 一个受支持的 ACP harness。
type Harness struct {
	ID      string `json:"id"`      // 标识(omp/opencode),存进 session.harness
	Name    string `json:"name"`    // 显示名
	Command string `json:"command"` // stdio ACP 启动命令(如 "omp acp")
}

// Supported 受支持的 harness 列表(前端选择器用)。第一项为默认 harness。
var Supported = []Harness{
	{ID: "omp", Name: "Oh My Pi", Command: "omp acp"},
	{ID: "opencode", Name: "OpenCode", Command: "opencode acp"},
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

// IsOpenCode 报告 id 是否为 opencode。
// 决定 model 注入是否走 opencode.json(§3.5);其它 harness 的 model 注入方式待各自适配。
// 注意:与默认 harness 无关 —— 显式判 "opencode",不随 DefaultID 变化。
func IsOpenCode(id string) bool { return Normalize(id) == "opencode" }
