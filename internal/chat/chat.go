package chat

// chat.go:ChatService 是前端与后端的桥梁(Wails3 service)。
// 组合 internal/acp(纯 ACP 生命周期)+ internal/store(SQLite 真相来源),
// 通过 Wails3 binding 暴露方法、通过 event 把 SessionUpdate 流推前端(AGENTS.md §2.1/§4.3)。
//
// 前端永远不直接碰 ACP 连接;所有 agent 交互经此 service。

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/store"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// 事件名(前端 Events.On 监听这些)。
const (
	EventUpdate     = "chat:event"      // SessionEvent(流式 chunk / tool / usage)
	EventPermission = "chat:permission" // PermissionPrompt(需用户裁决)
	EventStatus     = "chat:status"     // StatusPayload(会话状态:started/prompting/idle/error/closed)
	EventSessionMeta = "chat:session-meta" // SessionMetaPayload(标题等元信息更新)
)

// StatusPayload 会话状态变更。
type StatusPayload struct {
	SessionID string `json:"sessionId"`
	Status    string `json:"status"` // started | prompting | idle | error | closed
	Detail    string `json:"detail,omitempty"`
}

// SessionMetaPayload 会话元信息更新(标题等)。
type SessionMetaPayload struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
}

// toolAccum 累积一个 tool call 的状态(供持久化)。
type toolAccum struct {
	id     string
	title  string
	status string
	kind   string
}

// liveSession 一个活跃的 ACP 对话(内存态,钉在某个 db session 上)。
type liveSession struct {
	chat   *acp.ChatSession
	cancel context.CancelFunc // 取消正在进行的 Prompt
	proj   *store.Project

	mu       sync.Mutex
	agentBuf strings.Builder  // 累积本轮 agent_message_chunk 文本
	thought  strings.Builder  // 累积本轮 agent_thought_chunk 文本
	tools    map[string]*toolAccum
	seq      int64 // 单调序号,流式事件防乱序(§4.3)
}

func (ls *liveSession) resetBuffers() {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.agentBuf.Reset()
	ls.thought.Reset()
	ls.tools = map[string]*toolAccum{}
}

// ChatService 暴露给前端的主服务。
type ChatService struct {
	cfg *config.Config
	st  *store.Store
	ctx context.Context

	mu     sync.RWMutex
	active map[string]*liveSession // db sessionID → live
}

// NewChatService 构造(尚未启动;ServiceStartup 时 open store)。
func NewChatService(cfg *config.Config) *ChatService {
	return &ChatService{cfg: cfg, active: map[string]*liveSession{}}
}

// ServiceStartup Wails3 启动钩子:建数据目录 + open store。
func (s *ChatService) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	s.ctx = ctx
	if err := s.cfg.EnsureDir(); err != nil {
		return fmt.Errorf("ensure data dir: %w", err)
	}
	st, err := store.New(s.cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	s.st = st
	s.loadPersistedConfig()
	acp.KillAllOpencode() // 启动时清上轮残留 opencode(§3.2)
	slog.Info("chat service started", "dataDir", s.cfg.DataDir)
	return nil
}

// ServiceShutdown Wails3 关闭钩子:关所有活跃 session + store。
func (s *ChatService) ServiceShutdown() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, ls := range s.active {
		ls.chat.Close()
		delete(s.active, id)
	}
	if s.st != nil {
		s.st.Close()
	}
	slog.Info("chat service shutdown")
	return nil
}

// emit 经 Wails3 event 推前端(§4.3)。
func (s *ChatService) emit(name string, data any) {
	app := application.Get()
	if app == nil {
		return
	}
	app.Event.Emit(name, data)
}

func (s *ChatService) emitStatus(sessionID, status, detail string) {
	s.emit(EventStatus, StatusPayload{SessionID: sessionID, Status: status, Detail: detail})
}

func (s *ChatService) emitSessionMeta(sessionID, title string) {
	s.emit(EventSessionMeta, SessionMetaPayload{SessionID: sessionID, Title: title})
}

// maybeAutoTitle 会话无标题时,用首条消息生成标题并持久化 + 推前端(兜底;opencode 的 session_info 标题更优,见 handleEvent)。
func (s *ChatService) maybeAutoTitle(sessionID, text string) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil || se == nil || se.Title != "" {
		return
	}
	title := makeTitle(text)
	if title == "" {
		return
	}
	if err := s.st.UpdateSessionTitle(s.ctx, sessionID, title); err != nil {
		return
	}
	s.emitSessionMeta(sessionID, title)
}

// makeTitle 从消息文本生成简短标题(换行→空格,截断 ~24 字)。
func makeTitle(text string) string {
	t := strings.TrimSpace(text)
	if t == "" {
		return ""
	}
	for _, r := range []string{"\n", "\r", "\t"} {
		t = strings.ReplaceAll(t, r, " ")
	}
	t = strings.TrimSpace(t)
	rs := []rune(t)
	if len(rs) > 24 {
		return string(rs[:24]) + "…"
	}
	return t
}

// --- Projects ---

// ListProjects 列出全部项目。
func (s *ChatService) ListProjects() ([]store.Project, error) {
	return s.st.ListProjects(s.ctx)
}

// AddProject 新建项目。path 必须是已存在的目录。model 为空用默认。
func (s *ChatService) AddProject(name, path, model string) (*store.Project, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("abs path: %w", err)
	}
	if info, err := os.Stat(abs); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("path is not an existing directory: %s", abs)
	}
	if name == "" {
		name = filepath.Base(abs)
	}
	if model == "" {
		model = s.cfg.DefaultModel
	}
	if existing, _ := s.st.GetProjectByPath(s.ctx, abs); existing != nil {
		return existing, nil // 同目录幂等:返回已有项目
	}
	return s.st.CreateProject(s.ctx, name, abs, model)
}

// UpdateProject 更新项目 name/model。
func (s *ChatService) UpdateProject(id, name, model string) error {
	return s.st.UpdateProject(s.ctx, id, name, model)
}

// RemoveProject 删除项目(同时关掉其活跃 session)。
func (s *ChatService) RemoveProject(id string) error {
	s.mu.Lock()
	for sid, ls := range s.active {
		if ls.proj != nil && ls.proj.ID == id {
			ls.chat.Close()
			delete(s.active, sid)
		}
	}
	s.mu.Unlock()
	return s.st.DeleteProject(s.ctx, id)
}

// --- Sessions ---

// ListSessions 列出某项目的全部 session。
func (s *ChatService) ListSessions(projectID string) ([]store.Session, error) {
	return s.st.ListSessions(s.ctx, projectID)
}

// CreateSession 新建 session 并立即启动 ACP 对话(spawn harness → NewSession,§1.3)。
func (s *ChatService) CreateSession(projectID, title string) (*store.Session, error) {
	proj, err := s.st.GetProject(s.ctx, projectID)
	if err != nil {
		return nil, err
	}
	if proj == nil {
		return nil, fmt.Errorf("project not found: %s", projectID)
	}
	model := proj.Model
	if model == "" {
		model = s.cfg.DefaultModel
	}
	se, err := s.st.CreateSession(s.ctx, projectID, title, model)
	if err != nil {
		return nil, err
	}
	return se, nil
}

// OpenSession 打开已有 session:有 acp_session_id 则 LoadSession 恢复,否则新建 ACP session(§1.4)。
func (s *ChatService) OpenSession(sessionID string) error {
	if s.isActive(sessionID) {
		return nil // 已活跃
	}
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return err
	}
	if se == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	return nil // harness 懒启动:首条消息时 spawn(避免 idle disconnect)
}

// ensureLive 确保 session 的 harness 已启动(懒启动):未活跃则 spawn。
// 在首条消息时调用,避免会话创建后 opencode 空闲断连(idle disconnect)。
func (s *ChatService) ensureLive(sessionID string) error {
	s.mu.RLock()
	_, ok := s.active[sessionID]
	s.mu.RUnlock()
	if ok {
		return nil
	}
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return err
	}
	if se == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	proj, err := s.st.GetProject(s.ctx, se.ProjectID)
	if err != nil {
		return err
	}
	if proj == nil {
		return fmt.Errorf("project not found for session")
	}
	resume := se.ACPSession != ""
	return s.startLive(se, proj, se.ACPSession, resume)
}

// startLive 启动一个 liveSession(spawn harness + Init + NewSession/LoadSession)。
func (s *ChatService) startLive(se *store.Session, proj *store.Project, acpSessionID string, resume bool) error {
	runner := acp.NewRunner(s.cfg.HarnessCmd, nil, se.Model)

	ls := &liveSession{proj: proj, tools: map[string]*toolAccum{}}
	onEvent := func(e acp.SessionEvent) {
		s.handleEvent(ls, se.ID, e)
	}
	onPermission := func(p acp.PermissionPrompt) {
		p.SessionID = se.ID // 对齐到 db sessionID(便于前端按 session 过滤)
		s.emit(EventPermission, p)
	}

	ctx, cancel := context.WithCancel(s.ctx)
	var (
		chat *acp.ChatSession
		err  error
	)
	if resume {
		chat, err = runner.LoadChatSession(ctx, proj.Path, acpSessionID, onEvent, onPermission)
	} else {
		chat, err = runner.NewChatSession(ctx, proj.Path, onEvent, onPermission)
	}
	if err != nil {
		cancel()
		return fmt.Errorf("start acp session: %w", err)
	}
	ls.chat = chat
	ls.cancel = cancel

	s.mu.Lock()
	s.active[se.ID] = ls
	s.mu.Unlock()

	// 新建时记录 opencode 返回的 session id(供下次 resume)。
	if !resume {
		_ = s.st.UpdateSessionACP(s.ctx, se.ID, string(chat.SessionID), se.Title)
	}
	s.emitStatus(se.ID, "started", "")
	slog.Info("session live", "id", se.ID, "resume", resume, "cwd", proj.Path, "model", se.Model)
	return nil
}

// CloseSession 关闭活跃 ACP session(保留 db 记录,可再次 Open)。
func (s *ChatService) CloseSession(sessionID string) error {
	s.mu.Lock()
	ls, ok := s.active[sessionID]
	if ok {
		delete(s.active, sessionID)
	}
	s.mu.Unlock()
	if !ok {
		return nil
	}
	ls.chat.Close()
	s.reapIfIdle()
	s.emitStatus(sessionID, "closed", "")
	return nil
}

// reapIfIdle 仅当无活跃 session 时 reap 逃逸 opencode(多 session 并发安全,§3.2)。
func (s *ChatService) reapIfIdle() {
	s.mu.RLock()
	n := len(s.active)
	s.mu.RUnlock()
	if n == 0 {
		acp.ReapStrayOpencode()
	}
}

// LoadMessages 取某 session 的全部历史消息(打开 session 时渲染)。
func (s *ChatService) LoadMessages(sessionID string) ([]store.Message, error) {
	return s.st.ListMessages(s.ctx, sessionID)
}

// --- Messaging ---

// SendMessage 发送用户消息并驱动 opencode 回复(Prompt,§1.3)。
// 期间 SessionUpdate 回调并发流入 → 经 event 流式推前端;Prompt 返回后持久化。
func (s *ChatService) SendMessage(sessionID, text string) error {
	// 懒启动:首条消息时 spawn harness(避免 idle disconnect)。
	if err := s.ensureLive(sessionID); err != nil {
		return err
	}
	s.mu.RLock()
	ls := s.active[sessionID]
	s.mu.RUnlock()
	if ls == nil {
		return fmt.Errorf("session not active: %s", sessionID)
	}
	ls.resetBuffers()

	// 持久化用户消息。
	if _, err := s.st.AppendMessage(s.ctx, sessionID, "user", "", text, ""); err != nil {
		return err
	}
	s.maybeAutoTitle(sessionID, text)
	// 即时把用户消息也走一次 event(前端可统一处理)。
	s.emit(EventUpdate, acp.SessionEvent{SessionID: sessionID, Kind: "user_message_chunk", Text: text})

	s.emitStatus(sessionID, "prompting", "")
	go s.runPrompt(ls, sessionID, text)
	return nil
}

// SendAndWaitSync 同步发送并等待回复(供驱动/测试用;GUI 用异步 SendMessage)。
// 返回 agent 文本与错误。失败(peer disconnected)时由调用方重试(下次 ensureLive 会 LoadSession 重连)。
func (s *ChatService) SendAndWaitSync(sessionID, text string) (string, error) {
	if err := s.ensureLive(sessionID); err != nil {
		return "", err
	}
	s.mu.RLock()
	ls := s.active[sessionID]
	s.mu.RUnlock()
	if ls == nil {
		return "", fmt.Errorf("session not active: %s", sessionID)
	}
	ls.resetBuffers()
	if _, err := s.st.AppendMessage(s.ctx, sessionID, "user", "", text, ""); err != nil {
		return "", err
	}
	s.emit(EventUpdate, acp.SessionEvent{SessionID: sessionID, Kind: "user_message_chunk", Text: text})
	s.emitStatus(sessionID, "prompting", "")

	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	stopReason, err := ls.chat.Prompt(ctx, text, 300*time.Second)
	ls.mu.Lock()
	agentText := ls.agentBuf.String()
	thoughtText := ls.thought.String()
	tools := make([]*toolAccum, 0, len(ls.tools))
	for _, t := range ls.tools {
		tools = append(tools, t)
	}
	ls.mu.Unlock()
	s.persistTurn(sessionID, agentText, thoughtText, tools)
	if err != nil {
		if acp.IsPeerDisconnected(err) {
			s.mu.Lock()
			delete(s.active, sessionID)
			s.mu.Unlock()
			ls.chat.Close()
			s.reapIfIdle()
		}
		s.emitStatus(sessionID, "error", err.Error())
		return agentText, err
	}
	s.emitStatus(sessionID, "idle", "stopReason="+string(stopReason))
	return agentText, nil
}

// runPrompt 在后台执行 Prompt(可能很久),结果回写 db + 推 status。
func (s *ChatService) runPrompt(ls *liveSession, sessionID, text string) {
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	stopReason, err := ls.chat.Prompt(ctx, text, 300*time.Second)
	ls.mu.Lock()
	agentText := ls.agentBuf.String()
	thoughtText := ls.thought.String()
	tools := make([]*toolAccum, 0, len(ls.tools))
	for _, t := range ls.tools {
		tools = append(tools, t)
	}
	ls.mu.Unlock()

	if err != nil {
		detail := err.Error()
		if acp.IsPeerDisconnected(err) {
			detail = "agent 进程已断开,下条消息将自动重连"
			// 拆掉死掉的 harness,下次 ensureLive 会用 LoadSession(resume) 重连(§1.4)。
			s.mu.Lock()
			delete(s.active, sessionID)
			s.mu.Unlock()
			ls.chat.Close()
			s.reapIfIdle()
		}
		slog.Error("prompt failed", "session", sessionID, "err", err)
		// 持久化已收到的部分回复(即使失败也不丢)。
		s.persistTurn(sessionID, agentText, thoughtText, tools)
		s.emitStatus(sessionID, "error", detail)
		return
	}
	s.persistTurn(sessionID, agentText, thoughtText, tools)
	s.emitStatus(sessionID, "idle", "stopReason="+string(stopReason))
}

// persistTurn 把本轮累积的 agent 回复 + 工具调用写库。
func (s *ChatService) persistTurn(sessionID, agentText, thoughtText string, tools []*toolAccum) {
	if thoughtText != "" {
		if _, err := s.st.AppendMessage(s.ctx, sessionID, "thought", "agent_thought_chunk", thoughtText, ""); err != nil {
			slog.Warn("persist thought", "err", err)
		}
	}
	for _, t := range tools {
		body, _ := json.Marshal(t)
		if _, err := s.st.AppendMessage(s.ctx, sessionID, "tool", "tool_call", string(body), t.id); err != nil {
			slog.Warn("persist tool", "err", err)
		}
	}
	if strings.TrimSpace(agentText) != "" {
		if _, err := s.st.AppendMessage(s.ctx, sessionID, "agent", "agent_message_chunk", agentText, ""); err != nil {
			slog.Warn("persist agent", "err", err)
		}
	}
}

// handleEvent 处理一条 SessionUpdate:累积 + 推前端。
// agent/thought 发「累积全文 + 单调序号」(非增量),前端按序号替换 —— 事件即使乱序也不乱码(§4.3)。
func (s *ChatService) handleEvent(ls *liveSession, sessionID string, e acp.SessionEvent) {
	e.SessionID = sessionID
	ls.mu.Lock()
	ls.seq++
	e.Seq = ls.seq
	switch e.Kind {
	case "agent_message_chunk":
		ls.agentBuf.WriteString(e.Text)
		e.Text = ls.agentBuf.String() // 累积全文
	case "agent_thought_chunk":
		ls.thought.WriteString(e.Text)
		e.Text = ls.thought.String()
	case "tool_call":
		ls.tools[e.ToolCallID] = &toolAccum{id: e.ToolCallID, title: e.ToolTitle, status: e.ToolStatus, kind: e.ToolKind}
	case "tool_call_update":
		if t, ok := ls.tools[e.ToolCallID]; ok {
			if e.ToolTitle != "" {
				t.title = e.ToolTitle
			}
			if e.ToolStatus != "" {
				t.status = e.ToolStatus
			}
			if e.ToolKind != "" {
				t.kind = e.ToolKind
			}
		} else {
			ls.tools[e.ToolCallID] = &toolAccum{id: e.ToolCallID, title: e.ToolTitle, status: e.ToolStatus, kind: e.ToolKind}
		}
	}
	ls.mu.Unlock()
	if e.Kind == "session_info" && e.Title != "" {
		// opencode 发来的会话标题(更优,覆盖自动标题)。
		if err := s.st.UpdateSessionTitle(s.ctx, sessionID, e.Title); err == nil {
			s.emitSessionMeta(sessionID, e.Title)
		}
	}
	s.emit(EventUpdate, e)
}

// RespondPermission 用户在前端对某权限请求做出裁决(§3.4)。
func (s *ChatService) RespondPermission(sessionID, reqID, optionID string) error {
	s.mu.RLock()
	ls, ok := s.active[sessionID]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not active")
	}
	if !ls.chat.RespondPermission(reqID, optionID) {
		return fmt.Errorf("no pending permission: %s", reqID)
	}
	return nil
}

// StopSession 取消正在进行的 Prompt(用户点「停止」)。
func (s *ChatService) StopSession(sessionID string) error {
	s.mu.RLock()
	ls, ok := s.active[sessionID]
	s.mu.RUnlock()
	if !ok {
		return nil
	}
	ls.cancel()
	s.emitStatus(sessionID, "idle", "stopped by user")
	return nil
}

func (s *ChatService) isActive(sessionID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.active[sessionID]
	return ok
}

// --- 配置查询(前端设置页用)---

// GetConfig 返回当前配置(harness 命令、默认 model、数据目录)。
func (s *ChatService) GetConfig() map[string]string {
	return map[string]string{
		"harnessCmd":   s.cfg.HarnessCmd,
		"defaultModel": s.cfg.DefaultModel,
		"dataDir":      s.cfg.DataDir,
	}
}

// SetDefaultModel 设置全局默认 model(写 settings)。
func (s *ChatService) SetDefaultModel(model string) error {
	s.cfg.DefaultModel = model
	return s.st.SetSetting(s.ctx, "defaultModel", model)
}

// loadPersistedConfig 从 settings 恢复持久化配置(默认 model 等)。
func (s *ChatService) loadPersistedConfig() {
	if m, _ := s.st.GetSetting(s.ctx, "defaultModel"); m != "" {
		s.cfg.DefaultModel = m
	}
}
