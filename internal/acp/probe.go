package acp

// probe.go:ProbeHarness —— ACP harness conformance 自检探针(声明即用流程的「自检」环节)。
//
// 用途:新增一个 harness 前,跑一遍受控生命周期,验证它满足我们对 ACP 契约的依赖,
// 并把能力矩阵 + 行为特征查清。这是把"ACP 是接口、harness 是可互换实例"从论断变成
// 可证伪实验的那块拼图。
//
// 设计原则(呼应 AGENTS §5.3 / §5.4):
//   - 不走 ChatSession / registerHarness:一次性诊断,跑完即弃,不进活跃集合、不污染 DB。
//   - 每步带硬超时:这是诊断,不是活 turn。§3.3 那条"Prompt 不设静默超时"是给活对话的
//     (让 turn 跑到自然 end_turn);探针必须带超时,否则碰到 mcpServers:null 那种死挂会
//     把探针自己挂住。
//   - 两层报告:Tier1 硬门槛(Initialized/NewSession/Streamed/PromptTurn)不过 = 不能加;Tier2 能力
//     矩阵与行为特征永不阻断,只决定降级路径(resume 缺→skip-setup、messageId 缺→tool 合并)。
//   - 零 per-harness 身份分支:探针只看能力位与协议字段,绝不 if harnessID == X。

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
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
	Command     string `json:"command"` // 探测的启动命令(如 "junie acp")
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
	Resume      bool `json:"resume"`      // session/resume(无→恢复走 skip-setup)
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
	HasModelOption   bool `json:"hasModelOption"`   // 有 category:"model" 的 configOption(无→会话中不能切模型)
	ReportedUsage    bool `json:"reportedUsage"`    // 发 usage_update 或 Usage 非空(无→不显示 token/成本)
	StreamedThoughts bool `json:"streamedThoughts"` // 发 agent_thought_chunk(无→看不到 reasoning)
	UsedTools        bool `json:"usedTools"`        // 发 tool_call(无害 prompt 下未必触发)
	// Tier 2 behavioral probes (non-blocking; characterize client→agent RPC conformance).
	ResumeReplays  bool `json:"resumeReplays"`  // session/resume replayed history (violates session-resume.mdx MUST NOT replay)
	CancelHonored  bool `json:"cancelHonored"`  // harness replied stopReason=cancelled after session/cancel
	SetConfigWorks bool `json:"setConfigWorks"` // session/set_config_option round-trip returned full state

	// Fork UNSTABLE session/fork 探针(issue #172 Phase 1;Tier2 永不阻断 CanAdd)。
	Fork ForkReport `json:"fork"`

	// ObservedKinds 本次 Prompt 期间观察到的事件 kind 集合(诊断用)。
	ObservedKinds []string `json:"observedKinds,omitempty"`

	// Error 探针自身失败(spawn 起不来 / Initialize 崩溃等),非 conformance 判定。
	Error string `json:"error,omitempty"`
}

// ForkReport UNSTABLE session/fork 探针结果(issue #172 Phase 1)。
//
// 三段产出:P1 声明位(Declared)+ P2 undeclared 强 fork 错误码锚定(Force/ForceClass)
// + P3 declared 最小往返取证(①-⑧:六问 + fork 链 + 并发两个扩展)。
// 每项独立 CheckResult;不适用/前置失败也必须落行(Note 标 "N/A: 原因"),绝不静默省略。
type ForkReport struct {
	// Declared Initialize 响应 SessionCapabilities.Fork 非 nil(P1 声明矩阵行)。
	Declared bool `json:"declared"`

	// Force undeclared 时的强 fork 取证串:"forced-fork: <code> <message>";
	// declared 或探针未跑到(NewSession 失败等)时为空。
	Force string `json:"force,omitempty"`
	// ForceClass 强 fork 结果分类:method-not-found / invalid-params / other /
	// no-answer(无 JSON-RPC 错误响应,如超时/断连)/
	// unexpected-success(未声明却 fork 成功 —— 声明与实现不一致,本身是发现)。
	ForceClass string `json:"forceClass,omitempty"`

	// P3 declared 往返逐项(六问 ①-⑥ + 扩展 ⑦⑧)。
	NewID       CheckResult `json:"newId"`       // ① 新 sessionId ≠ 源
	SourceAlive CheckResult `json:"sourceAlive"` // ② fork 后源 session 仍可 prompt(最小提示词)
	InList      CheckResult `json:"inList"`      // ③ session/list 含新 id
	Resumable   CheckResult `json:"resumable"`   // ④ 新 id 可 load/resume
	Echo        CheckResult `json:"echo"`        // ⑤ fork 响应 configOptions/modes 回显与源一致
	Cwd         CheckResult `json:"cwd"`         // ⑥ 同 cwd vs 新 cwd fork 行为差异记录
	Chain       CheckResult `json:"chain"`       // ⑦ fork 链(对 fork 结果再 fork)
	Concurrent  CheckResult `json:"concurrent"`  // ⑧ 源/fork 并发各一发 prompt 互扰观察

	// Busy-fork 四项实测(issue #191):源 turn 进行中 fork 的行为。
	// 任何一项失败都是「停在探针」的判据(实现卡 #28965 的硬前置门)。
	BusyFork    CheckResult `json:"busyFork"`    // ① 源 turn 进行中 fork RPC 成功(新 id ≠ 源)
	BusySnap    CheckResult `json:"busySnap"`    // ② fork 上下文快照点(load/resume 回放观察,如实记录)
	BusySrcOK   CheckResult `json:"busySrcOk"`   // ③ 源 turn 不受干扰(end_turn + fork 后流式延续)
	BusyForkUse CheckResult `json:"busyForkUse"` // ④ fork 后串行 prompt fork 行可用(end_turn)

	// Error fork 探针自身异常(panic 兜底等);空 = 正常收敛出报告。
	Error string `json:"error,omitempty"`
}

// CanAdd 严格门槛:Tier1 全过(Initialized + NewSession + Streamed + PromptTurn=end_turn)。
// 要求完整跑完一轮(end_turn):不仅证 ACP 健康,还证该 harness 在当前环境真能干活
// (模型/key/网络就绪)。能力矩阵缺失只降级、不阻断。
func (r ConformanceReport) CanAdd() bool {
	return r.Initialized.Pass && r.NewSession.Pass && r.Streamed.Pass && r.PromptTurn.Pass
}

// Summary 人话体检单(供日志展示;前端按 JSON 字段自渲染)。
func (r ConformanceReport) Summary() string {
	var b strings.Builder
	verdict := "❌ 不能添加"
	if r.CanAdd() {
		verdict = "✅ 可以添加"
	}
	fmt.Fprintf(&b, "harness: %s  (%s)\n", r.displayName(), r.Command)
	fmt.Fprintf(&b, "[Tier1] init=%v session=%v stream=%v turn=%v\n",
		mark(r.Initialized.Pass), mark(r.NewSession.Pass), mark(r.Streamed.Pass), mark(r.PromptTurn.Pass))
	fmt.Fprintf(&b, "[能力] resume=%v list=%v load=%v image=%v providers=%v\n",
		mark(r.Resume), mark(r.List), mark(r.LoadSession), mark(r.Image), mark(r.Providers))
	fmt.Fprintf(&b, "[行为] messageId=%s\n", messageIdVerdict(r))
	fmt.Fprintf(&b, "[fork] ")
	if r.Fork.Declared {
		fmt.Fprintf(&b, "declared 新id=%s 源存活=%s list=%s resume=%s 回显=%s cwd=%s 链=%s 并发=%s\n",
			forkMark(r.Fork.NewID), forkMark(r.Fork.SourceAlive), forkMark(r.Fork.InList),
			forkMark(r.Fork.Resumable), forkMark(r.Fork.Echo), forkMark(r.Fork.Cwd),
			forkMark(r.Fork.Chain), forkMark(r.Fork.Concurrent))
		fmt.Fprintf(&b, "[fork] busy 中fork=%s 快照=%s 源无扰=%s fork可用=%s\n",
			forkMark(r.Fork.BusyFork), forkMark(r.Fork.BusySnap),
			forkMark(r.Fork.BusySrcOK), forkMark(r.Fork.BusyForkUse))
	} else if r.Fork.Force != "" {
		fmt.Fprintf(&b, "undeclared %s(%s)\n", r.Fork.Force, r.Fork.ForceClass)
	} else {
		fmt.Fprintf(&b, "undeclared(往返未执行)\n")
	}
	if r.Fork.Error != "" {
		fmt.Fprintf(&b, "[fork] 探针异常: %s\n", r.Fork.Error)
	}
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

// forkMark fork 逐项结果渲染:N/A 行(不适用/前置失败)显式标 n/a,不与失败 ✗ 混淆。
func forkMark(cr CheckResult) string {
	if strings.HasPrefix(cr.Note, "N/A") {
		return "n/a"
	}
	return mark(cr.Pass)
}

func mark(b bool) string {
	if b {
		return "✓"
	}
	return "✗"
}

// displayName returns the agent name with a human-readable fallback for
// harnesses that omit the optional agentInfo in their initialize response
// (empty AgentName would render as a blank cell / "agent=" in notes).
func (r ConformanceReport) displayName() string {
	if r.AgentName == "" {
		return "(未自报)"
	}
	return r.AgentName
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
	probeForkTimeout = 20 * time.Second // fork/list/load 单次 RPC 硬超时(#172;undeclared 强 fork 同样适用)
)

// evCapture busy-fork 探针(#191)的事件取证:按到达顺序留存流式 chunk 事件,
// 并提供「等待下一个 chunk」的就绪信号(fork 触发时机锚定真实流式开始,不靠固定延时)。
// 全部方法并发安全(ACP 回调在独立 goroutine 触发)。
type evCapture struct {
	mu   sync.Mutex
	log  []SessionEvent
	wait chan struct{} // 非 nil 时,下一个 chunk 事件向其发一次信号(容量 1,不阻塞)
}

// record 留存一条流式 chunk 事件(message/thought),并唤醒等待者。
func (c *evCapture) record(e SessionEvent) {
	if e.Kind != "agent_message_chunk" && e.Kind != "agent_thought_chunk" {
		return
	}
	c.mu.Lock()
	c.log = append(c.log, e)
	w := c.wait
	c.mu.Unlock()
	if w != nil {
		select {
		case w <- struct{}{}:
		default:
		}
	}
}

// arm 装备就绪信号,返回信号 channel(调用方在发出 prompt 后等待它)。
func (c *evCapture) arm() chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wait = make(chan struct{}, 1)
	return c.wait
}

// mark 返回当前日志长度(作为 since 的基准点)。
func (c *evCapture) mark() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.log)
}

// since 返回 mark 之后的 chunk 事件快照。
func (c *evCapture) since(mark int) []SessionEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]SessionEvent(nil), c.log[mark:]...)
}

// chunkTail 摘取 sid 会话(可选按 messageId 过滤)在快照里最长一条累积全文。
// 供报告 Note 预览快照点内容(人话呈现,§4.4);n = 过滤命中的事件数。
func chunkTail(evs []SessionEvent, sid acp.SessionId, msgID string) (text string, n int) {
	for _, e := range evs {
		if e.SessionID != string(sid) || (msgID != "" && e.MessageID != msgID) {
			continue
		}
		if len(e.Text) >= len(text) {
			text = e.Text // 累积全文:取最长一条
		}
		n++
	}
	return text, n
}

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

	evlog := &evCapture{} // busy-fork 探针取证(#191);onEvent 并发回调,record 自带锁

	var handler *Handler
	onEvent := func(e SessionEvent) {
		evlog.record(e) // busy-fork 取证(#191)
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
	handler = NewHandler(workDir, onEvent, onPermission, nil, 0)

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
	// agentInfo is optional in ACP v1 (see agentName): keep the report field
	// empty when the harness does not self-report, but render a readable
	// fallback in user-facing notes (§4.4).
	rep.AgentName = agentName(initResp)
	rep.ProtocolVer = int(initResp.ProtocolVersion)
	rep.Initialized = CheckResult{Pass: true, Note: fmt.Sprintf("agent=%s protocol=%d", rep.displayName(), initResp.ProtocolVersion)}
	// 能力矩阵(纯协商,零身份分支)。
	sc := initResp.AgentCapabilities.SessionCapabilities
	rep.LoadSession = initResp.AgentCapabilities.LoadSession
	rep.Resume = sc.Resume != nil
	rep.List = sc.List != nil
	rep.Close = sc.Close != nil
	rep.Image = initResp.AgentCapabilities.PromptCapabilities.Image
	rep.Audio = initResp.AgentCapabilities.PromptCapabilities.Audio
	rep.Providers = initResp.AgentCapabilities.Providers != nil
	rep.Fork.Declared = sc.Fork != nil // P1 fork 声明位(issue #172)

	// 2. NewSession(临时目录,非 nil 空 mcpServers —— 规避 null 死挂,§5.4)。
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
	// Probe session/set_config_option: round-trip the current model value (a no-op);
	// a conformant harness MUST respond with the complete config state.
	for _, co := range sess.ConfigOptions {
		if co.Select != nil && co.Select.Category != nil && string(*co.Select.Category) == "model" {
			setCtx, cancelSet := context.WithTimeout(ctx, probeSessTimeout)
			sresp, serr := conn.SetSessionConfigOption(setCtx, acp.SetSessionConfigOptionRequest{
				ValueId: &acp.SetSessionConfigOptionValueId{
					SessionId: sess.SessionId,
					ConfigId:  co.Select.Id,
					Value:     co.Select.CurrentValue,
				},
			})
			cancelSet()
			rep.SetConfigWorks = serr == nil && len(sresp.ConfigOptions) > 0
			break
		}
	}
	// Install the cancel-trigger wrapper once (before any Prompt). The wrapper fires
	// session/cancel on the first session/update event, but only while cancelArmed is
	// set by the cancel probe below. Installing once (rather than swapping OnEvent per
	// probe) avoids a data race with the SDK callback goroutine that reads handler.OnEvent.
	var cancelArmed atomic.Bool
	var cancelOnce sync.Once
	probeOnEvent := handler.OnEvent
	handler.OnEvent = func(e SessionEvent) {
		if cancelArmed.Load() {
			cancelOnce.Do(func() {
				_ = conn.Cancel(context.Background(), acp.CancelNotification{SessionId: sess.SessionId})
			})
		}
		probeOnEvent(e)
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
		// 模型未配 key / 网络不通会在此报错;严格门槛要求完整 end_turn,故判失败。
		// (流式已产出即证 ACP 契约健康,但 CanAdd 收紧为要求 end_turn —— 证当前环境真能跑完一轮。)
		rep.PromptTurn = CheckResult{Pass: false, Note: "error: " + truncate(perr.Error(), 160)}
	case presp.StopReason == acp.StopReasonEndTurn:
		rep.PromptTurn = CheckResult{Pass: true, Note: "end_turn"}
	default:
		rep.PromptTurn = CheckResult{Pass: false, Note: fmt.Sprintf("stopReason=%s", presp.StopReason)}
	}
	rep.ReportedUsage = sawUsage || presp.Usage != nil
	// Probe session/cancel: arm the wrapper so the first session/update event fires
	// session/cancel (the turn is genuinely in-flight — no fixed-delay race). A
	// conformant harness MUST respond with stopReason=cancelled.
	cancelPromptCtx, cancelPromptFn := context.WithTimeout(ctx, probeTurnTimeout)
	defer cancelPromptFn()
	cancelArmed.Store(true)
	cpresp, cperr := conn.Prompt(cancelPromptCtx, acp.PromptRequest{
		SessionId: sess.SessionId,
		Prompt:    []acp.ContentBlock{acp.TextBlock("hi")},
	})
	cancelArmed.Store(false)
	rep.CancelHonored = cperr == nil && cpresp.StopReason == acp.StopReasonCancelled

	// Probe session/resume: if advertised, resume the same session and verify it does
	// NOT replay history (session-resume.mdx: MUST NOT replay before responding).
	if sc.Resume != nil {
		mu.Lock()
		kinds = make(map[string]struct{}) // reset to capture only resume-window events
		mu.Unlock()
		resumeCtx, cancelResume := context.WithTimeout(ctx, probeSessTimeout)
		_, rerr := conn.ResumeSession(resumeCtx, acp.ResumeSessionRequest{
			SessionId:  sess.SessionId,
			Cwd:        workDir,
			McpServers: []acp.McpServer{},
		})
		cancelResume()
		// Drain: some harnesses replay history AFTER the resume response (async, not
		// within the response window). Wait briefly so a replay — if any — lands in
		// the collected kinds before we inspect them.
		time.Sleep(3 * time.Second)
		replayed := false
		if rerr == nil {
			mu.Lock()
			for k := range kinds {
				if k == "agent_message_chunk" || k == "agent_thought_chunk" || k == "user_message_chunk" ||
					k == "tool_call" || k == "tool_call_update" || k == "plan" || k == "plan_update" {
					replayed = true
				}
			}
			mu.Unlock()
		}
		rep.ResumeReplays = replayed
	}

	// 3.w busy-fork 探针(issue #191):源 turn 进行中 fork 的四项实测。
	// 先于 3.x 的 P3 往返执行:P3 ⑧ 的并发双 prompt 在旧版 omp 上稳定杀进程(#172 实测),
	// busy 段前置可避免 ⑧ 的既有崩溃污染 busy 四项的归因。recover 兜底同 3.x。
	func() {
		defer func() {
			if r := recover(); r != nil {
				rep.Fork.Error = truncate(fmt.Sprintf("busy-fork panic: %v", r), 200)
			}
		}()
		runBusyForkProbe(ctx, conn, rep, sess.SessionId, workDir, initResp.AgentCapabilities.LoadSession, evlog)
	}()

	// 3.x fork 探针(issue #172 Phase 1):undeclared 强 fork 错误码锚定 / declared 最小往返。
	// recover 兜底:任何 SDK/协议层异常都收敛为报告行,探针自身永不 panic(UNSTABLE 红线)。
	func() {
		defer func() {
			if r := recover(); r != nil {
				rep.Fork.Error = truncate(fmt.Sprintf("panic: %v", r), 200)
			}
		}()
		runForkProbes(ctx, conn, rep, sess, sc, initResp.AgentCapabilities.LoadSession, workDir)
	}()

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

// runForkProbes 执行 fork 探针主体(issue #172 Phase 1)。
//
// P2:undeclared → 构造最小 UnstableForkSessionRequest 强发,锚定 JSON-RPC 错误码
// (预期 -32601 Method not found,以实测为准),跳过往返并逐项落 N/A。
// P3:declared → 最小往返取证(①-⑧)。调用方已 recover 兜底;这里任何单步失败
// 都只落报告行,绝不中断收敛(UNSTABLE 红线:失败也产出 failed 行 + 原因)。
func runForkProbes(ctx context.Context, conn *acp.ClientSideConnection, rep *ConformanceReport,
	sess acp.NewSessionResponse, sc acp.SessionCapabilities, loadDeclared bool, workDir string) {

	// na N/A 行工厂:跳过/前置失败的项也必须落行(绝不静默省略)。
	na := func(reason string) CheckResult { return CheckResult{Pass: false, Note: "N/A: " + reason} }
	naRoundtrip := func(reason string) {
		rep.Fork.NewID = na(reason)
		rep.Fork.SourceAlive = na(reason)
		rep.Fork.InList = na(reason)
		rep.Fork.Resumable = na(reason)
		rep.Fork.Echo = na(reason)
		rep.Fork.Cwd = na(reason)
		rep.Fork.Chain = na(reason)
		rep.Fork.Concurrent = na(reason)
	}
	srcID := sess.SessionId

	if !rep.Fork.Declared {
		// P2 undeclared:最小强 fork(源=探针会话 id,cwd=探针 cwd)。
		fctx, cancel := context.WithTimeout(ctx, probeForkTimeout)
		_, err := conn.UnstableForkSession(fctx, acp.UnstableForkSessionRequest{
			SessionId: srcID,
			Cwd:       workDir,
		})
		cancel()
		if err == nil {
			// 未声明却成功 —— 声明与实现不一致,本身是发现(记入报告,不崩)。
			rep.Fork.Force = "forced-fork: succeeded (undeclared but accepted)"
			rep.Fork.ForceClass = "unexpected-success"
		} else {
			rep.Fork.Force = "forced-fork: " + requestErrText(err)
			if re, ok := asRequestErr(err); ok {
				switch re.Code {
				case -32601:
					rep.Fork.ForceClass = "method-not-found"
				case -32602:
					rep.Fork.ForceClass = "invalid-params"
				default:
					rep.Fork.ForceClass = "other"
				}
			} else {
				rep.Fork.ForceClass = "no-answer" // 超时/断连等,无 JSON-RPC 错误响应
			}
		}
		naRoundtrip("fork 未声明,跳过往返(P1 标注)")
		return
	}

	// P3 declared 最小往返。
	// ① 同 cwd fork 一次。
	fr, ferr := forkOnce(ctx, conn, srcID, workDir)
	if ferr != nil {
		rep.Fork.NewID = CheckResult{Pass: false, Note: "fork error: " + truncate(ferr.Error(), 160)}
		// 其余七项落 N/A,但保留 NewID 的 fork 错误原因(不能被 N/A 覆盖)。
		rep.Fork.SourceAlive = na("前置 fork 失败")
		rep.Fork.InList = na("前置 fork 失败")
		rep.Fork.Resumable = na("前置 fork 失败")
		rep.Fork.Echo = na("前置 fork 失败")
		rep.Fork.Cwd = na("前置 fork 失败")
		rep.Fork.Chain = na("前置 fork 失败")
		rep.Fork.Concurrent = na("前置 fork 失败")
		return
	}
	forkID := fr.SessionId
	rep.Fork.NewID = CheckResult{
		Pass: forkID != srcID,
		Note: fmt.Sprintf("source=%s fork=%s", safeID(srcID), safeID(forkID)),
	}

	// ⑤ 回显一致性:fork 响应的 configOptions/modes vs 源 NewSession 响应。
	rep.Fork.Echo = echoVerdict(sess, fr)

	// ② 源 session fork 后仍可 prompt(最小提示词,防配额浪费)。
	rep.Fork.SourceAlive = promptVerdict(ctx, conn, srcID, "hi")

	// ③ session/list 含新 id(list 未声明 → N/A)。
	if sc.List != nil {
		lctx, cancel := context.WithTimeout(ctx, probeForkTimeout)
		lresp, lerr := conn.ListSessions(lctx, acp.ListSessionsRequest{})
		cancel()
		switch {
		case lerr != nil:
			rep.Fork.InList = CheckResult{Pass: false, Note: "list error: " + truncate(lerr.Error(), 160)}
		default:
			found := false
			for _, si := range lresp.Sessions {
				if si.SessionId == forkID {
					found = true
					break
				}
			}
			rep.Fork.InList = CheckResult{Pass: found, Note: fmt.Sprintf("%d sessions listed", len(lresp.Sessions))}
		}
	} else {
		rep.Fork.InList = na("session/list 未声明")
	}

	// ④ 新 id 可 load/resume(loadSession 与 session/resume 均未声明 → N/A)。
	switch {
	case loadDeclared:
		lctx, cancel := context.WithTimeout(ctx, probeForkTimeout)
		_, lerr := conn.LoadSession(lctx, acp.LoadSessionRequest{
			SessionId:  forkID,
			Cwd:        workDir,
			McpServers: []acp.McpServer{},
		})
		cancel()
		if lerr != nil {
			rep.Fork.Resumable = CheckResult{Pass: false, Note: "load error: " + truncate(lerr.Error(), 160)}
		} else {
			rep.Fork.Resumable = CheckResult{Pass: true, Note: "session/load ok"}
		}
	case sc.Resume != nil:
		rctx, cancel := context.WithTimeout(ctx, probeForkTimeout)
		_, rerr := conn.ResumeSession(rctx, acp.ResumeSessionRequest{
			SessionId:  forkID,
			Cwd:        workDir,
			McpServers: []acp.McpServer{},
		})
		cancel()
		if rerr != nil {
			rep.Fork.Resumable = CheckResult{Pass: false, Note: "resume error: " + truncate(rerr.Error(), 160)}
		} else {
			rep.Fork.Resumable = CheckResult{Pass: true, Note: "session/resume ok"}
		}
	default:
		rep.Fork.Resumable = na("loadSession 与 session/resume 均未声明")
	}

	// ⑥ cwd 语义:同 cwd(①的结果)vs 新 tmp cwd 各 fork 一次,记录行为差异。
	// 干净协议错误也算确定性观察(Pass);只有超时/断连等不定态判失败。
	newCwd, cerr := os.MkdirTemp("", "md-probe-fork-*")
	if cerr != nil {
		rep.Fork.Cwd = CheckResult{Pass: false, Note: "tempdir: " + truncate(cerr.Error(), 120)}
	} else {
		defer os.RemoveAll(newCwd)
		fr2, ferr2 := forkOnce(ctx, conn, srcID, newCwd)
		switch {
		case ferr2 == nil:
			distinct := fr2.SessionId != srcID
			rep.Fork.Cwd = CheckResult{
				Pass: true,
				Note: fmt.Sprintf("同 cwd fork=%s ok;新 cwd fork=%s (distinct=%v)",
					safeID(forkID), safeID(fr2.SessionId), distinct),
			}
		default:
			_, isReq := asRequestErr(ferr2)
			rep.Fork.Cwd = CheckResult{
				Pass: isReq,
				Note: "新 cwd fork error: " + truncate(ferr2.Error(), 160),
			}
		}
	}

	// ⑦ fork 链:对 fork 结果再 fork。
	fr3, ferr3 := forkOnce(ctx, conn, forkID, workDir)
	if ferr3 != nil {
		rep.Fork.Chain = CheckResult{Pass: false, Note: "fork-of-fork error: " + truncate(ferr3.Error(), 160)}
	} else {
		chainID := fr3.SessionId
		rep.Fork.Chain = CheckResult{
			Pass: chainID != forkID && chainID != srcID,
			Note: fmt.Sprintf("chain=%s (fork=%s)", safeID(chainID), safeID(forkID)),
		}
	}

	// ⑧ 源/fork 并发各一发 prompt,观察互扰(两路都收敛 = 无致命互扰)。
	var wg sync.WaitGroup
	var srcResp, forkResp acp.PromptResponse
	var srcErr, forkErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		srcResp, srcErr = promptSession(ctx, conn, srcID, "hi")
	}()
	go func() {
		defer wg.Done()
		forkResp, forkErr = promptSession(ctx, conn, forkID, "hi")
	}()
	wg.Wait()
	switch {
	case srcErr == nil && forkErr == nil:
		rep.Fork.Concurrent = CheckResult{
			Pass: true,
			Note: fmt.Sprintf("source=%s fork=%s", srcResp.StopReason, forkResp.StopReason),
		}
	case srcErr != nil && forkErr != nil:
		rep.Fork.Concurrent = CheckResult{
			Pass: false,
			Note: "两路 prompt 均错: " + truncate(srcErr.Error(), 80) + " / " + truncate(forkErr.Error(), 80),
		}
	case srcErr != nil:
		rep.Fork.Concurrent = CheckResult{Pass: false, Note: "source prompt error: " + truncate(srcErr.Error(), 160)}
	default:
		rep.Fork.Concurrent = CheckResult{Pass: false, Note: "fork prompt error: " + truncate(forkErr.Error(), 160)}
	}
}

// forkOnce 单次 fork RPC(硬超时;UNSTABLE session/fork,#172)。
func forkOnce(ctx context.Context, conn *acp.ClientSideConnection, srcID acp.SessionId, cwd string) (acp.UnstableForkSessionResponse, error) {
	fctx, cancel := context.WithTimeout(ctx, probeForkTimeout)
	defer cancel()
	return conn.UnstableForkSession(fctx, acp.UnstableForkSessionRequest{
		SessionId: srcID,
		Cwd:       cwd,
	})
}

// runBusyForkProbe busy-fork 四项实测(issue #191):源 turn 进行中 fork 的行为。
//
// 时序:发起一轮长 prompt(流式中)→ 等「第一个 chunk 到达」再发 fork(锚定真实
// 流式开始,不靠固定延时)→ fork RPC(①)→ load/resume fork 观察回放快照点(②)
// → 等源 prompt 收敛判源是否被扰(③)→ 串行 prompt fork 判 fork 行可用(④)。
// ④ 有意排在源 turn 结束之后:铁律③「forked session 串行使用」,④ 测的是 fork 行
// 本身可用,不与 ⑧ 的并发互扰混淆。undeclared 全部落 N/A(声明位门控,铁律①)。
// 任何单步失败只落报告行,探针必收敛(UNSTABLE 红线)。
func runBusyForkProbe(ctx context.Context, conn *acp.ClientSideConnection, rep *ConformanceReport,
	srcID acp.SessionId, workDir string, loadDeclared bool, lg *evCapture) {

	na := func(reason string) CheckResult { return CheckResult{Pass: false, Note: "N/A: " + reason} }
	if !rep.Fork.Declared {
		rep.Fork.BusyFork = na("fork 未声明")
		rep.Fork.BusySnap = na("fork 未声明")
		rep.Fork.BusySrcOK = na("fork 未声明")
		rep.Fork.BusyForkUse = na("fork 未声明")
		return
	}

	// 发起长 prompt(流式中),等第一个 chunk 到达即视为 turn 真正在途。
	// busyStart 先于 arm:本轮(第 N 轮)的 chunk 归区从这里起算,不含此前各轮。
	busyStart := lg.mark()
	wait := lg.arm()
	type promptOutcome struct {
		resp acp.PromptResponse
		err  error
	}
	outcome := make(chan promptOutcome, 1)
	go func() {
		resp, err := promptSession(ctx, conn, srcID, "Count from 1 to 40, one number per line, nothing else.")
		outcome <- promptOutcome{resp, err}
	}()
	select {
	case <-wait:
	case <-time.After(probeTurnTimeout):
		rep.Fork.BusyFork = CheckResult{Pass: false, Note: "N/A: 源 turn 未流式产出(无 chunk),busy 前提不成立"}
		rep.Fork.BusySnap = na("源 turn 未流式产出")
		rep.Fork.BusySrcOK = na("源 turn 未流式产出")
		rep.Fork.BusyForkUse = na("源 turn 未流式产出")
		return
	}
	// 本轮(进行中 turn)的 messageId:回放快照观察的过滤锚(§5.4 #10 主键归并)。
	// 无 messageId 的 harness 退化为全量观察(如实记录,不假设)。
	busyMsgID := ""
	if evs := lg.since(busyStart); len(evs) > 0 {
		busyMsgID = evs[0].MessageID
	}

	// ① 源 turn 进行中 fork。
	fr, ferr := forkOnce(ctx, conn, srcID, workDir)
	if ferr != nil {
		rep.Fork.BusyFork = CheckResult{Pass: false, Note: "fork error: " + truncate(ferr.Error(), 160)}
		rep.Fork.BusySnap = na("前置 busy fork 失败")
		rep.Fork.BusySrcOK = na("前置 busy fork 失败")
		rep.Fork.BusyForkUse = na("前置 busy fork 失败")
		// 源 turn 仍在途:等它收敛,避免泄漏一个挂着的 prompt 到后续探针段。
		<-outcome
		return
	}
	forkID := fr.SessionId
	rep.Fork.BusyFork = CheckResult{
		Pass: forkID != srcID,
		Note: fmt.Sprintf("source=%s fork=%s (turn 进行中)", safeID(srcID), safeID(forkID)),
	}

	// ② fork 上下文快照点:load(或 resume)fork,观察窗口内的内容回放。
	// 回放内容 = harness 侧复刻给 fork 的上下文;如实记录快照落在哪
	// (含流式中内容 / 只到上一条完整消息 / 无回放不可观察)。
	snapMark := lg.mark()
	switch {
	case loadDeclared:
		lctx, cancel := context.WithTimeout(ctx, probeForkTimeout)
		_, lerr := conn.LoadSession(lctx, acp.LoadSessionRequest{
			SessionId:  forkID,
			Cwd:        workDir,
			McpServers: []acp.McpServer{},
		})
		cancel()
		rep.Fork.BusySnap = busySnapVerdict(lg, snapMark, forkID, busyMsgID, lerr, "load")
	default:
		rctx, cancel := context.WithTimeout(ctx, probeForkTimeout)
		_, rerr := conn.ResumeSession(rctx, acp.ResumeSessionRequest{
			SessionId:  forkID,
			Cwd:        workDir,
			McpServers: []acp.McpServer{},
		})
		cancel()
		rep.Fork.BusySnap = busySnapVerdict(lg, snapMark, forkID, busyMsgID, rerr, "resume")
	}

	// ③ 源 turn 是否被扰:等 prompt 收敛,end_turn + fork 后流式延续 = 无扰。
	postForkMark := lg.mark() // fork 返回后的 chunk = fork 后流式延续
	out := <-outcome
	switch {
	case out.err != nil:
		rep.Fork.BusySrcOK = CheckResult{Pass: false, Note: "源 prompt error: " + truncate(out.err.Error(), 160)}
	case out.resp.StopReason != acp.StopReasonEndTurn:
		rep.Fork.BusySrcOK = CheckResult{Pass: false, Note: fmt.Sprintf("源 stopReason=%s(被扰?)", out.resp.StopReason)}
	default:
		time.Sleep(2 * time.Second) // drain:收尾 chunk 可能晚于 Prompt 返回
		tail, total := chunkTail(lg.since(busyStart), srcID, "")
		_, post := chunkTail(lg.since(postForkMark), srcID, "")
		rep.Fork.BusySrcOK = CheckResult{
			Pass: true,
			Note: fmt.Sprintf("end_turn; 本轮 chunk 事件=%d(fork 后=%d) tail=%q", total, post, truncate(tail, 60)),
		}
	}

	// ④ fork 后串行 prompt fork 行(fork 行可用)。
	rep.Fork.BusyForkUse = promptVerdict(ctx, conn, forkID, "hi")
}

// busySnapVerdict ② 的判定:RPC 成功即 pass,Note 如实记录快照点
// (含流式中内容 / 只到上一条完整消息 / 无内容回放不可观察)。
// 同 messageId 过滤 = 回放保留原 id 的 harness(omp/fakeagent)的精确观察;
// 过滤空但全量有回放时如实标注(回放换发新 messageId 的 harness,如 opencode)。
func busySnapVerdict(lg *evCapture, from int, forkID acp.SessionId, busyMsgID string, rpcErr error, verb string) CheckResult {
	if rpcErr != nil {
		return CheckResult{Pass: false, Note: fmt.Sprintf("%s error: %s", verb, truncate(rpcErr.Error(), 160))}
	}
	time.Sleep(2 * time.Second) // drain:部分 harness 的回放晚于 RPC 响应(异步)
	evs := lg.since(from)
	text, n := chunkTail(evs, forkID, "")
	ftext, fn := chunkTail(evs, forkID, busyMsgID)
	switch {
	case fn > 0:
		return CheckResult{Pass: true, Note: fmt.Sprintf("%s ok; replay=%d(同msgId=%d) 快照=%q", verb, n, fn, truncate(ftext, 80))}
	case n > 0:
		return CheckResult{Pass: true, Note: fmt.Sprintf("%s ok; replay=%d(同msgId=0,回放未携带原 messageId) tail=%q", verb, n, truncate(text, 80))}
	default:
		return CheckResult{Pass: true, Note: fmt.Sprintf("%s ok; 无内容回放,快照点不可经 %s 观察", verb, verb)}
	}
}

// promptSession 单发一轮最小 prompt(turn 级硬超时;诊断场景,与 §3.3 无关)。
func promptSession(ctx context.Context, conn *acp.ClientSideConnection, sid acp.SessionId, text string) (acp.PromptResponse, error) {
	pctx, cancel := context.WithTimeout(ctx, probeTurnTimeout)
	defer cancel()
	return conn.Prompt(pctx, acp.PromptRequest{
		SessionId: sid,
		Prompt:    []acp.ContentBlock{acp.TextBlock(text)},
	})
}

// promptVerdict prompt 往返判定:end_turn=pass,其余 stopReason/error 落 Note。
func promptVerdict(ctx context.Context, conn *acp.ClientSideConnection, sid acp.SessionId, text string) CheckResult {
	presp, err := promptSession(ctx, conn, sid, text)
	switch {
	case err != nil:
		return CheckResult{Pass: false, Note: "prompt error: " + truncate(err.Error(), 160)}
	case presp.StopReason == acp.StopReasonEndTurn:
		return CheckResult{Pass: true, Note: "end_turn"}
	default:
		return CheckResult{Pass: false, Note: fmt.Sprintf("stopReason=%s", presp.StopReason)}
	}
}

// echoVerdict ⑤ fork 响应回显一致性:configOptions 逐条 id/currentValue 与源一致,
// modes 存在性与 currentModeId 一致(协议未承诺 fork 必回显,差异本身是取证结果)。
func echoVerdict(src acp.NewSessionResponse, fork acp.UnstableForkSessionResponse) CheckResult {
	var notes []string
	if len(src.ConfigOptions) != len(fork.ConfigOptions) {
		notes = append(notes, fmt.Sprintf("configOptions %d→%d", len(src.ConfigOptions), len(fork.ConfigOptions)))
	} else {
		for i, so := range src.ConfigOptions {
			fo := fork.ConfigOptions[i]
			switch {
			case so.Select != nil && fo.Select != nil:
				if so.Select.Id != fo.Select.Id || so.Select.CurrentValue != fo.Select.CurrentValue {
					notes = append(notes, fmt.Sprintf("config[%d] %s:%s→%s:%s",
						i, so.Select.Id, so.Select.CurrentValue, fo.Select.Id, fo.Select.CurrentValue))
				}
			case (so.Select == nil) != (fo.Select == nil):
				notes = append(notes, fmt.Sprintf("config[%d] variant kind changed", i))
			}
		}
	}
	if (src.Modes == nil) != (fork.Modes == nil) {
		notes = append(notes, "modes 存在性不一致")
	} else if src.Modes != nil && fork.Modes != nil && src.Modes.CurrentModeId != fork.Modes.CurrentModeId {
		notes = append(notes, fmt.Sprintf("currentMode %s→%s", src.Modes.CurrentModeId, fork.Modes.CurrentModeId))
	}
	if len(notes) == 0 {
		return CheckResult{Pass: true, Note: "configOptions/modes 与源一致"}
	}
	return CheckResult{Pass: false, Note: truncate(strings.Join(notes, "; "), 160)}
}

// asRequestErr 把 err 还原成 SDK 的 *acp.RequestError(JSON-RPC 错误响应)。
func asRequestErr(err error) (*acp.RequestError, bool) {
	var re *acp.RequestError
	if errors.As(err, &re) {
		return re, true
	}
	return nil, false
}

// requestErrText 提取 JSON-RPC 错误的 "<code> <message>" 锚定串;非协议错误原样截断返回。
func requestErrText(err error) string {
	if re, ok := asRequestErr(err); ok {
		return fmt.Sprintf("%d %s", re.Code, re.Message)
	}
	return truncate(err.Error(), 160)
}
