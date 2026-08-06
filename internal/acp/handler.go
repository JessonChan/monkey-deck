package acp

// handler.go:Handler 实现 acp.Client 回调接口(harness 调用客户端的回调)。
//
// 与 RAK daemon 的关键差异(AGENTS.md §3.4):我们是桌面应用,屏幕前有人。
// RequestPermission 不无脑自动放行 —— 作为 UI 提示弹给用户裁决,
// 但必须有默认动作 + 超时兜底,不能让 ACP 连接因没人点按钮而永久卡死。

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/acp-go-sdk"
	"github.com/jessonchan/monkey-deck/internal/permissions"
)

// SessionEvent 是给前端用的「扁平化 SessionUpdate」(AGENTS.md §1.6/§4.3)。
// agent 的全部产出——消息、思考、工具调用、用量——都从 SessionUpdate 回调流入,
// 这里转成 JSON 友好的结构,由 service 层经 Wails3 event 推前端流式渲染。
type SessionEvent struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`                // agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | usage_update | plan | session_info | config_option
	Text      string `json:"text"`                // chunk 文本(message/thought);agent/thought 为累积全文
	Seq       int64  `json:"seq,omitempty"`       // 单调序号(防流式乱序,§4.3)
	MessageID string `json:"messageId,omitempty"` // ACP messageId:同一条逻辑消息的所有 chunk 共享(§5.4 #11),主键归并用
	// TurnID 标识事件所属的 turn(= 开启该 turn 的 user message ID,由 client 生成;
	// 协议无 turnId 字段,见 docs/worklog/2026-07-22-plan-history-by-turn.md)。
	// 目前仅 plan 事件携带:plan 按 turn 索引,当前 turn 实时 / 历史 turn 静态展示。
	TurnID string `json:"turnId,omitempty"`

	ToolCallID string `json:"toolCallId,omitempty"`
	ToolTitle  string `json:"toolTitle,omitempty"`
	ToolStatus string `json:"toolStatus,omitempty"`
	ToolKind   string `json:"toolKind,omitempty"`
	RawInput   any    `json:"rawInput,omitempty"`
	RawOutput  any    `json:"rawOutput,omitempty"`

	Used int64    `json:"used,omitempty"` // context tokens 已用
	Size int64    `json:"size,omitempty"` // context window 总量
	Cost *float64 `json:"cost,omitempty"` // 累积成本 USD
	// token 明细(来自 PromptResponse.Usage,UNSTABLE;§1.6/Task #15138)。
	// streaming UsageUpdate 只含 used/size/cost,明细只能从 Prompt 响应取。
	// 这些字段已是 session 级累积值(SDK:Total X tokens across all turns),直接覆盖即可。
	CachedReadTokens  int64          `json:"cachedReadTokens,omitempty"`
	CachedWriteTokens int64          `json:"cachedWriteTokens,omitempty"`
	InputTokens       int64          `json:"inputTokens,omitempty"`
	OutputTokens      int64          `json:"outputTokens,omitempty"`
	ThoughtTokens     int64          `json:"thoughtTokens,omitempty"`
	TotalTokens       int64          `json:"totalTokens,omitempty"`
	Title             string         `json:"title,omitempty"`         // session_info 标题
	ConfigOptions     []ConfigOption `json:"configOptions,omitempty"` // config_option:model/mode/effort 等(agent 自报)
	PlanEntries       []PlanEntry    `json:"planEntries,omitempty"`   // plan:agent 执行计划(整表替换,ACP protocol)
	Commands          []SlashCommand `json:"commands,omitempty"`      // available_commands:harness 自报的斜杠命令(动态,非硬编码;§1.6)
	// ImageSupported:agent 是否支持 image prompt 能力(Initialize 响应 promptCapabilities.image)。
	// 随 config_option 事件下发,前端据此门控图片输入入口(不支持则隐藏/禁用,§3.5)。
	ImageSupported bool `json:"imageSupported,omitempty"`
	// AudioSupported:agent 是否支持 audio prompt 能力。前端据此门控音频输入入口。
	AudioSupported bool `json:"audioSupported,omitempty"`
	// EmbeddedContextSupported:agent 是否支持 embeddedContext prompt 能力。
	// 前端据此决定附件是否可内联(ContentBlock::Resource)发送(省去 agent 读盘往返)。
	EmbeddedContextSupported bool `json:"embeddedContextSupported,omitempty"`
}

// PlanEntry 是 agent 执行计划的一项(ACP PlanEntry 的扁平化)。
// 整表替换模型:harness 每次 plan_update 发全量列表,client 直接替换。
type PlanEntry struct {
	Content  string `json:"content"`            // 任务描述
	Priority string `json:"priority,omitempty"` // high | medium | low
	Status   string `json:"status"`             // pending | in_progress | completed
}

// ConfigOption 是给前端用的扁平化 session config option(从 acp.SessionConfigOption union 转换)。
// agent 在 NewSession/LoadSession/set_config_option 响应、config_option_update 通知里返回 configOptions,
// 经 FlattenConfigOptions 拍平后推前端渲染下拉(model selector / mode / thought_level)。
type ConfigOption struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Category     string              `json:"category"` // model | mode | thought_level
	CurrentValue string              `json:"currentValue"`
	Options      []ConfigOptionEntry `json:"options"`
}

// ConfigOptionEntry 一个可选项。model 的 value 是 "provider/model" 格式(如 "zai/glm-4.6"),
// 前端可按 value 的 provider 前缀分组显示。
type ConfigOptionEntry struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// SlashCommand is a harness-advertised slash command (ACP available_commands_update).
// Per protocol: commands are invoked by sending the command text (e.g. "/model list")
// as a regular user message in session/prompt; the harness recognizes the "/" prefix.
// Name carries NO leading "/". InputHint is the argument hint (may be empty).
// Each harness advertises a different, dynamic list (not hardcoded); this is only the
// flattened wire shape forwarded to the frontend.
type SlashCommand struct {
	Name        string `json:"name"`                // command name WITHOUT leading "/" (e.g. "model")
	Description string `json:"description"`         // human-readable summary
	InputHint   string `json:"inputHint,omitempty"` // argument hint (ACP AvailableCommandInput.hint)
}

// FlattenConfigOptions 把 SDK 的 configOption union(Select/Boolean)拍平为前端友好的 []ConfigOption。
// 只处理 Select(单值下拉,稳定);Boolean(unstable)暂忽略。Ungrouped/Grouped 都拍平成单层。
func FlattenConfigOptions(opts []acp.SessionConfigOption) []ConfigOption {
	out := make([]ConfigOption, 0, len(opts))
	for _, o := range opts {
		if o.Select == nil {
			continue
		}
		co := ConfigOption{
			ID:           string(o.Select.Id),
			Name:         o.Select.Name,
			CurrentValue: string(o.Select.CurrentValue),
			Options:      []ConfigOptionEntry{},
		}
		if o.Select.Category != nil {
			co.Category = string(*o.Select.Category)
		}
		if o.Select.Options.Ungrouped != nil {
			for _, e := range *o.Select.Options.Ungrouped {
				co.Options = append(co.Options, cfgEntry(e))
			}
		}
		if o.Select.Options.Grouped != nil {
			for _, g := range *o.Select.Options.Grouped {
				for _, e := range g.Options {
					co.Options = append(co.Options, cfgEntry(e))
				}
			}
		}
		out = append(out, co)
	}
	return out
}

func cfgEntry(e acp.SessionConfigSelectOption) ConfigOptionEntry {
	d := ""
	if e.Description != nil {
		d = *e.Description
	}
	return ConfigOptionEntry{Value: string(e.Value), Name: e.Name, Description: d}
}

// flattenPlanEntries 把 acp.PlanEntry 列表拍平为前端友好的 []PlanEntry。
// entries 为 nil/空时返回 nil(前端 omitempty 不发该字段)。
func flattenPlanEntries(entries []acp.PlanEntry) []PlanEntry {
	if len(entries) == 0 {
		return nil
	}
	out := make([]PlanEntry, 0, len(entries))
	for _, en := range entries {
		out = append(out, PlanEntry{
			Content:  en.Content,
			Priority: string(en.Priority),
			Status:   string(en.Status),
		})
	}
	return out
}

// PermissionPrompt 是发给前端的权限裁决请求(AGENTS.md §3.4)。
// 除标题/工具名外,携带决策上下文(动作分组、命令、涉及路径),让用户明确
// 「哪个工具/动作/目标、需决策什么、可选什么」,避免泛泛确认(§4.4)。
type PermissionPrompt struct {
	ID         string             `json:"id"`
	SessionID  string             `json:"sessionId"`
	ToolName   string             `json:"toolName"`
	Title      string             `json:"title"`
	ActionType string             `json:"actionType,omitempty"` // read/write/exec/other(由 ToolKind 派生)
	Command    string             `json:"command,omitempty"`    // 抽取的命令(exec 类,来自 RawInput)
	Locations  []string           `json:"locations,omitempty"`  // 涉及路径(ToolCall.Locations)
	Options    []PermissionOption `json:"options"`
}

// PermissionOption 一个可选项。
type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // allow_once | allow_always | deny_once | deny_always
}

// Handler 实现 acp.Client 接口。一个 Handler 对应一个 ChatSession 的一个 ACP session。
type Handler struct {
	Log     *slog.Logger
	WorkDir string
	OnEvent func(SessionEvent) // 每条 SessionUpdate 转发(→ service → Wails3 event → 前端)

	// 权限裁决(§3.4):harness 请求权限时,通过 OnPermission 通知前端弹窗,
	// 用户在前端响应 → service 调 RespondPermission → 唤醒等待的 RequestPermission。
	OnPermission func(PermissionPrompt)
	// Elicitation(ACP v1 标准协议,SDK 标 UNSTABLE):harness 请求结构化用户输入
	// (select/confirm/input/多字段 form)时,通过 OnElicitation 通知前端弹窗,用户在前端
	// 响应 → service 调 RespondElicitation → 唤醒等待的 UnstableCreateElicitation。
	// 场景:omp /review 选 review 模式、/fast on|off 确认 等(类比 §3.4 权限裁决,桌面有人在场)。
	OnElicitation func(ElicitationPrompt)
	// OnElicitationResolved:当一次 elicitation 在「无用户操作」下被终结(超时降级 decline /
	// ctx 取消 cancel)时回调 service,由 service 推 chat:elicitation-resolved 让前端清掉残留
	// 卡片(否则卡片最多残留 permTTL=5min,期间点击后端报 no pending,前端无反馈)。
	// 用户正常响应(RespondElicitation)不触发本回调 —— 前端已乐观清卡。
	OnElicitationResolved func(id string)
	// OnGlobalRule:用户选「全局允许」(RespondPermission 传 "global")时回调 service,
	// 把由当前请求固化出的「准确匹配」allow 规则(permissions.ExactMatchRule)交由 service
	// 持久化进 DB + 刷新全部活跃 session 的规则快照(跨 session/project 全局生效,§3.4)。
	// nil = 不持久化(handler 单测默认 nil,只验内存记忆 + 规则形状)。
	OnGlobalRule func(permissions.Rule)

	mu      sync.Mutex
	pending map[string]*pendingPermission // id → 待裁决
	permSeq int
	permTTL time.Duration // 权限裁决总等待预算(超时后按策略降级,§3.4)
	// elicitation 等待表(§3.x elicitation):id → 待响应。复用 permTTL 作超时预算
	// (语义一致:用户交互超时兜底)。elicitSeq 自增序号生成 id。
	pendingElicit map[string]*pendingElicitation
	elicitSeq     int
	// elicitDeclined:本次 turn 期间用户主动 decline 过 elicitation(Skip 按钮)。
	// runPrompt 的 empty-turn 检测据此判定:用户主动跳过导致的空 turn 不是异常(decline
	// 让命令直接 end_turn 零输出,如 omp /review),静默推 idle 不报错。仅用户主动 decline 置位
	// (超时降级虽也返 decline 给 harness,但那是兜底不是用户意愿,不置位 → 仍走 empty-turn 提示)。
	// runPrompt 开头(startTurn)清零,保证只反映当前 turn。
	elicitDeclined atomic.Bool
	// 权限回调失败自动恢复(§3.4 + Task #15115):
	// permRetries:用户未响应时「重发提示」的额外次数(含首次共 retries+1 轮),
	//   每轮把总预算 permTTL 均分;0=只发一次(等价旧行为)。应对「提示丢失/用户没看到」。
	// permTimeoutPolicy:总预算耗尽后的降级策略;"allow"(默认,放行让对话继续)/"deny"(拒绝)。
	//   空串视作 allow(零值安全:直接 &Handler{} 构造的测试默认放行,不致误拒)。
	permRetries       int
	permTimeoutPolicy string
	// 权限裁决记忆(§3.4):用户曾选「本会话/本项目允许」后,后续 RequestPermission 当场自动放行,
	// 不弹窗、不等。覆盖所有请求类型(命令执行、外部目录访问等),不止外部目录——见
	// RequestPermission 命中分支。sessionAllowExternal 内存(随 session 生灭);
	// projectAllowExternal 由 service 从 DB(projects.allow_external_dir)加载,按 project 存、不分
	// harness → 跨 harness 共享(startLive)+ 用户选「本项目」时更新。
	// 字段名保留历史(曾仅管外部目录);DB 列名同理,见 store/migrations/0004。
	sessionAllowExternal atomic.Bool
	projectAllowExternal atomic.Bool
	// 分级权限规则引擎(§3.4):RequestPermission 在「记忆」之后、「弹窗」之前评估规则,
	// allow → 自动放行、deny → 自动拒绝,ask/无命中 → 弹前端确认。nil = 无规则(一律走弹窗,
	// 等价旧行为)。SetPermissionRules 在 service 层 session 启动 / 规则变更时更新。
	permRules atomic.Pointer[permissions.Engine]
	// 最近一次 streaming UsageUpdate 的 used/size/cost 快照(§1.6)。Prompt 返回后转发
	// PromptResponse.Usage 的 token 明细时,需携带这些值 —— 否则前端会用 0 覆盖既有占比
	// (明细事件本身不含 streaming 的 used/size)。
	usageMu  sync.RWMutex
	lastUsed int64
	lastSize int64
	lastCost float64
}

type pendingPermission struct {
	prompt   PermissionPrompt
	response chan string // 用户选中的 OptionId
}

// pendingElicitation:一次 elicitation/create 请求的等待项。
// response 携带用户在前端的选择(action + content)。action ∈ {accept, decline, cancel}。
type pendingElicitation struct {
	prompt   ElicitationPrompt
	response chan ElicitationResponse
}

// ElicitationResponse 是前端对一次 elicitation 提示的响应。
type ElicitationResponse struct {
	Action  string         `json:"action"`            // accept | decline | cancel
	Content map[string]any `json:"content,omitempty"` // accept 时:字段名 → 值(omp 约定单字段 "value")
}

// 权限回调恢复默认(§3.4 + Task #15115)。
const (
	defaultPermRetries       = 1                      // 用户未响应时额外重发 1 次(共 2 轮通知)
	defaultPermTimeoutPolicy = "allow"                // 总预算耗尽:放行让对话继续(对齐 §3.4 桌面有人但走开了)
	permSubIntervalFloor     = 200 * time.Millisecond // 总预算切分下限,防极短 TTL 切出 0
)

// timeoutPolicyAllow 把策略字符串归一为「是否放行」;空/未知 → allow(零值安全)。
func timeoutPolicyAllow(policy string) bool {
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case "deny", "reject":
		return false
	default:
		return true
	}
}

// NewHandler 构造一个 Handler。permTTL=0 时用默认 5 分钟。
func NewHandler(workDir string, onEvent func(SessionEvent), onPermission func(PermissionPrompt), onElicitation func(ElicitationPrompt), permTTL time.Duration) *Handler {
	if permTTL <= 0 {
		permTTL = 5 * time.Minute
	}
	return &Handler{
		Log:               slog.Default(),
		WorkDir:           workDir,
		OnEvent:           onEvent,
		OnPermission:      onPermission,
		OnElicitation:     onElicitation,
		pending:           map[string]*pendingPermission{},
		pendingElicit:     map[string]*pendingElicitation{},
		permTTL:           permTTL,
		permRetries:       defaultPermRetries,
		permTimeoutPolicy: defaultPermTimeoutPolicy,
	}
}

// SetPermissionRecovery 配置权限回调失败恢复策略(Task #15115)。
// retries<0 视作 0;timeoutPolicy 为 "allow"/"deny"(空串保留默认)。
// 并发安全:仅在 session 启动 / 配置变更时调用,不在 RequestPermission 热路径中写。
func (h *Handler) SetPermissionRecovery(retries int, timeoutPolicy string) {
	if retries < 0 {
		retries = 0
	}
	h.permRetries = retries
	h.permTimeoutPolicy = timeoutPolicy
}

// RespondPermission 由 service 调(前端用户点了某个选项)。非阻塞;返回 ok=false 表示无此待裁决项。
func (h *Handler) RespondPermission(id, optionID string) bool {
	h.mu.Lock()
	p, ok := h.pending[id]
	if ok {
		delete(h.pending, id)
	}
	h.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case p.response <- optionID:
	default:
	}
	return true
}

// RespondElicitation 由 service 调(前端用户对 elicitation 提示做了选择)。非阻塞;
// 返回 ok=false 表示无此待响应项(已被取消/超时/响应过)。action 见 ElicitationResponse。
func (h *Handler) RespondElicitation(id string, resp ElicitationResponse) bool {
	h.mu.Lock()
	p, ok := h.pendingElicit[id]
	if ok {
		delete(h.pendingElicit, id)
	}
	h.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case p.response <- resp:
	default:
	}
	return true
}

// --- 权限裁决(§3.4:有人在场,可交互)---

func (h *Handler) RequestPermission(ctx context.Context, req acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	title := ""
	if req.ToolCall.Title != nil {
		title = *req.ToolCall.Title
	}
	external := isExternalAccess(h.WorkDir, req.ToolCall.Locations)
	slog.Debug("permission request", "title", title, "external", external, "locations", len(req.ToolCall.Locations), "sessionAllow", h.sessionAllowExternal.Load(), "projectAllow", h.projectAllowExternal.Load())

	// 命中记忆(本会话/本项目曾选「允许」)→ 当场自动放行,不弹窗、不等(§3.4)。
	// 覆盖所有权限请求类型(命令执行、外部目录访问等),不止外部目录——否则 omp 这类
	// 对 bash 也发 request_permission 的 harness,因 locations 在 cwd 内 → external=false →
	// 永不命中记忆 → 每次弹窗(项目实证)。project 档按 project 存、跨 harness 共享。
	// 同时消除「没人点 → 等 5 分钟超时」的卡顿。
	if h.sessionAllowExternal.Load() || h.projectAllowExternal.Load() {
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: pickAllowOption(req.Options)}},
		}, nil
	}

	// 分级权限规则(§3.4):记忆未命中,评估规则引擎。allow → 放行,deny → 拒绝,
	// ask/无规则 → 继续走弹窗分支。优先级低于「记忆」(用户显式选过 allow always 最高),
	// 高于默认弹窗。
	if eng := h.permRules.Load(); eng != nil {
		decision := eng.Decide(toMatchRequest(req), permissions.LevelAsk)
		switch decision {
		case permissions.LevelAllow:
			slog.Debug("permission rule allow", "title", title)
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: pickAllowOption(req.Options)}},
			}, nil
		case permissions.LevelDeny:
			slog.Debug("permission rule deny", "title", title)
			if id := pickRejectOption(req.Options); id != "" {
				return acp.RequestPermissionResponse{
					Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: id}},
				}, nil
			}
			// 无 reject 选项(harness 没给):回 cancelled,表示拒绝执行
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
			}, nil
		}
		// LevelAsk → 落到下方弹窗分支
	}

	h.mu.Lock()
	h.permSeq++
	id := fmt.Sprintf("perm-%d-%d", time.Now().UnixNano(), h.permSeq)
	prompt := h.buildPermissionPrompt(id, req)
	p := &pendingPermission{
		prompt:   prompt,
		response: make(chan string, 1),
	}
	h.pending[id] = p
	h.mu.Unlock()

	// 等待用户裁决,带失败自动恢复(Task #15115):
	//   - 分发异常(OnPermission panic):recover 捕获,不中断主流程(否则会 tear down ACP 连接)。
	//   - 用户未响应:按 permRetries 额外重发提示(应对「提示丢失/用户没看到」),总预算 permTTL 均分。
	//   - 总预算耗尽:按 permTimeoutPolicy 降级(allow 放行 / deny 拒绝),不永久卡死(§3.4)。
	retries := h.permRetries
	if retries < 0 {
		retries = 0
	}
	attempts := retries + 1
	sub := h.permTTL
	if attempts > 1 {
		sub = h.permTTL / time.Duration(attempts)
	}
	if sub < permSubIntervalFloor {
		sub = permSubIntervalFloor
	}

	for attempt := 0; attempt < attempts; attempt++ {
		if attempt == 0 {
			slog.Info("permission prompt dispatched", "id", id, "tool", prompt.ToolName, "action", prompt.ActionType, "command", prompt.Command, "locations", len(prompt.Locations))
		} else {
			slog.Warn("permission no response, re-notify", "id", id, "attempt", attempt+1, "of", attempts)
		}
		h.dispatchPrompt(p.prompt)

		timer := time.NewTimer(sub)
		select {
		case level := <-p.response:
			timer.Stop()
			h.removePending(id)
			opt := h.applyDecision(level, req.Options)
			// 「全局允许」:把当前请求固化成准确匹配 allow 规则交 service 持久化(§3.4)。
			// 在返回 ACP 响应前完成持久化 + 刷新快照,使本轮内紧随的同标识请求也命中规则。
			if level == "global" {
				h.emitGlobalRule(req)
			}
			slog.Info("permission responded", "id", id, "level", level, "option", opt)
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: opt}},
			}, nil
		case <-ctx.Done():
			timer.Stop()
			h.removePending(id)
			slog.Warn("permission cancelled by context", "id", id, "err", ctx.Err())
			// Return nil, not ctx.Err(): the SDK turns ctx.Err() into a -32800 error
			// response that discards the cancelled outcome. prompt-turn.mdx requires the
			// client to respond with the cancelled outcome on session/cancel.
			return acp.RequestPermissionResponse{
				Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
			}, nil
		case <-timer.C:
			// 本轮未响应:继续重试,或耗尽后降级
		}
	}

	// 全部尝试耗尽 → 按策略降级(§3.4:桌面有人但走开了,默认放行让对话继续)。
	h.removePending(id)
	if timeoutPolicyAllow(h.permTimeoutPolicy) {
		def := defaultOption(req.Options)
		slog.Warn("permission timed out, degrade to allow", "id", id, "option", def)
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: def}},
		}, nil
	}
	// 降级为拒绝:优先取 reject 选项;harness 没给则 cancelled。
	if rejID := pickRejectOption(req.Options); rejID != "" {
		slog.Warn("permission timed out, degrade to deny", "id", id, "option", rejID)
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: rejID}},
		}, nil
	}
	slog.Warn("permission timed out, degrade to cancel (no reject option)", "id", id)
	return acp.RequestPermissionResponse{
		Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
	}, nil
}

// buildPermissionPrompt 从 ACP 权限请求构造带决策上下文的前端提示(Task #15115 提示明确化):
// 动作分组(read/write/exec)、抽取的命令、涉及路径 —— 让用户明确「哪个工具/动作/目标」。
func (h *Handler) buildPermissionPrompt(id string, req acp.RequestPermissionRequest) PermissionPrompt {
	title := ""
	if req.ToolCall.Title != nil {
		title = *req.ToolCall.Title
	}
	kind := toolKindStr(req.ToolCall.Kind)
	locs := make([]string, 0, len(req.ToolCall.Locations))
	for _, l := range req.ToolCall.Locations {
		if l.Path != "" {
			locs = append(locs, l.Path)
		}
	}
	opts := make([]PermissionOption, 0, len(req.Options))
	for _, o := range req.Options {
		opts = append(opts, PermissionOption{OptionID: string(o.OptionId), Name: o.Name, Kind: string(o.Kind)})
	}
	return PermissionPrompt{
		ID:         id,
		SessionID:  string(req.SessionId),
		ToolName:   kind,
		Title:      title,
		ActionType: permissions.ActionOfKind(kind),
		Command:    permissions.ExtractCommand(req.ToolCall.RawInput),
		Locations:  locs,
		Options:    opts,
	}
}

// dispatchPrompt 通知前端弹窗(service → Wails3 event),带 panic 恢复:
// 事件分发链路上的 panic 不得冒泡到 ACP 调用方(否则连接被 teardown),捕获并记日志(Task #15115)。
func (h *Handler) dispatchPrompt(prompt PermissionPrompt) (panicked bool) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
			slog.Error("permission dispatch panic recovered", "id", prompt.ID, "panic", r)
		}
	}()
	if h.OnPermission != nil {
		h.OnPermission(prompt)
	}
	return panicked
}

// removePending 从待裁决表删除一项(等待循环各分支的公共清理)。
func (h *Handler) removePending(id string) {
	h.mu.Lock()
	delete(h.pending, id)
	h.mu.Unlock()
}

// applyDecision 把前端传来的裁决档位(once/session/project/global/deny)映射成 ACP 选项,
// 并按档位设置记忆:session/project/global 档令后续「所有 RequestPermission」自动放行(不弹,见字段注释);
// global 档另经 emitGlobalRule 把准确匹配 allow 规则交 service 持久化(跨 session/project)。deny 只本次不记。
func (h *Handler) applyDecision(level string, opts []acp.PermissionOption) acp.PermissionOptionId {
	switch level {
	case "deny":
		if id := pickRejectOption(opts); id != "" {
			return id
		}
	case "session":
		h.sessionAllowExternal.Store(true)
	case "project", "global":
		// global 与 project 同样写满本 session + 本 project 记忆(本 session 即时放行);
		// global 的「持久化为全局规则」由 emitGlobalRule 负责。
		h.sessionAllowExternal.Store(true)
		h.projectAllowExternal.Store(true)
	default: // "once":允许本次,不记忆
	}
	return pickAllowOption(opts)
}

// emitGlobalRule freezes the current request into an exact-match allow rule
// (permissions.ExactMatchRule) and hands it to service via OnGlobalRule for DB persistence +
// refreshing all live sessions' rule snapshots (§3.4). When OnGlobalRule is nil (handler
// unit-test default), only the in-memory session memory is set (applyDecision already did so).
//
// Concurrency: OnGlobalRule is assigned by service during session setup (chat.go), by which point
// the ACP reader goroutine is already live (NewChatSession started it) — a bare field read would
// race that write. Snapshot the callback pointer under mu, then invoke outside the lock so a
// re-entrant callback cannot deadlock on mu.
//
// Panic safety: recover, matching dispatchPrompt/dispatchElicitation/notifyElicitationResolved —
// the callback (persistGlobalPermissionRule) runs on the ACP reader goroutine, and a panic there
// must not bubble up and tear down the connection.
func (h *Handler) emitGlobalRule(req acp.RequestPermissionRequest) {
	h.mu.Lock()
	cb := h.OnGlobalRule
	h.mu.Unlock()
	if cb == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("global rule emit panic recovered", "panic", r)
		}
	}()
	cb(permissions.ExactMatchRule(toMatchRequest(req)))
}

// SetGlobalRule sets the "allow-global" rule-persistence callback (§3.4). Service assigns it
// during session setup, after the ACP reader goroutine has started; the mu-guarded write stays
// race-free with emitGlobalRule's read.
func (h *Handler) SetGlobalRule(cb func(permissions.Rule)) {
	h.mu.Lock()
	h.OnGlobalRule = cb
	h.mu.Unlock()
}

// SetProjectAllowExternal 由 service 在 session 启动时调用,把项目级记忆(DB)加载进 handler,
// 使「本项目曾允许外部目录」的 session 命中即自动放行。
func (h *Handler) SetProjectAllowExternal(allow bool) {
	h.projectAllowExternal.Store(allow)
}

// SetPermissionRules 更新分级权限规则引擎快照(§3.4)。service 在 session 启动 / 规则变更时调用。
// 传入 nil / 空切片 = 清除规则(RequestPermission 一律走弹窗)。并发安全:atomic.Pointer 替换。
func (h *Handler) SetPermissionRules(rules []permissions.Rule) {
	if len(rules) == 0 {
		h.permRules.Store(nil)
		return
	}
	// 按 SortOrder 升序拷贝后构造引擎(引擎按给定顺序逐条判定,首条命中者决定裁决)
	sorted := make([]permissions.Rule, len(rules))
	copy(sorted, rules)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].SortOrder < sorted[j].SortOrder })
	h.permRules.Store(permissions.NewEngine(sorted))
}

// toMatchRequest 从 ACP 权限请求提取规则匹配所需输入(ToolKind / 路径 / 命令)。
func toMatchRequest(req acp.RequestPermissionRequest) permissions.MatchRequest {
	kind := ""
	if req.ToolCall.Kind != nil {
		kind = string(*req.ToolCall.Kind)
	}
	locs := make([]string, 0, len(req.ToolCall.Locations))
	for _, l := range req.ToolCall.Locations {
		if l.Path != "" {
			locs = append(locs, l.Path)
		}
	}
	return permissions.MatchRequest{ToolKind: kind, Locations: locs, RawInput: req.ToolCall.RawInput}
}

// isExternalAccess 判断请求是否访问 cwd 之外的路径(= 外部目录读取)。
// 仅用于 debug 日志标注;权限记忆命中已不限请求类型。保留供将来按风险分级(高危仍人工)用。
func isExternalAccess(workDir string, locs []acp.ToolCallLocation) bool {
	if workDir == "" {
		return false
	}
	wd, err := filepath.Abs(workDir)
	if err != nil {
		wd = workDir
	}
	sep := string(os.PathSeparator)
	for _, l := range locs {
		if l.Path == "" {
			continue
		}
		p, err := filepath.Abs(l.Path)
		if err != nil {
			p = l.Path
		}
		if p != wd && !strings.HasPrefix(p, wd+sep) {
			return true
		}
	}
	return false
}

// pickAllowOption 找一个 allow 选项;没有则退回 defaultOption(首个)。
func pickAllowOption(opts []acp.PermissionOption) acp.PermissionOptionId {
	for _, o := range opts {
		if o.Kind == acp.PermissionOptionKindAllowOnce || o.Kind == acp.PermissionOptionKindAllowAlways {
			return o.OptionId
		}
	}
	return defaultOption(opts)
}

// pickRejectOption 找一个 reject 选项;没有返回空串。
func pickRejectOption(opts []acp.PermissionOption) acp.PermissionOptionId {
	for _, o := range opts {
		if o.Kind == acp.PermissionOptionKindRejectOnce || o.Kind == acp.PermissionOptionKindRejectAlways {
			return o.OptionId
		}
	}
	return ""
}

// defaultOption 找一个 allow 选项作超时默认;没有则取第一个;再没有则 cancel。
func defaultOption(opts []acp.PermissionOption) acp.PermissionOptionId {
	for _, o := range opts {
		if o.Kind == acp.PermissionOptionKindAllowOnce || o.Kind == acp.PermissionOptionKindAllowAlways {
			return o.OptionId
		}
	}
	if len(opts) > 0 {
		return opts[0].OptionId
	}
	return ""
}

// toolKindStr 安全取 *ToolKind 的字符串值(nil 返回空)。
func toolKindStr(k *acp.ToolKind) string {
	if k == nil {
		return ""
	}
	return string(*k)
}

// --- 现实面入口:SessionUpdate 流(§1.6)---

func (h *Handler) SessionUpdate(ctx context.Context, n acp.SessionNotification) error {
	if h.OnEvent == nil {
		return nil
	}
	if e, ok := flattenUpdate(string(n.SessionId), n.Update); ok {
		// 记录最近一次 streaming UsageUpdate 的 used/size/cost,供 EmitTurnUsage 携带转发(§1.6)。
		if e.Kind == "usage_update" {
			h.usageMu.Lock()
			h.lastUsed = e.Used
			h.lastSize = e.Size
			if e.Cost != nil {
				h.lastCost = *e.Cost
			}
			h.usageMu.Unlock()
		}
		h.OnEvent(e)
	}
	return nil
}

// EmitTurnUsage 在 Prompt 同步返回后转发 PromptResponse.Usage 的 token 明细(§1.6/Task #15138)。
// streaming UsageUpdate 只含 used/size/cost,明细(CachedRead/Write/Input/Output/Thought/Total)
// 只能从 Prompt 响应取;此处携带最近一次 streaming 的 used/size/cost,避免前端用 0 覆盖既有占比。
// 调用方:ChatSession.Prompt(resp.Usage 非 nil 时)。并发安全。
func (h *Handler) EmitTurnUsage(sessionID string, u *acp.Usage) {
	if h == nil || h.OnEvent == nil || u == nil {
		return
	}
	h.usageMu.RLock()
	used, size, cost := h.lastUsed, h.lastSize, h.lastCost
	h.usageMu.RUnlock()
	e := SessionEvent{
		SessionID:    sessionID,
		Kind:         "usage_update",
		Used:         used,
		Size:         size,
		TotalTokens:  int64(u.TotalTokens),
		InputTokens:  int64(u.InputTokens),
		OutputTokens: int64(u.OutputTokens),
	}
	if u.CachedReadTokens != nil {
		e.CachedReadTokens = int64(*u.CachedReadTokens)
	}
	if u.CachedWriteTokens != nil {
		e.CachedWriteTokens = int64(*u.CachedWriteTokens)
	}
	if u.ThoughtTokens != nil {
		e.ThoughtTokens = int64(*u.ThoughtTokens)
	}
	if cost > 0 {
		c := cost
		e.Cost = &c
	}
	h.OnEvent(e)
}

// flattenUpdate 把 acp.SessionUpdate(union)转成前端友好的 SessionEvent。
func flattenUpdate(sessionID string, u acp.SessionUpdate) (SessionEvent, bool) {
	e := SessionEvent{SessionID: sessionID}
	switch {
	case u.AgentMessageChunk != nil:
		e.Kind = "agent_message_chunk"
		if u.AgentMessageChunk.Content.Text != nil {
			e.Text = u.AgentMessageChunk.Content.Text.Text
		}
		if u.AgentMessageChunk.MessageId != nil {
			e.MessageID = *u.AgentMessageChunk.MessageId
		}
		return e, true
	case u.AgentThoughtChunk != nil:
		e.Kind = "agent_thought_chunk"
		if u.AgentThoughtChunk.Content.Text != nil {
			e.Text = u.AgentThoughtChunk.Content.Text.Text
		}
		if u.AgentThoughtChunk.MessageId != nil {
			e.MessageID = *u.AgentThoughtChunk.MessageId
		}
		return e, true
	case u.UserMessageChunk != nil:
		e.Kind = "user_message_chunk"
		if u.UserMessageChunk.Content.Text != nil {
			e.Text = u.UserMessageChunk.Content.Text.Text
		}
		if u.UserMessageChunk.MessageId != nil {
			e.MessageID = *u.UserMessageChunk.MessageId
		}
		return e, true
	case u.ToolCall != nil:
		e.Kind = "tool_call"
		e.ToolCallID = string(u.ToolCall.ToolCallId)
		e.ToolTitle = u.ToolCall.Title
		e.ToolStatus = string(u.ToolCall.Status)
		e.ToolKind = string(u.ToolCall.Kind)
		e.RawInput = u.ToolCall.RawInput
		return e, true
	case u.ToolCallUpdate != nil:
		e.Kind = "tool_call_update"
		e.ToolCallID = string(u.ToolCallUpdate.ToolCallId)
		if u.ToolCallUpdate.Title != nil {
			e.ToolTitle = *u.ToolCallUpdate.Title
		}
		if u.ToolCallUpdate.Status != nil {
			e.ToolStatus = string(*u.ToolCallUpdate.Status)
		}
		if u.ToolCallUpdate.Kind != nil {
			e.ToolKind = string(*u.ToolCallUpdate.Kind)
		}
		e.RawOutput = u.ToolCallUpdate.RawOutput
		return e, true
	case u.UsageUpdate != nil:
		e.Kind = "usage_update"
		e.Used = int64(u.UsageUpdate.Used)
		e.Size = int64(u.UsageUpdate.Size)
		if u.UsageUpdate.Cost != nil && u.UsageUpdate.Cost.Currency == "USD" {
			c := u.UsageUpdate.Cost.Amount
			e.Cost = &c
		}
		return e, true
	case u.SessionInfoUpdate != nil:
		e.Kind = "session_info"
		if u.SessionInfoUpdate.Title != nil {
			e.Title = *u.SessionInfoUpdate.Title
		}
		return e, true
	case u.Plan != nil:
		e.Kind = "plan"
		e.PlanEntries = flattenPlanEntries(u.Plan.Entries)
		return e, true
	case u.PlanUpdate != nil:
		// UNSTABLE: only the Items variant carries structured entries. File/Markdown
		// variants have none — skip them rather than emit a plan event with nil entries
		// (the consumer treats a plan event as a full replace, so nil would clear it).
		if u.PlanUpdate.Plan.Items == nil {
			return e, false
		}
		e.Kind = "plan"
		e.PlanEntries = flattenPlanEntries(u.PlanUpdate.Plan.Items.Entries)
		return e, true
	case u.ConfigOptionUpdate != nil:
		e.Kind = "config_option"
		e.ConfigOptions = FlattenConfigOptions(u.ConfigOptionUpdate.ConfigOptions)
		return e, true
	case u.AvailableCommandsUpdate != nil:
		// ACP available_commands_update:harness 自报的斜杠命令列表(每个 harness 不同、动态)。
		// 命令名不含 "/"(调用时前端拼 "/"+name 作为普通 prompt 文本发送,协议 §slash-commands)。
		e.Kind = "available_commands"
		cmds := u.AvailableCommandsUpdate.AvailableCommands
		e.Commands = make([]SlashCommand, 0, len(cmds))
		for _, c := range cmds {
			sc := SlashCommand{Name: c.Name, Description: c.Description}
			if c.Input != nil && c.Input.Unstructured != nil {
				sc.InputHint = c.Input.Unstructured.Hint
			}
			e.Commands = append(e.Commands, sc)
		}
		return e, true
	default:
		return e, false
	}
}

// --- 文件系统回调(opencode 多数自带工具直接写盘,不走此回调;这里透传)---

func (h *Handler) WriteTextFile(ctx context.Context, req acp.WriteTextFileRequest) (acp.WriteTextFileResponse, error) {
	if !filepath.IsAbs(req.Path) {
		return acp.WriteTextFileResponse{}, fmt.Errorf("path must be absolute: %s", req.Path)
	}
	if err := os.MkdirAll(filepath.Dir(req.Path), 0o755); err != nil {
		return acp.WriteTextFileResponse{}, err
	}
	if err := os.WriteFile(req.Path, []byte(req.Content), 0o644); err != nil {
		return acp.WriteTextFileResponse{}, err
	}
	return acp.WriteTextFileResponse{}, nil
}

func (h *Handler) ReadTextFile(ctx context.Context, req acp.ReadTextFileRequest) (acp.ReadTextFileResponse, error) {
	if !filepath.IsAbs(req.Path) {
		return acp.ReadTextFileResponse{}, fmt.Errorf("path must be absolute: %s", req.Path)
	}
	b, err := os.ReadFile(req.Path)
	if err != nil {
		return acp.ReadTextFileResponse{}, err
	}
	// Honor optional line (1-based start) / limit (max lines) window (ACP file-system spec).
	if req.Line != nil || req.Limit != nil {
		lines := strings.Split(string(b), "\n")
		start := 0
		if req.Line != nil && *req.Line > 1 {
			start = *req.Line - 1
		}
		if start > len(lines) {
			start = len(lines)
		}
		end := len(lines)
		if req.Limit != nil && *req.Limit > 0 && *req.Limit < end-start {
			end = start + *req.Limit
		}
		return acp.ReadTextFileResponse{Content: strings.Join(lines[start:end], "\n")}, nil
	}
	return acp.ReadTextFileResponse{Content: string(b)}, nil
}

// --- Terminal 回调(阶段0 不支持,opencode 不强依赖)---

func (h *Handler) CreateTerminal(ctx context.Context, req acp.CreateTerminalRequest) (acp.CreateTerminalResponse, error) {
	return acp.CreateTerminalResponse{}, fmt.Errorf("terminal not supported")
}
func (h *Handler) KillTerminal(ctx context.Context, req acp.KillTerminalRequest) (acp.KillTerminalResponse, error) {
	return acp.KillTerminalResponse{}, fmt.Errorf("terminal not supported")
}
func (h *Handler) TerminalOutput(ctx context.Context, req acp.TerminalOutputRequest) (acp.TerminalOutputResponse, error) {
	return acp.TerminalOutputResponse{}, fmt.Errorf("terminal not supported")
}
func (h *Handler) ReleaseTerminal(ctx context.Context, req acp.ReleaseTerminalRequest) (acp.ReleaseTerminalResponse, error) {
	return acp.ReleaseTerminalResponse{}, fmt.Errorf("terminal not supported")
}
func (h *Handler) WaitForTerminalExit(ctx context.Context, req acp.WaitForTerminalExitRequest) (acp.WaitForTerminalExitResponse, error) {
	return acp.WaitForTerminalExitResponse{}, fmt.Errorf("terminal not supported")
}
