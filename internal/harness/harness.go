// Package harness 提供受支持的 ACP harness 注册表。
// monkey-deck 是纯 ACP client(§1.1):harness 是 peer,我们 spawn 它的 stdio ACP server。
// 目前支持:opencode / mino / omp。各 harness 的 ACP 实现差异在此抹平(§2.1)。
package harness

// Harness 一个受支持的 ACP harness。
type Harness struct {
	ID      string `json:"id"`      // 标识(opencode/mino/omp),存进 session.harness
	Name    string `json:"name"`    // 显示名
	Command string `json:"command"` // stdio ACP 启动命令(如 "opencode acp")
}

// Supported 受支持的 harness 列表(前端选择器用)。
var Supported = []Harness{
	{ID: "opencode", Name: "OpenCode", Command: "opencode acp"},
	{ID: "mino", Name: "Mino", Command: "mino acp"},
	{ID: "omp", Name: "Oh My Pi", Command: "omp acp"},
}

// DefaultID 默认 harness(opencode)。
const DefaultID = "opencode"

// Normalize 把 harness id 归一化:空或未知回退到 opencode。
func Normalize(id string) string {
	for _, h := range Supported {
		if h.ID == id {
			return id
		}
	}
	return DefaultID
}

// Command 返回 harness id 对应的 stdio ACP 启动命令;未知 id 回退到 opencode。
func Command(id string) string {
	for _, h := range Supported {
		if h.ID == id {
			return h.Command
		}
	}
	return Supported[0].Command
}

// IsOpenCode 报告 id 是否为 opencode。
// 决定 model 注入是否走 opencode.json(§3.5);其它 harness 的 model 注入方式待各自适配。
func IsOpenCode(id string) bool { return Normalize(id) == DefaultID }
