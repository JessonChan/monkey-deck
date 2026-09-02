// Package harness 提供受支持的 ACP harness 注册表与运行时发现/版本检测/升级管理。
// 本文件(known.go)承载一个「已知 ACP agent 目录」(KnownCatalog),与 Supported 注册表
// (omp/opencode,§1.x 默认 harness 契约)严格分离:KnownCatalog 只读、不参与进程回收、
// 不进 SQLite、不 spawn,唯一用途是「按启动命令关键词匹配 → 自动选 harness」(Add Harness 弹窗)。
package harness

import (
	"strings"
)

// KnownHarness 已知 ACP harness 的轻量目录条目,仅供命令关键词匹配自动选。
// 前端 HarnessIcon 只用 ID 自行解析图标 URL(/harness-icons/<id>.<ext>,§2.1),故本
// 结构不带 Icon 路径字段(图标文件已落地 assets/harness-icons/<id>.<ext>)。
type KnownHarness struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Keywords []string `json:"keywords"`
}

// knownSeed 目录种子:id + 显示名 + 主命令别名(用户最可能在启动命令里敲的词)。
// 关键词由 id / 别名 + 其 dash 分词派生(排除通用词防误中,见 deriveKeywords),不依赖
// name 分词(避免 "Code"/"Agent" 这类通用词误命中大量命令)。
var knownSeed = []struct {
	ID    string
	Name  string
	Alias string
}{
	{"agentpool", "AgentPool", "agentpool"},
	{"agoragentic", "Agoragentic", "agora"},
	{"amp", "Amp", "amp"},
	{"augment-code", "Augment Code", "augment"},
	{"autodev", "AutoDev", "autodev"},
	{"autohand-code", "Autohand Code", "autohand"},
	{"blackbox-ai", "Blackbox AI", "blackbox"},
	{"bub", "Bub", "bub"},
	{"claude-agent", "Claude Agent", "claude"},
	{"cline", "Cline", "cline"},
	{"code-assistant", "Code Assistant", "code-assistant"},
	{"codebuddy-code", "Codebuddy Code", "codebuddy"},
	{"codex-cli", "Codex CLI", "codex"},
	{"construct", "Construct", "construct"},
	{"corust-agent", "Corust Agent", "corust"},
	{"cortex-code", "Cortex Code", "cortex"},
	{"crow-cli", "crow-cli", "crow"},
	{"cursor", "Cursor", "cursor"},
	{"deepagents", "DeepAgents", "deepagents"},
	{"devin", "Devin", "devin"},
	{"dimcode", "DimCode", "dimcode"},
	{"dirac", "Dirac", "dirac"},
	{"docker-cagent", "Docker cagent", "cagent"},
	{"fast-agent", "fast-agent", "fast-agent"},
	{"factory-droid", "Factory Droid", "factory"},
	{"fount", "fount", "fount"},
	{"gemini-cli", "Gemini CLI", "gemini"},
	{"github-copilot", "GitHub Copilot", "copilot"},
	{"glm-agent", "GLM Agent", "glm"},
	{"goose", "Goose", "goose"},
	{"grok-build", "Grok Build", "grok"},
	{"harn", "Harn", "harn"},
	{"hermes-agent", "Hermes Agent", "hermes"},
	{"junie", "Junie", "junie"},
	{"kilo", "Kilo", "kilo"},
	{"kimi-cli", "Kimi CLI", "kimi"},
	{"kiro-cli", "Kiro CLI", "kiro"},
	{"minion-code", "Minion Code", "minion"},
	{"mistral-vibe", "Mistral Vibe", "mistral"},
	{"nova", "Nova", "nova"},
	{"openclaw", "OpenClaw", "openclaw"},
	{"openhands", "OpenHands", "openhands"},
	{"pi", "Pi", "pi"},
	{"poolside", "Poolside", "poolside"},
	{"qoder-cli", "Qoder CLI", "qoder"},
	{"qwen-code", "Qwen Code", "qwen"},
	{"sigit-code", "siGit Code", "sigit"},
	{"stakpak", "Stakpak", "stakpak"},
	{"stdio-bus", "stdio Bus", "stdiobus"},
	{"vt-code", "VT Code", "vtcode"},
}

// genericTokens 派生关键词时丢弃的通用 token,避免 "agent"/"code" 之类误中大量命令。
var genericTokens = map[string]struct{}{
	"agent": {}, "ai": {}, "cli": {}, "code": {}, "dev": {}, "build": {},
}

// KnownCatalog 已知 harness 目录(README 列出的非内置 ACP agent,顺序稳定)。
var KnownCatalog []KnownHarness

func init() {
	KnownCatalog = make([]KnownHarness, 0, len(knownSeed))
	for _, s := range knownSeed {
		KnownCatalog = append(KnownCatalog, KnownHarness{
			ID:       s.ID,
			Name:     s.Name,
			Keywords: deriveKeywords(s.ID, s.Alias),
		})
	}
}

// deriveKeywords 由 id + 别名 + 其 dash 分词生成去重关键词,剔除通用词与空串。
func deriveKeywords(id, alias string) []string {
	set := map[string]struct{}{}
	add := func(s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" {
			return
		}
		if _, ok := genericTokens[s]; ok {
			return
		}
		set[s] = struct{}{}
	}
	add(id)
	add(alias)
	for _, tok := range splitTokens(id) {
		add(tok)
	}
	for _, tok := range splitTokens(alias) {
		add(tok)
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	return out
}

// splitTokens 按空白与常见分隔符(- _ / . @)切分,供短关键词整词匹配与派生使用。
func splitTokens(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return r == '-' || r == '_' || r == ' ' || r == '/' || r == '.' || r == '@'
	})
}

// MatchKnownHarness 按启动命令做关键词匹配,返回最匹配的已知 harness;无命中返回 nil。
//
// 匹配规则(§5.3 找不变量,不堆 if):命令转小写;对每个已知 harness,任一 keyword 命中即候选,
// 取 keyword 最长者(更具体的 harness 优先,如 "github-copilot" 优先于 "pi")。短 keyword
// (<4 字符,如 "pi"/"amp")须整词命中命令 token,避免 "pi"⊂"shipping" 这类误中。
//
// 前端「添加 harness」弹窗据返回值自动选 harness + 预填 Name(用户可覆盖)。
func MatchKnownHarness(command string) *KnownHarness {
	cmd := strings.ToLower(strings.TrimSpace(command))
	if cmd == "" {
		return nil
	}
	cmdTokens := splitTokens(cmd)
	var best *KnownHarness
	bestScore := 0
	for i := range KnownCatalog {
		kh := &KnownCatalog[i]
		for _, kw := range kh.Keywords {
			hit := false
			if len(kw) >= 4 {
				hit = strings.Contains(cmd, kw)
			} else {
				for _, t := range cmdTokens {
					if t == kw {
						hit = true
						break
					}
				}
			}
			if hit {
				if len(kw) > bestScore {
					best = kh
					bestScore = len(kw)
				}
				break
			}
		}
	}
	return best
}
