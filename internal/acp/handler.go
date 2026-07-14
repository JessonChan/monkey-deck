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
	Kind      string `json:"kind"` // agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | usage_update | plan | session_info | config_option
	Text      string `json:"text"` // chunk 文本(message/thought);agent/thought 为累积全文
	Seq       int64  `json:"seq,omitempty"` // 单调序号(防流式乱序,§4.3)
	MessageID string `json:"messageId,omitempty"` // ACP messageId:同一条逻辑消息的所有 chunk 共享(§5.4 #11),主键归并用

	ToolCallID string `json:"toolCallId,omitempty"`
	ToolTitle  string `json:"toolTitle,omitempty"`
	ToolStatus string `json:"toolStatus,omitempty"`
	ToolKind   string `json:"toolKind,omitempty"`
	RawInput   any    `json:"rawInput,omitempty"`
	RawOutput  any    `json:"rawOutput,omitempty"`

	Used   int64    `json:"used,omitempty"`   // context tokens 已用
	Size   int64    `json:"size,omitempty"`   // context window 总量
	Cost   *float64 `json:"cost,omitempty"`   // 累积成本 USD
	Title         string          `json:"title,omitempty"`  // session_info 标题
	ConfigOptions []ConfigOption  `json:"configOptions,omitempty"` // config_option:model/mode/effort 等(agent 自报)
	PlanEntries   []PlanEntry     `json:"planEntries,omitempty"` // plan:agent 执行计划(整表替换,ACP protocol)
	// ImageSupported:agent 是否支持 image prompt 能力(Initialize 响应 promptCapabilities.image)。
	// 随 config_option 事件下发,前端据此门控图片输入入口(不支持则隐藏/禁用,§3.5)。
	ImageSupported bool `json:"imageSupported,omitempty"`
}

// PlanEntry 是 agent 执行计划的一项(ACP PlanEntry 的扁平化)。
// 整表替换模型:harness 每次 plan_update 发全量列表,client 直接替换。
type PlanEntry struct {
	Content  string `json:"content"`           // 任务描述
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
type PermissionPrompt struct {
	ID        string             `json:"id"`
	SessionID string             `json:"sessionId"`
	ToolName  string             `json:"toolName"`
	Title     string             `json:"title"`
	Options   []PermissionOption `json:"options"`
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

	mu        sync.Mutex
	pending   map[string]*pendingPermission // id → 待裁决
	permSeq   int
	permTTL   time.Duration // 权限裁决超时(超时后按默认动作放行/拒绝)
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
}

type pendingPermission struct {
	prompt   PermissionPrompt
	response chan string // 用户选中的 OptionId
}

// NewHandler 构造一个 Handler。permTTL=0 时用默认 5 分钟。
func NewHandler(workDir string, onEvent func(SessionEvent), onPermission func(PermissionPrompt), permTTL time.Duration) *Handler {
	if permTTL <= 0 {
		permTTL = 5 * time.Minute
	}
	return &Handler{
		Log:         slog.Default(),
		WorkDir:     workDir,
		OnEvent:     onEvent,
		OnPermission: onPermission,
		pending:     map[string]*pendingPermission{},
		permTTL:     permTTL,
	}
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
	opts := make([]PermissionOption, 0, len(req.Options))
	for _, o := range req.Options {
		opts = append(opts, PermissionOption{OptionID: string(o.OptionId), Name: o.Name, Kind: string(o.Kind)})
	}
	p := &pendingPermission{
		prompt: PermissionPrompt{
			ID: id, SessionID: string(req.SessionId), ToolName: toolKindStr(req.ToolCall.Kind), Title: title, Options: opts,
		},
		response: make(chan string, 1),
	}
	h.pending[id] = p
	h.mu.Unlock()

	// 通知前端弹窗(service → Wails3 event)。
	if h.OnPermission != nil {
		h.OnPermission(p.prompt)
	}

	// 等用户响应,带超时兜底(§3.4:超时按默认动作,避免永久卡死)。
	timer := time.NewTimer(h.permTTL)
	defer timer.Stop()
	select {
	case level := <-p.response:
		opt := h.applyDecision(level, req.Options)
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: opt}},
		}, nil
	case <-timer.C:
		// 超时:默认动作 —— 取第一个 allow 选项放行(桌面有人但走开了,宁可放行让对话继续)。
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		def := defaultOption(req.Options)
		slog.Warn("permission request timed out, using default", "title", title, "default", def)
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Selected: &acp.RequestPermissionOutcomeSelected{OptionId: def}},
		}, nil
	case <-ctx.Done():
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{}},
		}, ctx.Err()
	}
}

// applyDecision 把前端传来的裁决档位(once/session/project/deny)映射成 ACP 选项,
// 并按档位设置记忆:session/project 档令后续「所有 RequestPermission」自动放行(不弹,见字段注释)。deny 只本次不记。
func (h *Handler) applyDecision(level string, opts []acp.PermissionOption) acp.PermissionOptionId {
	switch level {
	case "deny":
		if id := pickRejectOption(opts); id != "" {
			return id
		}
	case "session":
		h.sessionAllowExternal.Store(true)
	case "project":
		h.sessionAllowExternal.Store(true)
		h.projectAllowExternal.Store(true)
	default: // "once":允许本次,不记忆
	}
	return pickAllowOption(opts)
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
		h.OnEvent(e)
	}
	return nil
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
		// UNSTABLE:plan_update 的 Items 变体带结构化 entries(与 Plan 同形);File/Markdown 无结构化项,忽略。
		e.Kind = "plan"
		if u.PlanUpdate.Plan.Items != nil {
			e.PlanEntries = flattenPlanEntries(u.PlanUpdate.Plan.Items.Entries)
		}
		return e, true
	case u.ConfigOptionUpdate != nil:
		e.Kind = "config_option"
		e.ConfigOptions = FlattenConfigOptions(u.ConfigOptionUpdate.ConfigOptions)
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

