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
	"sync"
	"time"

	"github.com/coder/acp-go-sdk"
)

// SessionEvent 是给前端用的「扁平化 SessionUpdate」(AGENTS.md §1.6/§4.3)。
// agent 的全部产出——消息、思考、工具调用、用量——都从 SessionUpdate 回调流入,
// 这里转成 JSON 友好的结构,由 service 层经 Wails3 event 推前端流式渲染。
type SessionEvent struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"` // agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | usage_update | plan | session_info
	Text      string `json:"text"` // chunk 文本(message/thought);agent/thought 为累积全文
	Seq       int64  `json:"seq,omitempty"` // 单调序号(防流式乱序,§4.3)

	ToolCallID string `json:"toolCallId,omitempty"`
	ToolTitle  string `json:"toolTitle,omitempty"`
	ToolStatus string `json:"toolStatus,omitempty"`
	ToolKind   string `json:"toolKind,omitempty"`
	RawInput   any    `json:"rawInput,omitempty"`
	RawOutput  any    `json:"rawOutput,omitempty"`

	Used   int64    `json:"used,omitempty"`   // context tokens 已用
	Size   int64    `json:"size,omitempty"`   // context window 总量
	Cost   *float64 `json:"cost,omitempty"`   // 累积成本 USD
	Title  string   `json:"title,omitempty"`  // session_info 标题
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
	case selected := <-p.response:
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{
			Selected: &acp.RequestPermissionOutcomeSelected{OptionId: acp.PermissionOptionId(selected)},
			},
		}, nil
	case <-timer.C:
		// 超时:默认动作 —— 取第一个 allow 选项放行(桌面有人但走开了,宁可放行让对话继续)。
		h.mu.Lock()
		delete(h.pending, id)
		h.mu.Unlock()
		def := defaultOption(req.Options)
		slog.Warn("permission request timed out, using default", "title", title, "default", def)
		return acp.RequestPermissionResponse{
			Outcome: acp.RequestPermissionOutcome{
				Selected: &acp.RequestPermissionOutcomeSelected{OptionId: def},
			},
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
		return e, true
	case u.AgentThoughtChunk != nil:
		e.Kind = "agent_thought_chunk"
		if u.AgentThoughtChunk.Content.Text != nil {
			e.Text = u.AgentThoughtChunk.Content.Text.Text
		}
		return e, true
	case u.UserMessageChunk != nil:
		e.Kind = "user_message_chunk"
		if u.UserMessageChunk.Content.Text != nil {
			e.Text = u.UserMessageChunk.Content.Text.Text
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

