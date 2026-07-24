package acp

// probe.go:ProbeHarness —— ACP harness conformance 自检探针。
//
// 用途:新增一个 harness 前,跑一遍受控生命周期,验证它满足我们对 ACP 契约的依赖,
// 并把能力矩阵 + 行为特征查清。这是把"ACP 是接口、harness 是可互换实例"从论断变成
// 可证伪实验的那块拼图(见 docs/worklog 的 goose 数据集 / jcode 测试集 实验)。
//
// 设计原则(呼应 AGENTS §5.3 / §5.4):
//   - 不走 ChatSession / registerHarness:一次性诊断,跑完即弃,不进活跃集合、不污染 DB。
//   - 每步带硬超时:这是诊断,不是活 turn。§3.3 那条"Prompt 不设静默超时"是给活对话的
//     (让 turn 跑到自然 end_turn);探针必须带超时,否则碰到 mcpServers:null 那种死挂会
//     把探针自己挂住(§5.4 #goose)。
//   - 两层报告:Tier1 硬门槛(Initialized/NewSession/Streamed)不过 = 不能加;Tier2 能力
//     矩阵与行为特征永不阻断,只决定降级路径(resume 缺→skip-setup、messageId 缺→tool 合并)。
//   - 零 per-harness 身份分支:探针只看能力位与协议字段,绝不 if harnessID == X(实验硬约束)。

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/acp-go-sdk"
)

// CheckResult 单项检查结果。
type CheckResult struct {
	Pass bool   `json:"pass"`
	Note string `json:"note,omitempty"` // 通过/失败的细节(失败时含简短原因)
}

// ConformanceReport ProbeHarness 的产出:harness 的 ACP 健康体检单。
type ConformanceReport struct {
	Command     string `json:"command"` // 探测的启动命令(如 "goose acp")
	AgentName   string `json:"agentName"`
	ProtocolVer int    `json:"protocolVersion"`

	// Tier 1 硬门槛:任一不过 = CanAdd() 为假。
	Initialized CheckResult `json:"initialized"` // spawn + Initialize 返回合法 AgentCapabilities
	NewSession  CheckResult `json:"newSession"`  // 能在临时目录建 session
	Streamed    CheckResult `json:"streamed"`    // 至少流式吐出一条 agent_message_chunk(ACP 产出契约)

	// Tier 1 软:理想 end_turn,但流式产出即可证 ACP 健康(模型未配 key 会失败,非 conformance 问题)。
	PromptTurn CheckResult `json:"promptTurn"`

	// Tier 2 能力矩阵(Initialize 协商,永不阻断,决定可用功能)。
	LoadSession bool `json:"loadSession"` // session/load
	Resume      bool `json:"resume"`      // session/resume(无→恢复走 skip-setup,goose 同款)
	List        bool `json:"list"`        // session/list(无→session 标题降级)
	Close       bool `json:"close"`       // session/close
	Image       bool `json:"image"`       // promptCapabilities.image
	Audio       bool `json:"audio"`
	Providers   bool `json:"providers"` // UNSTABLE:provider 配置

	// 行为特征:哪条防御路径会生效(见 §5.4)。
	SawMessageChunk bool `json:"sawMessageChunk"`
	EmitsMessageId  bool `json:"emitsMessageId"` // 有 message/thought chunk 且携带 messageId

	// 功能覆盖(可选功能刻画;缺了只降级、不阻断,供体检单预警用户)。
	ConfigOptions    int  `json:"configOptions"`    // NewSession 返回的 configOption 数
	HasModelOption   bool `json:"hasModelOption"`   // 有 category:"model" 的 configOption(无→会话中不能切模型,如 jcode 靠 -p)
	ReportedUsage    bool `json:"reportedUsage"`    // 发 usage_update 或 Usage 非空(无→不显示 token/成本)
	StreamedThoughts bool `json:"streamedThoughts"` // 发 agent_thought_chunk(无→看不到 reasoning)
	UsedTools        bool `json:"usedTools"`        // 发 tool_call(无害 prompt 下未必触发)

	// ObservedKinds 本次 Prompt 期间观察到的事件 kind 集合(诊断用)。
	ObservedKinds []string `json:"observedKinds,omitempty"`

	// Error 探针自身失败(spawn 起不来 / Initialize 崩溃等),非 conformance 判定。
	Error string `json:"error,omitempty"`
}

// CanAdd 严格门槛:Tier1 全过(Initialized + NewSession + Streamed + PromptTurn=end_turn)。
// 要求完整跑完一轮(end_turn):不仅证 ACP 健康,还证该 harness 在当前环境真能干活
// (模型/key/网络就绪)。能力矩阵缺失只降级、不阻断。
func (r ConformanceReport) CanAdd() bool {
	return r.Initialized.Pass && r.NewSession.Pass && r.Streamed.Pass && r.PromptTurn.Pass
}

// Summary 人话体检单(供 UI / 日志展示)。
func (r ConformanceReport) Summary() string {
	var b strings.Builder
	verdict := "❌ 不能添加"
	if r.CanAdd() {
		verdict = "✅ 可以添加"
	}
	fmt.Fprintf(&b, "harness: %s  (%s)\n", r.AgentName, r.Command)
	fmt.Fprintf(&b, "[Tier1] init=%v session=%v stream=%v turn=%v\n",
		mark(r.Initialized.Pass), mark(r.NewSession.Pass), mark(r.Streamed.Pass), mark(r.PromptTurn.Pass))
	fmt.Fprintf(&b, "[能力] resume=%v list=%v load=%v image=%v providers=%v\n",
		mark(r.Resume), mark(r.List), mark(r.LoadSession), mark(r.Image), mark(r.Providers))
	fmt.Fprintf(&b, "[行为] messageId=%s\n", messageIdVerdict(r))
	// 功能覆盖:缺了的可选功能 → 预警(不阻断,仅降级;让用户添加前知情)。
	fmt.Fprintf(&b, "[功能] 模型选择器=%s 用量=%s 思考流=%s (configOptions=%d)\n",
		mark(r.HasModelOption), mark(r.ReportedUsage), mark(r.StreamedThoughts), r.ConfigOptions)
	var gaps []string
	if !r.HasModelOption {
		gaps = append(gaps, "无模型选择器(模型靠启动命令定)")
	}
	if !r.ReportedUsage {
		gaps = append(gaps, "不报 token 用量")
	}
	if !r.StreamedThoughts {
		gaps = append(gaps, "无思考流")
	}
	if len(gaps) > 0 {
		fmt.Fprintf(&b, "[预警] %s —— 可添加但功能受限\n", strings.Join(gaps, "、"))
	}
	fmt.Fprintf(&b, "结论: %s\n", verdict)
	return b.String()
}

func mark(b bool) string {
	if b {
		return "✓"
	}
	return "✗"
}

func messageIdVerdict(r ConformanceReport) string {
	if !r.SawMessageChunk {
		return "未观察到 message chunk"
	}
	if r.EmitsMessageId {
		return "发 → 按 messageId 归并"
	}
	return "不发 → 按 tool 边界归并(已支持)"
}

// 探针超时(诊断场景,硬超时;与活 turn 的 §3.3 no-timeout 无关)。
const (
	probeInitTimeout = 20 * time.Second
	probeSessTimeout = 20 * time.Second
	probeTurnTimeout = 90 * time.Second // 首条模型调用可能慢
)

// ProbeHarness 对 command 指定的 ACP harness 跑一次受控 conformance 探针。
//
// 流程:临时目录隔离 → spawn+Initialize(抓能力矩阵)→ NewSession → Prompt(无害消息,
// 收集事件 kind 与 messageId)→ 干净 teardown(进程组回收)。
//
// 返回 *ConformanceReport(永远非 nil,哪怕探针自身出错也会回填 Error);CanAdd() 判定可否添加。
func ProbeHarness(ctx context.Context, command string) *ConformanceReport {
	rep := &ConformanceReport{Command: command}

	workDir, err := os.MkdirTemp("", "md-probe-*")
	if err != nil {
		rep.Error = fmt.Sprintf("tempdir: %v", err)
		return rep
	}
	defer os.RemoveAll(workDir)

	runner := NewRunner(command, nil)

	// 事件收集:ACP 回调在独立 goroutine 触发,需线程安全。
	var mu sync.Mutex
	kinds := make(map[string]struct{})
	var sawChunk, sawMessageID, sawThoughts, sawTools, sawUsage bool

	var handler *Handler
	onEvent := func(e SessionEvent) {
		mu.Lock()
		defer mu.Unlock()
		kinds[e.Kind] = struct{}{}
		switch e.Kind {
		case "agent_message_chunk", "agent_thought_chunk":
			sawChunk = true
			if e.MessageID != "" {
				sawMessageID = true
			}
			if e.Kind == "agent_thought_chunk" {
				sawThoughts = true
			}
		case "tool_call":
			sawTools = true
		case "usage_update":
			sawUsage = true
		}
	}
	onPermission := func(p PermissionPrompt) {
		// 自动放行(取首个 allow 类 option);"reply OK" 理论上不触发工具。
		// 真触发说明该 harness 在无害 prompt 下就要求权限 —— 也是一条诊断信息。
		if handler == nil {
			return
		}
		for _, o := range p.Options {
			if strings.HasPrefix(o.Kind, "allow") {
				handler.RespondPermission(p.ID, o.OptionID)
				return
			}
		}
		if len(p.Options) > 0 {
			handler.RespondPermission(p.ID, p.Options[0].OptionID)
		}
	}
	handler = NewHandler(workDir, onEvent, onPermission, 0)

	// 1. spawn + Initialize。
	initCtx, cancelInit := context.WithTimeout(ctx, probeInitTimeout)
	defer cancelInit()
	proc, conn, initResp, err := runner.spawnAndInit(initCtx, workDir, handler)
	if err != nil {
		rep.Error = fmt.Sprintf("initialize: %v", err)
		rep.Initialized = CheckResult{Pass: false, Note: truncate(err.Error(), 200)}
		return rep
	}
	live := true
	defer func() {
		if live {
			proc.shutdown() // 回收进程组(§3.2)
		}
	}()
	rep.AgentName = initResp.AgentInfo.Name
	rep.ProtocolVer = int(initResp.ProtocolVersion)
	rep.Initialized = CheckResult{Pass: true, Note: fmt.Sprintf("agent=%s protocol=%d", initResp.AgentInfo.Name, initResp.ProtocolVersion)}
	// 能力矩阵(纯协商,零身份分支)。
	sc := initResp.AgentCapabilities.SessionCapabilities
	rep.LoadSession = initResp.AgentCapabilities.LoadSession
	rep.Resume = sc.Resume != nil
	rep.List = sc.List != nil
	rep.Close = sc.Close != nil
	rep.Image = initResp.AgentCapabilities.PromptCapabilities.Image
	rep.Audio = initResp.AgentCapabilities.PromptCapabilities.Audio
	rep.Providers = initResp.AgentCapabilities.Providers != nil

	// 2. NewSession(临时目录,非 nil 空 mcpServers —— 规避 goose 的 null 死挂,§5.4)。
	sessCtx, cancelSess := context.WithTimeout(ctx, probeSessTimeout)
	defer cancelSess()
	sess, err := conn.NewSession(sessCtx, acp.NewSessionRequest{
		Cwd:        workDir,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		rep.NewSession = CheckResult{Pass: false, Note: truncate(err.Error(), 200)}
		return rep
	}
	rep.NewSession = CheckResult{Pass: true, Note: fmt.Sprintf("sessionId=%s configOptions=%d", safeID(sess.SessionId), len(sess.ConfigOptions))}
	// 功能覆盖刻画:configOptions 数 + 是否有模型选择器(category:"model")。
	rep.ConfigOptions = len(sess.ConfigOptions)
	for _, co := range sess.ConfigOptions {
		if co.Select != nil && co.Select.Category != nil && string(*co.Select.Category) == "model" {
			rep.HasModelOption = true
		}
	}

	// 3. Prompt(无害消息,带超时)。期间 SessionUpdate 并发流入 onEvent。
	turnCtx, cancelTurn := context.WithTimeout(ctx, probeTurnTimeout)
	defer cancelTurn()
	presp, perr := conn.Prompt(turnCtx, acp.PromptRequest{
		SessionId: sess.SessionId,
		Prompt:    []acp.ContentBlock{acp.TextBlock("Reply with exactly these two characters: OK")},
	})

	mu.Lock()
	rep.SawMessageChunk = sawChunk
	rep.EmitsMessageId = sawMessageID
	rep.StreamedThoughts = sawThoughts
	rep.UsedTools = sawTools
	for k := range kinds {
		rep.ObservedKinds = append(rep.ObservedKinds, k)
	}
	mu.Unlock()
	rep.Streamed = CheckResult{Pass: sawChunk, Note: joinKinds(rep.ObservedKinds)}

	switch {
	case perr != nil:
		rep.PromptTurn = CheckResult{Pass: false, Note: "error: " + truncate(perr.Error(), 160)}
		// 流式已产出即证 ACP 健康(模型未配 key 会在此报错,但 conformance 已成立)。
	case presp.StopReason == acp.StopReasonEndTurn:
		rep.PromptTurn = CheckResult{Pass: true, Note: "end_turn"}
	default:
		rep.PromptTurn = CheckResult{Pass: false, Note: fmt.Sprintf("stopReason=%s", presp.StopReason)}
	}
	rep.ReportedUsage = sawUsage || presp.Usage != nil

	// 4. 干净 teardown:尽力 close,再回收进程组。
	closeCtx, cancelClose := context.WithTimeout(ctx, 5*time.Second)
	defer cancelClose()
	if sc.Close != nil {
		_, _ = conn.CloseSession(closeCtx, acp.CloseSessionRequest{SessionId: sess.SessionId})
	}
	return rep
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func safeID(id acp.SessionId) string {
	s := string(id)
	if len(s) > 12 {
		return s[:12] + "…"
	}
	return s
}

func joinKinds(ks []string) string {
	if len(ks) == 0 {
		return "(无事件)"
	}
	return strings.Join(ks, ",")
}
