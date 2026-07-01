package chat

// chat.go:ChatService 是前端与后端的桥梁(Wails3 service)。
// 组合 internal/acp(纯 ACP 生命周期)+ internal/store(SQLite 真相来源),
// 通过 Wails3 binding 暴露方法、通过 event 把 SessionUpdate 流推前端(AGENTS.md §2.1/§4.3)。
//
// 前端永远不直接碰 ACP 连接;所有 agent 交互经此 service。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/fsview"
	"github.com/jessonchan/monkey-deck/internal/harness"
	"github.com/jessonchan/monkey-deck/internal/store"
	"github.com/jessonchan/monkey-deck/internal/titlegen"
	"github.com/jessonchan/monkey-deck/internal/worktree"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// 事件名(前端 Events.On 监听这些)。
const (
	EventUpdate      = "chat:event"        // SessionEvent(流式 chunk / tool / usage)
	EventPermission  = "chat:permission"   // PermissionPrompt(需用户裁决)
	EventStatus      = "chat:status"       // StatusPayload(会话状态:started/prompting/idle/error/closed)
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
	ID        string `json:"id"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	Kind      string `json:"kind"`
	RawInput  any    `json:"rawInput,omitempty"`
	RawOutput any    `json:"rawOutput,omitempty"`
}

// chatConn 是 *acp.ChatSession 的最小行为接口,供单测注入 mock(AGENTS.md §5.1:
// ACP 行为靠接口注入 mock,单测不启真 harness)。*acp.ChatSession 满足此接口。
type chatConn interface {
	Prompt(ctx context.Context, message string, attachments []acp.Attachment, timeout time.Duration) (acp.StopReason, error)
	Close()
	// IsAlive 报告 harness 进程是否存活(预热后空闲断连兜底:活跃但进程已死 → 拆掉重 spawn)。
	IsAlive() bool
	RespondPermission(id, optionID string) bool
	// SessionTitle 经 ACP session/list 拉 harness 生成的权威标题(§5.4 #14)。
	SessionTitle(ctx context.Context) (string, error)
	// FlatConfigOptions 返回扁平化的 config options(给前端渲染下拉)。
	FlatConfigOptions() []acp.ConfigOption
	// SetConfigOption 切换 config option(model/mode/effort),热切同 session 即时生效。
	SetConfigOption(ctx context.Context, configId, value string) error
}

// segEntry 一段已完成的 thinking / agent message(多 tool call 交替时一轮有多个段)。
type segEntry struct {
	role    string // "thought" | "agent"
	content string
}

// liveSession 一个活跃的 ACP 对话(内存态,钉在某个 db session 上)。
type liveSession struct {
	chat chatConn
	proj *store.Project

	mu            sync.Mutex
	agentBuf      strings.Builder // 累积当前段的 agent_message_chunk 文本
	thought       strings.Builder // 累积当前段的 agent_thought_chunk 文本
	tools         map[string]*toolAccum
	seq           int64      // 单调序号,流式事件防乱序(§4.3)
	segments      []segEntry // 已完成的段(类型切换时 flush,持久化时逐段写库)
	lastChunkKind string     // 上一个 chunk 类型:"thought"/"agent"/"" — 检测段边界

	// 单 turn 生命周期:ACP 协议无 queue,一个 session 同时只允许一个 Prompt
	// (session/prompt 是同步请求-响应,turn 未结束前不能发下一个,见 §5.4 调研结论)。
	// sendMu 串行化所有「发起 turn」入口(SendMessage / InterruptAndSend),
	// busy 在 sendMu 保护下同步置位,杜绝两轮 Prompt 重叠(治本并发隐患)。
	sendMu       sync.Mutex
	busy         bool               // 本轮 Prompt 进行中
	lastActivity int64              // 最后活动时间(unix milli);startLive 初始化、turn 结束时更新。idle reaper 据此判定关闭。
	turnCancel   context.CancelFunc // 取消本轮 Prompt(干净 session/cancel,非杀进程)
	turnDone     chan struct{}      // 本轮 runPrompt 返回时关闭(供 InterruptAndSend 等待其落定)
	suppressIdle bool               // InterruptAndSend 置位:本轮结束不发 idle(打断后由新轮发 prompting,避免触发前端 auto-continue 误续发)
}

func (ls *liveSession) resetBuffers() {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.agentBuf.Reset()
	ls.thought.Reset()
	ls.tools = map[string]*toolAccum{}
	ls.segments = nil
	ls.lastChunkKind = ""
}

// flushCurrentSegment 把上一个段类型的 buffer 内容存入 segments 并重置。
// 段边界(thought→message / message→thought / any→tool)时调用,确保各段独立。
func (ls *liveSession) flushCurrentSegment() {
	switch ls.lastChunkKind {
	case "thought":
		if ls.thought.Len() > 0 {
			ls.segments = append(ls.segments, segEntry{"thought", ls.thought.String()})
		}
		ls.thought.Reset()
	case "agent":
		if ls.agentBuf.Len() > 0 {
			ls.segments = append(ls.segments, segEntry{"agent", ls.agentBuf.String()})
		}
		ls.agentBuf.Reset()
	}
}

// ChatService 暴露给前端的主服务。
type ChatService struct {
	cfg *config.Config
	st  *store.Store
	ctx context.Context

	mu      sync.RWMutex
	active  map[string]*liveSession // db sessionID → live
	spawnMu sync.Mutex              // 串行化 ensureLive 的 spawn 段,杜绝 warm 与首条消息并发双 spawn

	// idle reaper:超 idleTimeout 未活动且非 busy 的 session 自动 CloseSession,释放资源(B 方案)。
	// ServiceStartup 起 goroutine,ServiceShutdown 优雅停。测试注入短 timeout。
	idleTimeout time.Duration
	reaperStop  chan struct{}
	reaperDone  chan struct{}

	// 测试钩子(nil = 生产路径,见 emit/persistTurn):emitHook 捕获 emit 事件序列、
	// persistHook 在 persistTurn 入口阻塞。仅单测注入,用于确定性复现 runPrompt
	// 收尾与并发 send 的竞态(§5.4 覆盖竞态)。
	emitHook    func(name string, data any)
	persistHook func()
}

// NewChatService 构造(尚未启动;ServiceStartup 时 open store)。
func NewChatService(cfg *config.Config) *ChatService {
	return &ChatService{cfg: cfg, active: map[string]*liveSession{}, idleTimeout: 5 * time.Minute}
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
	acp.SetPgidFile(filepath.Join(s.cfg.DataDir, "opencode-pgids.json")) // §3.2:限定 KillAll 范围到本应用残留
	acp.KillAllOpencode()                                                // 启动时清上轮残留 opencode(§3.2)
	s.startIdleReaper()                                                  // B 方案:idle reaper 回收空闲 harness
	slog.Info("chat service started", "dataDir", s.cfg.DataDir)
	return nil
}

// ServiceShutdown Wails3 关闭钩子:停 idle reaper + 关所有活跃 session + store。
func (s *ChatService) ServiceShutdown() error {
	// 先停 idle reaper,避免它与关 session 竞争。
	if s.reaperStop != nil {
		close(s.reaperStop)
		<-s.reaperDone
	}
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

// ToggleMaximise 双击顶部标题栏时切换窗口最大化/还原(非 fullscreen)。
// 单窗口桌面应用,取首个窗口。
func (s *ChatService) ToggleMaximise() {
	app := application.Get()
	if app == nil {
		return
	}
	wins := app.Window.GetAll()
	if len(wins) == 0 {
		return
	}
	wins[0].ToggleMaximise()
}

// emit 经 Wails3 event 推前端(§4.3)。
func (s *ChatService) emit(name string, data any) {
	if s.emitHook != nil {
		s.emitHook(name, data) // 测试钩子:捕获事件序列(生产 nil,走 Wails3 event)
		return
	}
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

// maybeAutoTitle 会话无标题时,用首条消息生成「兜底纯文本标题」并持久化 + 推前端。
// 返回写入的兜底标题(空 = 未写入:会话已有标题或消息为空)。
//
// 这是**瞬时兜底**:harness 尚未生成/送达标题前给侧栏一个可读标题。harness 的权威标题
// 经 session_info_update 推送(见 handleEvent)或 session/list 拉取(见 syncSessionTitle)
// 到达后覆盖本兜底。harness 是否生成标题、走哪条通道,由其自身决定(§5.4 #14)。
func (s *ChatService) maybeAutoTitle(sessionID, text string) string {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil || se == nil || se.Title != "" {
		return ""
	}
	title := titlegen.FallbackTitle(text, "")
	if title == "" {
		return ""
	}
	if err := s.st.UpdateSessionTitle(s.ctx, sessionID, title); err != nil {
		return ""
	}
	s.emitSessionMeta(sessionID, title)
	return title
}

// syncSessionTitle 经 session/list 拉 harness 为本 session 生成的权威标题,
// 若与当前存储标题不同则覆盖 + 推前端(§5.4 #14)。仅当 harness 声明了 session/list
// 能力时可调;harness 通常在 turn 结束后才暴露标题,故在 runPrompt 成功后调用。
// 失败(未声明能力/无标题)静默跳过,兜底标题保留。
func (s *ChatService) syncSessionTitle(ls *liveSession, sessionID string) {
	tctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	title, err := ls.chat.SessionTitle(tctx)
	if err != nil || title == "" {
		return
	}
	se, _ := s.st.GetSession(s.ctx, sessionID)
	if se == nil || se.Title == title {
		return
	}
	if err := s.st.UpdateSessionTitle(s.ctx, sessionID, title); err != nil {
		return
	}
	s.emitSessionMeta(sessionID, title)
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

// ReorderProjects 按传入 id 顺序重写项目排序(侧栏拖拽后调用,0007)。
func (s *ChatService) ReorderProjects(ids []string) error {
	return s.st.ReorderProjects(s.ctx, ids)
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
	// 清理该项目下所有 session 的 worktree + 分支。
	if sess, err := s.st.ListSessions(s.ctx, id); err == nil {
		for _, se := range sess {
			s.cleanupWorktree(&se)
		}
	}
	return s.st.DeleteProject(s.ctx, id)
}

// --- Sessions ---

// ListSessions 列出某项目的全部 session。
func (s *ChatService) ListSessions(projectID string) ([]store.Session, error) {
	return s.st.ListSessions(s.ctx, projectID)
}

// SearchSessionContent 返回某项目下消息内容包含 query(大小写不敏感)的 session id 列表。
// 供侧栏会话搜索:与标题命中(前端本地子串)做并集,实现「按标题或内容找会话」(§4.1)。
func (s *ChatService) SearchSessionContent(projectID, query string) ([]string, error) {
	return s.st.SearchSessionIDsByContent(s.ctx, projectID, query)
}

// CreateSession 新建 session。harness 指定使用的 agent(omp/opencode,空=omp 默认);
// useWorktree=true 时为 git 项目建独立 worktree+分支(并行隔离),否则直接用项目目录(§1.4)。
func (s *ChatService) CreateSession(projectID, title, harnessID string, useWorktree bool) (*store.Session, error) {
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
	hid := harness.Normalize(harnessID)
	se, err := s.st.CreateSession(s.ctx, projectID, title, model, hid)
	if err != nil {
		return nil, err
	}
	// git 项目 + 用户选择建 worktree:为该 session 建独立 worktree+分支(并行隔离;失败降级用项目目录)。
	if useWorktree && worktree.IsRepo(proj.Path) {
		short := se.ID
		if len(short) > 8 {
			short = short[:8]
		}
		branch := "md/" + short
		wtPath := filepath.Join(s.cfg.DataDir, "worktrees", proj.ID, se.ID)
		if err := worktree.Create(proj.Path, branch, wtPath, ""); err != nil {
			slog.Warn("create session worktree failed, fallback to project dir", "err", err)
		} else if err := s.st.SetSessionWorktree(s.ctx, se.ID, wtPath, branch); err != nil {
			slog.Warn("persist session worktree failed", "err", err)
		} else {
			se.WorktreePath, se.Branch = wtPath, branch
		}
	}
	// B 方案:不在创建时 spawn。用户切到该 session 时 App.tsx 的 openSession 回调调
	// OpenSession → 异步 ensureLive → spawn + 推 config_option。「没切过去就不 spawn」。
	return se, nil
}

// cleanupWorktree 删除某 session 的 worktree + 分支(若存在)。非 git session 无操作。
func (s *ChatService) cleanupWorktree(se *store.Session) {
	if se.WorktreePath == "" || se.Branch == "" {
		return
	}
	proj, err := s.st.GetProject(s.ctx, se.ProjectID)
	if err != nil || proj == nil {
		return
	}
	if err := worktree.Remove(proj.Path, se.WorktreePath, se.Branch); err != nil {
		slog.Warn("cleanup worktree", "session", se.ID, "err", err)
	}
}

// DeleteSession 删除 session(关闭活跃 harness + 清理 worktree + 删 DB 记录)。
func (s *ChatService) DeleteSession(sessionID string) error {
	s.mu.Lock()
	if ls, ok := s.active[sessionID]; ok {
		ls.chat.Close()
		delete(s.active, sessionID)
	}
	s.mu.Unlock()
	if se, _ := s.st.GetSession(s.ctx, sessionID); se != nil {
		s.cleanupWorktree(se)
	}
	return s.st.DeleteSession(s.ctx, sessionID)
}

// MergeSession 把 session 分支已提交的内容合并进项目主仓库。
// 只 merge 已 commit 的内容(git merge 本就只合并 commit);未提交的改动不会进 merge ——
// 由源代码管理面板负责提交(精细 stage/commit 是 SCM 面板的职责,merge 不再越权 git add .)。
// 若 worktree 仍有未提交改动,结果里给出提示,让用户知道还有东西没合并。
func (s *ChatService) MergeSession(sessionID string) (string, error) {
	if s.isBusy(sessionID) {
		return "", errSCMBusy
	}
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", err
	}
	if se == nil || se.Branch == "" {
		return "", fmt.Errorf("session 无独立分支(非 git 项目或未建 worktree)")
	}
	proj, err := s.st.GetProject(s.ctx, se.ProjectID)
	if err != nil {
		return "", err
	}
	if proj == nil {
		return "", fmt.Errorf("project not found")
	}
	mergeOut, err := worktree.MergeBranch(proj.Path, se.Branch, mergeCommitMessage(se.Branch, se.Title))
	if err != nil {
		var conflictErr *worktree.MergeConflictError
		if errors.As(err, &conflictErr) {
			return "", fmt.Errorf("合并因 %d 个文件冲突已取消(主仓库未改动)。请在源代码管理面板协调这些文件后重试:\n  %s",
				len(conflictErr.Files), strings.Join(conflictErr.Files, "\n  "))
		}
		return "", err
	}
	var sb strings.Builder
	if strings.TrimSpace(mergeOut) == "" {
		sb.WriteString("✅ 合并完成(无新变更)")
	} else {
		sb.WriteString("✅ 合并成功\n" + mergeOut)
	}
	// 未提交改动不会进 merge:统计后提示用户去源代码管理面板提交。
	if se.WorktreePath != "" {
		if files, _ := worktree.StatusFiles(se.WorktreePath); len(files) > 0 {
			seen := map[string]bool{}
			for _, f := range files {
				seen[f.Path] = true
			}
			sb.WriteString(fmt.Sprintf("\n\n⚠️ worktree 中还有 %d 个未提交改动未合并,请在源代码管理面板提交后再合并。", len(seen)))
		}
	}
	return sb.String(), nil
}

// mergeCommitMessage 组合并到主仓库时用的提交信息:优先用 harness 生成的会话标题
// (AI 对本次工作的总结,经 session/list 取得)作主题,标题为空时降级到分支名。
// 纯函数,便于单测。
func mergeCommitMessage(branch, title string) string {
	t := strings.TrimSpace(title)
	if t == "" {
		t = "session 改动"
	}
	return "Merge " + branch + ": " + t
}

// aiCommitPrompt 是「AI 提交」发给当前 session 的指令(架构 A:复用 session,上下文最完整)。
// 让 agent 自己审视改动、生成 Conventional Commits 信息并提交。纯函数,便于单测。
func aiCommitPrompt() string {
	return "请帮我提交当前工作目录的未提交改动:\n" +
		"1. 先运行 git status 与 git diff 了解当前有哪些改动;\n" +
		"2. 基于改动内容,生成一条符合 Conventional Commits 规范的提交信息" +
		"(格式「类型: 简述」,如 feat: / fix: / refactor: / docs:,必要时补 body 说明动机);\n" +
		"3. 执行 git add -A 暂存全部改动,再 git commit 完成提交。\n" +
		"不要执行 push。提交完成后用一句话说明你提交了什么。"
}

// SessionAICommit 让当前 session 的 agent 自动提交未提交改动(AI 提交,架构 A)。
// 复用 SendMessage 发送一段指令:agent 自己审视改动、生成提交信息并提交。
// 复用现有 turn 生命周期 / 权限 UI / 流式渲染,提交作为一轮对话显示在聊天里(可审计)。
// 仅 idle 可用(busy 由 SendMessage 守卫);无改动时 agent 会自行说明。
func (s *ChatService) SessionAICommit(sessionID string) error {
	return s.SendMessage(sessionID, aiCommitPrompt(), nil)
}

// SessionDiff 返回该 session 的 git 变更摘要。
// 有 worktree 时展示分支相对主仓库的 diff --stat + commit log;
// 无 worktree 时展示工作目录(项目目录)的未提交改动。
func (s *ChatService) SessionDiff(sessionID string) (string, error) {
	if !s.hasSCM(sessionID) {
		return "", nil
	}
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", err
	}
	if se == nil {
		return "", fmt.Errorf("session not found: %s", sessionID)
	}
	proj, err := s.st.GetProject(s.ctx, se.ProjectID)
	if err != nil {
		return "", err
	}
	if proj == nil {
		return "", fmt.Errorf("project not found")
	}
	// 无 worktree:直接展示项目目录的工作区改动
	if se.WorktreePath == "" {
		dir, derr := s.scmDir(sessionID)
		if derr != nil {
			return "暂无变更", nil
		}
		changes, cerr := worktree.StatusFiles(dir)
		if cerr != nil || len(changes) == 0 {
			return "暂无变更", nil
		}
		var sb strings.Builder
		sb.WriteString("工作区改动:\n")
		for _, c := range changes {
			sb.WriteString(fmt.Sprintf("  %s %s\n", c.Status, c.Path))
		}
		return sb.String(), nil
	}
	// 有 worktree:展示分支相对主仓库的变更摘要
	stat, _ := worktree.DiffStat(proj.Path, se.Branch)
	log, _ := worktree.BranchLog(proj.Path, se.Branch)
	uncommitted, _ := worktree.UncommittedStat(se.WorktreePath)
	var sb strings.Builder
	if log != "" {
		sb.WriteString("提交:\n" + log + "\n\n")
	}
	if stat != "" {
		sb.WriteString("已提交变更:\n" + stat + "\n")
	}
	if uncommitted != "" {
		sb.WriteString("\n未提交改动:\n" + uncommitted)
	}
	if sb.Len() == 0 {
		return "暂无变更", nil
	}
	return sb.String(), nil
}

// SessionChanges 返回该 session 的文件级变更列表(VS Code 风格:逐文件 + M/A/D/U 状态)。
func (s *ChatService) SessionChanges(sessionID string) ([]worktree.FileChange, error) {
	if !s.hasSCM(sessionID) {
		return nil, nil
	}
	dir, err := s.scmDir(sessionID)
	if err != nil {
		return nil, nil
	}
	return worktree.StatusFiles(dir)
}

// SessionStage 暂存文件;paths 为空暂存全部(供源码管理面板,参考 VS Code SCM)。
// turn 进行中拒绝,避免与 opencode 写文件竞争 git index(§E 并发守卫)。
func (s *ChatService) SessionStage(sessionID string, paths []string) error {
	if s.isBusy(sessionID) {
		return errSCMBusy
	}
	wt, err := s.scmDir(sessionID)
	if err != nil {
		return err
	}
	return worktree.Stage(wt, paths...)
}

// SessionUnstage 取消暂存文件;paths 为空取消全部。
func (s *ChatService) SessionUnstage(sessionID string, paths []string) error {
	if s.isBusy(sessionID) {
		return errSCMBusy
	}
	wt, err := s.scmDir(sessionID)
	if err != nil {
		return err
	}
	return worktree.Unstage(wt, paths...)
}

// SessionDiscard 丢弃工作区改动(已跟踪还原 / 未跟踪删除)。只作用于工作区,不动暂存区。
func (s *ChatService) SessionDiscard(sessionID string, paths []string) error {
	if s.isBusy(sessionID) {
		return errSCMBusy
	}
	wt, err := s.scmDir(sessionID)
	if err != nil {
		return err
	}
	return worktree.Discard(wt, paths...)
}

// SessionCommit 提交已暂存的改动(只 commit index,不自动 add)。
// 提交是源代码管理面板的职责;MergeSession 只合并已提交内容,不再越权提交。
func (s *ChatService) SessionCommit(sessionID, message string) error {
	if s.isBusy(sessionID) {
		return errSCMBusy
	}
	wt, err := s.scmDir(sessionID)
	if err != nil {
		return err
	}
	return worktree.Commit(wt, message)
}

// SessionFileDiff 返回单个文件的 unified diff(staged=true:已暂存相对 HEAD;否则工作区相对 index,
// 未跟踪文件展示为纯新增)。供源代码管理面板点击文件查看改动(VSCode SCM 风格)。
func (s *ChatService) SessionFileDiff(sessionID, path string, staged bool) (string, error) {
	wt, err := s.scmDir(sessionID)
	if err != nil {
		return "", err
	}
	return worktree.FileDiff(wt, path, staged)
}

// --- 文件浏览 / 管理(右侧「文件」面板)---

// cwdOf 返回 session 的有效工作目录:git 项目用 worktree,否则用项目目录。
// 与 worktreeOf 不同:worktreeOf 仅返回 worktree(非 git 报错),cwdOf 对任意 session 都有值。
func (s *ChatService) cwdOf(sessionID string) (string, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", err
	}
	if se == nil {
		return "", fmt.Errorf("session not found: %s", sessionID)
	}
	proj, err := s.st.GetProject(s.ctx, se.ProjectID)
	if err != nil {
		return "", err
	}
	if proj == nil {
		return "", fmt.Errorf("project not found")
	}
	if se.WorktreePath != "" {
		return se.WorktreePath, nil
	}
	return proj.Path, nil
}

// scmDir 返回 session 的 git 操作目录(跟 VS Code 对齐:SCM 可见性 = 该目录是否为 git repo)。
// 有 worktree → worktree 路径;无 worktree + proj.Path 是 git repo → proj.Path;
// 两者都不是 → 报错(调用方应先用 hasSCM 判定再调)。
func (s *ChatService) scmDir(sessionID string) (string, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", err
	}
	if se == nil {
		return "", fmt.Errorf("session not found: %s", sessionID)
	}
	proj, err := s.st.GetProject(s.ctx, se.ProjectID)
	if err != nil {
		return "", err
	}
	if proj == nil {
		return "", fmt.Errorf("project not found")
	}
	if se.WorktreePath != "" {
		return se.WorktreePath, nil
	}
	if worktree.IsRepo(proj.Path) {
		return proj.Path, nil
	}
	return "", fmt.Errorf("session 无 git 上下文(非 git 项目)")
}

// hasSCM 报告 session 是否应显示「源代码管理」面板(对齐 orca / VS Code 的 repo-kind 判定)。
func (s *ChatService) hasSCM(sessionID string) bool {
	dir, err := s.scmDir(sessionID)
	if err != nil {
		return false
	}
	return worktree.IsRepo(dir)
}

// SessionListDir 列出 session 工作目录下 rel(相对路径)的直接子项。
// rel 为空表示根。路径钉在 cwd,防越界;git 仓库尊重 .gitignore。
func (s *ChatService) SessionListDir(sessionID, rel string) ([]fsview.FileNode, error) {
	root, err := s.cwdOf(sessionID)
	if err != nil {
		return nil, err
	}
	return fsview.ListDir(root, rel)
}

// SessionReadFile 读取 session 工作目录下 rel 的文本内容(预览用)。
func (s *ChatService) SessionReadFile(sessionID, rel string) (string, error) {
	root, err := s.cwdOf(sessionID)
	if err != nil {
		return "", err
	}
	return fsview.ReadFile(root, rel)
}

// SessionCreateFile 在 session 工作目录下新建文件(含内容)。
func (s *ChatService) SessionCreateFile(sessionID, rel, content string) error {
	root, err := s.cwdOf(sessionID)
	if err != nil {
		return err
	}
	return fsview.CreateFile(root, rel, content)
}

// SessionCreateDir 在 session 工作目录下新建目录。
func (s *ChatService) SessionCreateDir(sessionID, rel string) error {
	root, err := s.cwdOf(sessionID)
	if err != nil {
		return err
	}
	return fsview.CreateDir(root, rel)
}

// SessionDeletePath 删除 session 工作目录下的文件或目录(递归)。
func (s *ChatService) SessionDeletePath(sessionID, rel string) error {
	root, err := s.cwdOf(sessionID)
	if err != nil {
		return err
	}
	return fsview.DeletePath(root, rel)
}

// SessionRenamePath 把 session 工作目录下的 rel 改名为 newName(叶子名)。
// 返回新的相对路径。
func (s *ChatService) SessionRenamePath(sessionID, rel, newName string) (string, error) {
	root, err := s.cwdOf(sessionID)
	if err != nil {
		return "", err
	}
	return fsview.RenamePath(root, rel, newName)
}

// OpenSession 打开已有 session:B 方案,异步 spawn harness(NewSession/LoadSession),
// 完成后通过 event 推完整 config_option(model/mode/effort)+ started。
// 立即返回(不阻塞前端加载历史,历史从 DB 读,独立于 harness)。ensureLive 的 spawnMu
// 串行化保证用户在 spawn 完成前发消息不会双 spawn。
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
	go func() {
		if err := s.ensureLive(sessionID); err != nil {
			slog.Warn("open session spawn failed", "session", sessionID, "err", err)
		}
	}()
	return nil
}

// ensureLive 确保 session 的 harness 已启动且仍存活:未活跃则 spawn;活跃但进程已死
// (预热后空闲断连 / 崩溃)则先拆掉再 spawn(用 LoadSession resume),不把 broken pipe 抛给用户。
// 开 session 时冷缓存会预热 spawn 保持连接等首条消息(见 maybeWarmSession)。
//
// spawn 段持 spawnMu 串行化:杜绝「预热 goroutine 与首条消息并发各 spawn 一个 harness」
// (二者都不持 sendMu)——后到者拿到锁后重检 active,已活跃则直接复用。
func (s *ChatService) ensureLive(sessionID string) error {
	s.mu.RLock()
	ls, ok := s.active[sessionID]
	s.mu.RUnlock()
	if ok {
		if ls.chat.IsAlive() {
			return nil
		}
		// 进程已退出(预热后空闲断连 / 崩溃):拆掉死连接,下面重 spawn。
		slog.Info("active session harness dead, respawning", "session", sessionID)
		s.teardownLive(sessionID, ls)
	}
	// 串行化 spawn:与并发的 warm / 另一条消息互斥,杜绝双 spawn。
	s.spawnMu.Lock()
	defer s.spawnMu.Unlock()
	// 重检:等锁期间可能已有另一路 spawn 完成。
	s.mu.RLock()
	ls, ok = s.active[sessionID]
	s.mu.RUnlock()
	if ok && ls.chat.IsAlive() {
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
	// 按 session 选择的 harness 解析启动命令(§2.1 harness 适配层)。
	cmdStr := harness.Command(se.Harness)
	// model 注入:opencode 走 cwd 写 opencode.json(§3.5);其它 harness 的 model 注入方式
	// 待各自适配,暂不写(留空让 NewRunner.WriteModelConfig 跳过,各 harness 用自身全局配置)。
	model := se.Model
	if !harness.IsOpenCode(se.Harness) {
		model = ""
	}
	runner := acp.NewRunner(cmdStr, nil, model)
	cwd := proj.Path
	if se.WorktreePath != "" {
		cwd = se.WorktreePath // 每个 session 独占 worktree(并行隔离)
	}

	ls := &liveSession{proj: proj, tools: map[string]*toolAccum{}, lastActivity: time.Now().UnixMilli()}
	onEvent := func(e acp.SessionEvent) {
		s.handleEvent(ls, se.ID, e)
	}
	onPermission := func(p acp.PermissionPrompt) {
		p.SessionID = se.ID // 对齐到 db sessionID(便于前端按 session 过滤)
		s.emit(EventPermission, p)
	}

	// harness 生命周期挂到 s.ctx(随应用退出);运行期不独立 cancel ——
	// 关闭 session 走 Close()(kill 进程组),停止单轮走 turnCancel(干净 session/cancel)。
	var (
		chat *acp.ChatSession
		err  error
	)
	if resume {
		chat, err = runner.LoadChatSession(s.ctx, cwd, acpSessionID, onEvent, onPermission)
	} else {
		chat, err = runner.NewChatSession(s.ctx, cwd, onEvent, onPermission)
	}
	if err != nil {
		return fmt.Errorf("start acp session: %w", err)
	}
	ls.chat = chat // chatConn 接口(chat *acp.ChatSession 满足)
	// 加载项目级权限记忆到 handler:按 project 存、跨 harness 共享,命中即对后续所有
	// RequestPermission(含命令执行、外部目录)自动放行(§3.4)。
	chat.Handler.SetProjectAllowExternal(proj.AllowExternal)

	s.mu.Lock()
	s.active[se.ID] = ls
	s.mu.Unlock()

	// 新建时记录 opencode 返回的 session id(供下次 resume)。
	if !resume {
		_ = s.st.UpdateSessionACP(s.ctx, se.ID, string(chat.SessionID), se.Title)
	}
	s.emitStatus(se.ID, "started", "")
	// 推送 agent 自报的 config options(model/mode/effort),前端据此渲染下拉。
	if opts := chat.FlatConfigOptions(); len(opts) > 0 {
		s.emit(EventUpdate, acp.SessionEvent{SessionID: se.ID, Kind: "config_option", ConfigOptions: opts})
	}
	slog.Info("session live", "id", se.ID, "resume", resume, "cwd", proj.Path, "model", se.Model)
	return nil
}

// CloseSession 关闭活跃 ACP session(保留 db 记录,可再次 Open)。
// busy(turn 进行中)时拒绝:idle reaper 跳过、用户需先 Stop。避免杀掉正在输出的 turn。
func (s *ChatService) CloseSession(sessionID string) error {
	s.mu.Lock()
	ls, ok := s.active[sessionID]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	ls.mu.Lock()
	busy := ls.busy
	ls.mu.Unlock()
	if busy {
		s.mu.Unlock()
		return errSessionBusy
	}
	delete(s.active, sessionID)
	s.mu.Unlock()
	ls.chat.Close()
	s.reapIfIdle()
	s.emitStatus(sessionID, "closed", "")
	return nil
}

// errSessionBusy turn 进行中关闭/操作时返回(idle reaper 静默跳过,用户需先停)。
var errSessionBusy = errors.New("对话进行中,请等回合结束再关闭")

// reapIfIdle 仅当无活跃 session 时 reap 逃逸 opencode(多 session 并发安全,§3.2)。
func (s *ChatService) reapIfIdle() {
	s.mu.RLock()
	n := len(s.active)
	s.mu.RUnlock()
	if n == 0 {
		acp.ReapStrayOpencode()
	}
}

// startIdleReaper 启动 idle reaper 后台 goroutine:周期扫描活跃 session,
// 超 idleTimeout 未活动且非 busy 的自动 CloseSession,释放 harness 资源(B 方案)。
// ServiceShutdown 经 reaperStop 优雅停。busy 双重检查(reaper 收集 + CloseSession)防误杀 turn。
func (s *ChatService) startIdleReaper() {
	s.reaperStop = make(chan struct{})
	s.reaperDone = make(chan struct{})
	go s.idleReaper()
}

// idleReaper 后台循环。扫描间隔 = idleTimeout/5(生产 5min→1min,测试可注入短 timeout 加速),
// 上限 1 分钟(防 idleTimeout 设超大时扫太频繁)。无下限:测试用 100ms→20ms 即可快速回收。
func (s *ChatService) idleReaper() {
	defer close(s.reaperDone)
	interval := s.idleTimeout / 5
	if interval > time.Minute {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.reaperStop:
			return
		case <-ticker.C:
			s.closeIdle()
		}
	}
}

// closeIdle 收集超 idleTimeout 且非 busy 的 session,释放 RLock 后逐个 CloseSession
// (自身拿 Lock,与 reaper 的 RLock 不重叠,无死锁)。busy 的跳过(进行中 turn 不杀)。
func (s *ChatService) closeIdle() {
	var toClose []string
	now := time.Now().UnixMilli()
	limit := s.idleTimeout.Milliseconds()
	s.mu.RLock()
	for id, ls := range s.active {
		ls.mu.Lock()
		busy := ls.busy
		act := ls.lastActivity
		ls.mu.Unlock()
		if busy {
			continue
		}
		if now-act > limit {
			toClose = append(toClose, id)
		}
	}
	s.mu.RUnlock()
	for _, id := range toClose {
		slog.Info("session idle timeout, closing", "session", id)
		if err := s.CloseSession(id); err != nil {
			slog.Debug("idle close skipped", "session", id, "err", err)
		}
	}
}

// teardownLive 拆掉一个活跃 session 的 harness:从 active 移除 + Close(杀进程组+收尸)
// + 无其它活跃时 reap 逃逸。任何「Prompt 异常返回」(peer 断 / 静默或绝对超时 / 其它错)
// 都应调它:harness 可能已死或不可信,下条消息 ensureLive 会用 LoadSession(resume)重连(§1.4 / §5.4 #16)。
// 用户主动取消(StopSession/InterruptAndSend)【不】调 —— 那是干净停止,连接保持可用(§5.4 #13)。
func (s *ChatService) teardownLive(sessionID string, ls *liveSession) {
	s.mu.Lock()
	delete(s.active, sessionID)
	s.mu.Unlock()
	ls.chat.Close()
	s.reapIfIdle()
}

// LoadMessages 取某 session 的全部历史消息(打开 session 时渲染)。
func (s *ChatService) LoadMessages(sessionID string) ([]store.Message, error) {
	return s.st.ListMessages(s.ctx, sessionID)
}

// LoadMessagesPage 分页取历史消息(beforeSeq<=0 取最新一页)。返回 limit+1 条:
// 前端用 len > limit 判断 hasMore,多出的那条 slice 掉。首次打开 session 用此方法做懒加载。
func (s *ChatService) LoadMessagesPage(sessionID string, beforeSeq int64, limit int) ([]store.Message, error) {
	return s.st.ListMessagesBefore(s.ctx, sessionID, beforeSeq, limit)
}

// ListUserMessages 取某 session 全部用户消息文本(按时间升序,无长度限制)。
// 供输入框「上下键翻历史」:翻遍该 session 所有发过的消息。
func (s *ChatService) ListUserMessages(sessionID string) ([]string, error) {
	return s.st.ListUserMessages(s.ctx, sessionID)
}

// --- Messaging ---

// SendMessage 发送用户消息并驱动 opencode 回复(Prompt,§1.3)。
// 仅在 idle 时可用:协议规定一个 session 同时只允许一个 Prompt(§5.4 调研结论)。
// turn 进行中时前端应把消息入前端队列(不调本方法);busy 守卫兜底防竞态。
func (s *ChatService) SendMessage(sessionID, text string, attachments []acp.Attachment) error {
	if err := s.ensureLive(sessionID); err != nil {
		return err
	}
	s.mu.RLock()
	ls := s.active[sessionID]
	s.mu.RUnlock()
	if ls == nil {
		return fmt.Errorf("session not active: %s", sessionID)
	}
	ls.sendMu.Lock()
	defer ls.sendMu.Unlock()
	if ls.busy {
		return fmt.Errorf("session busy: 一轮对话进行中,请等待或打断")
	}
	if err := s.startTurn(ls, sessionID, text, attachments); err != nil {
		return err
	}
	return nil
}

// startTurn 同步置 busy + 起后台 runPrompt。调用方须持 ls.sendMu —— 保证 busy 置位与
// runPrompt 启动原子,杜绝两轮 Prompt 重叠。负责:resetBuffers → 持久化用户消息 →
// 推 user 事件 → 推 prompting。
func (s *ChatService) startTurn(ls *liveSession, sessionID, text string, attachments []acp.Attachment) error {
	ls.resetBuffers()
	ls.mu.Lock()
	ls.busy = true
	ls.mu.Unlock()

	// 用户消息是本轮真相来源,先落库。失败必须中止本轮并把错误暴露给用户 ——
	// 否则 UI 已显示用户消息但 DB 没有,重开会话就丢了(数据一致性)。
	if _, err := s.st.AppendMessage(s.ctx, sessionID, "user", "", text, ""); err != nil {
		ls.mu.Lock()
		ls.busy = false
		ls.mu.Unlock()
		detail := "保存消息失败:" + err.Error()
		s.emitStatus(sessionID, "error", detail)
		return fmt.Errorf("%s", detail)
	}
	// 用户发消息的瞬间刷新 prompted_at(侧栏主排序键),配合前端 prompting 时 refresh,
	// 让该 session 即时跳顶;后台活动(usage_update/工具返回)不动它(§1.4 排序策略)。
	if err := s.st.TouchPrompted(s.ctx, sessionID); err != nil {
		slog.Warn("touch prompted_at", "err", err)
	}
	s.maybeAutoTitle(sessionID, text)
	s.emit(EventUpdate, acp.SessionEvent{SessionID: sessionID, Kind: "user_message_chunk", Text: text})
	s.emitStatus(sessionID, "prompting", "")
	go s.runPrompt(ls, sessionID, text, attachments)
	return nil
}

// InterruptAndSend 打断当前 turn 并立即发送新消息(前端队列面板「立即发送」按钮)。
// 协议无 queue:turn 进行中发新消息的唯一正确做法 = session/cancel 当前 turn →
// 等其落定 → 发新 prompt。本方法把这几步原子化(sendMu 保护):
//   - 置 suppressIdle:本轮 runPrompt 结束时不发 idle(否则前端 auto-continue 会误续发)
//   - turnCancel:干净 session/cancel(SDK 自动发,非杀进程,连接保持可用)
//   - <-turnDone:等本轮落定(persist 仍执行,partial 回复不丢)
//   - startTurn:发新消息(发 prompting)
//
// 当前空闲时等价于 SendMessage。其余排队消息由前端持有,本方法不动(用户选「保留其余」)。
func (s *ChatService) InterruptAndSend(sessionID, text string, attachments []acp.Attachment) error {
	if err := s.ensureLive(sessionID); err != nil {
		return err
	}
	s.mu.RLock()
	ls := s.active[sessionID]
	s.mu.RUnlock()
	if ls == nil {
		return fmt.Errorf("session not active: %s", sessionID)
	}
	// busy 时需 cancel 旧 turn 并等其完全落定(含 emit)再发新消息。等待期间必须释放
	// sendMu —— 旧 turn 收尾段也持 sendMu(见 runPrompt),持锁死等 turnDone 会死锁。
	// 故:释放→cancel→等落定→重拿 sendMu 发新消息。!busy 时直接发(sendMu 已保证旧
	// emit 落定:runPrompt 在 sendMu 内清 busy,故拿到 sendMu 且 busy=false ⇒ 收尾已结束、
	// emit 已发,不会与新 prompting 竞态)。
	ls.sendMu.Lock()
	if !ls.busy {
		defer ls.sendMu.Unlock()
		return s.startTurn(ls, sessionID, text, attachments)
	}
	ls.mu.Lock()
	ls.suppressIdle = true
	tc := ls.turnCancel
	done := ls.turnDone
	ls.mu.Unlock()
	ls.sendMu.Unlock()

	if tc != nil {
		tc()
	}
	if done != nil {
		<-done
	}

	// 重新拿 sendMu 发新消息:旧 turn 已落定。若旧 turn 失败已 teardown(active 无此
	// session),重连拿新 ls(§5.4 #16,LoadSession resume)。
	ls.sendMu.Lock()
	defer ls.sendMu.Unlock()
	if !s.isActive(sessionID) {
		if err := s.ensureLive(sessionID); err != nil {
			return err
		}
		s.mu.RLock()
		ls = s.active[sessionID]
		s.mu.RUnlock()
		if ls == nil {
			return fmt.Errorf("session not active: %s", sessionID)
		}
	}
	return s.startTurn(ls, sessionID, text, attachments)
}

// SendAndWaitSync 同步发送并等待回复(供驱动/测试用;GUI 用异步 SendMessage)。
// 返回 agent 文本与错误。任何失败都拆连接:调用方重试时 ensureLive 会用 LoadSession(resume)重连(§5.4 #16)。
func (s *ChatService) SendAndWaitSync(sessionID, text string, attachments []acp.Attachment) (string, error) {
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
	stopReason, err := ls.chat.Prompt(ctx, text, attachments, 300*time.Second)
	ls.mu.Lock()
	if ls.thought.Len() > 0 {
		ls.segments = append(ls.segments, segEntry{"thought", ls.thought.String()})
	}
	if ls.agentBuf.Len() > 0 {
		ls.segments = append(ls.segments, segEntry{"agent", ls.agentBuf.String()})
	}
	segments := ls.segments
	tools := make([]*toolAccum, 0, len(ls.tools))
	for _, t := range ls.tools {
		tools = append(tools, t)
	}
	ls.mu.Unlock()
	s.persistTurn(sessionID, segments, tools)
	agentText := ""
	for _, seg := range segments {
		if seg.role == "agent" {
			agentText = seg.content
		}
	}
	if err != nil {
		// 与 runPrompt 一致:任何失败都拆连接(§5.4 #16)。返回原 err 供调用方判断。
		reason := "error"
		if acp.IsPeerDisconnected(err) {
			reason = "peer-disconnected"
		}
		s.teardownLive(sessionID, ls)
		slog.Error("prompt failed (sync)", "session", sessionID, "err", err, "reason", reason)
		s.emitStatus(sessionID, "error", "agent 连接已重置,下条消息将自动重连")
		return agentText, err
	}
	s.emitStatus(sessionID, "idle", "stopReason="+string(stopReason))
	s.syncSessionTitle(ls, sessionID)
	return agentText, nil
}

// runPrompt 在后台执行一轮 Prompt(可能很久):建 turn 上下文 → Prompt(同步)→
// 持久化累积回复 → 推 status。turn 上下文取消时 SDK 自动发 session/cancel(干净取消,
// 非杀进程,连接保持可用 —— 见 SDK client_gen.go Prompt + TestPromptCancellationSendsCancelAndAllowsNewSession)。
//
// 取消判定:turnCtx.Err()!=nil = 被 StopSession/InterruptAndSend 取消(干净停止,推 idle),
// 与 peer disconnected(harness 崩,拆连接重连)及其它错误(idle 超时等,推 error)区分。
// suppressIdle(InterruptAndSend 置位)时本轮不发任何 status:打断后由新轮发 prompting,
// 避免前端看到瞬态 idle 触发 auto-continue 误续发。
func (s *ChatService) runPrompt(ls *liveSession, sessionID, text string, attachments []acp.Attachment) {
	turnCtx, turnCancel := context.WithCancel(s.ctx)
	done := make(chan struct{})
	ls.mu.Lock()
	ls.turnCancel = turnCancel
	ls.turnDone = done
	ls.mu.Unlock()
	defer func() {
		turnCancel()
		close(done)
	}()

	stopReason, err := ls.chat.Prompt(turnCtx, text, attachments, 300*time.Second)

	// 收尾段持 sendMu:与 startTurn/SendMessage 互斥,杜绝「busy 已清、emit 未发」窗口被
	// 并发 send 抢占 → 旧 emit 延迟覆盖新 prompting(§5.4 覆盖竞态)。defer 早于 close(done)
	// (LIFO)执行 —— InterruptAndSend 等 turnDone 时 sendMu 已释放,不会死锁。
	ls.sendMu.Lock()
	defer ls.sendMu.Unlock()
	ls.mu.Lock()
	// flush 当前段残留到 segments(thought / agent 分别 flush,顺序保持时序)。
	if ls.thought.Len() > 0 {
		ls.segments = append(ls.segments, segEntry{"thought", ls.thought.String()})
	}
	if ls.agentBuf.Len() > 0 {
		ls.segments = append(ls.segments, segEntry{"agent", ls.agentBuf.String()})
	}
	segments := ls.segments
	tools := make([]*toolAccum, 0, len(ls.tools))
	for _, t := range ls.tools {
		tools = append(tools, t)
	}
	suppressed := ls.suppressIdle
	ls.suppressIdle = false
	// emit 前清 busy:保证前端收到 idle 时 busy 已 false,drain→SendMessage 不会撞上 stale busy。
	ls.busy = false
	ls.lastActivity = time.Now().UnixMilli() // turn 结束(含取消/失败),重置 idle 计时
	ls.turnCancel = nil
	ls.turnDone = nil
	ls.mu.Unlock()

	cancelled := err != nil && turnCtx.Err() != nil
	// 持久化已收到的部分回复(取消/失败也不丢)。
	s.persistTurn(sessionID, segments, tools)

	if suppressed {
		return // 打断:不发 status,新轮 startTurn 会发 prompting
	}
	if err != nil {
		if cancelled {
			s.emitStatus(sessionID, "idle", "cancelled")
			return
		}
		// 非用户取消的失败(peer 断 / 静默或绝对超时 / 其它):harness 可能已死或不可信,
		// 一律拆连接,下条消息 ensureLive 用 LoadSession(resume) 重连(§5.4 #16)。
		reason := "error"
		if acp.IsPeerDisconnected(err) {
			reason = "peer-disconnected"
		}
		s.teardownLive(sessionID, ls)
		slog.Error("prompt failed", "session", sessionID, "err", err, "reason", reason)
		// §4.4:不把裸 error(协议 JSON/OS 错)抛给用户,统一人话提示。
		s.emitStatus(sessionID, "error", "agent 连接已重置,下条消息将自动重连")
		return
	}
	// 取 harness 生成的权威标题覆盖兜底标题(§5.4 #14)。
	s.syncSessionTitle(ls, sessionID)
	s.emitStatus(sessionID, "idle", "stopReason="+string(stopReason))
}

// persistTurn 把本轮各段(thinking/agent message,时序) + 工具调用写库。
// 多 tool call 交替时一轮有多个 thought/agent 段,逐段独立写入(而非合并),
// 历史 reload 时段与实时流式一一对应。
func (s *ChatService) persistTurn(sessionID string, segments []segEntry, tools []*toolAccum) {
	if s.persistHook != nil {
		s.persistHook() // 测试钩子:在此阻塞放大收尾窗口(生产 nil,直通)
	}
	for _, seg := range segments {
		if strings.TrimSpace(seg.content) == "" {
			continue
		}
		kind := "agent_message_chunk"
		if seg.role == "thought" {
			kind = "agent_thought_chunk"
		}
		if _, err := s.st.AppendMessage(s.ctx, sessionID, seg.role, kind, seg.content, ""); err != nil {
			slog.Warn("persist "+seg.role, "err", err)
		}
	}
	for _, t := range tools {
		body, _ := json.Marshal(t)
		if _, err := s.st.AppendMessage(s.ctx, sessionID, "tool", "tool_call", string(body), t.ID); err != nil {
			slog.Warn("persist tool", "err", err)
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
		// 段边界:上一个 chunk 类型不是 agent message → flush 上一段的 buffer(thought/tool)。
		if ls.lastChunkKind != "agent" {
			ls.flushCurrentSegment()
		}
		ls.lastChunkKind = "agent"
		ls.agentBuf.WriteString(e.Text)
		e.Text = ls.agentBuf.String()
	case "agent_thought_chunk":
		if ls.lastChunkKind != "thought" {
			ls.flushCurrentSegment()
		}
		ls.lastChunkKind = "thought"
		ls.thought.WriteString(e.Text)
		e.Text = ls.thought.String()
	case "tool_call":
		ls.flushCurrentSegment() // tool 是硬边界:flush 当前 thinking/message 段
		ls.lastChunkKind = "tool"
		ls.tools[e.ToolCallID] = &toolAccum{ID: e.ToolCallID, Title: e.ToolTitle, Status: e.ToolStatus, Kind: e.ToolKind, RawInput: e.RawInput}
	case "tool_call_update":
		if t, ok := ls.tools[e.ToolCallID]; ok {
			if e.ToolTitle != "" {
				t.Title = e.ToolTitle
			}
			if e.ToolStatus != "" {
				t.Status = e.ToolStatus
			}
			if e.ToolKind != "" {
				t.Kind = e.ToolKind
			}
			if e.RawOutput != nil {
				t.RawOutput = e.RawOutput
			}
		} else {
			ls.tools[e.ToolCallID] = &toolAccum{ID: e.ToolCallID, Title: e.ToolTitle, Status: e.ToolStatus, Kind: e.ToolKind, RawOutput: e.RawOutput}
		}
	}
	ls.mu.Unlock()
	if e.Kind == "session_info" && e.Title != "" {
		// harness 经 session_info_update 推送的会话标题(更优,覆盖兜底标题)。
		if err := s.st.UpdateSessionTitle(s.ctx, sessionID, e.Title); err == nil {
			s.emitSessionMeta(sessionID, e.Title)
		}
	}
	if e.Kind == "usage_update" {
		// 回写 token 用量快照,使重开会话能恢复占比(§1.6);cost 可能为 nil。
		cost := 0.0
		if e.Cost != nil {
			cost = *e.Cost
		}
		if err := s.st.UpdateSessionUsage(s.ctx, sessionID, e.Used, e.Size, cost); err != nil {
			slog.Warn("persist usage", "err", err)
		}
	}
	s.emit(EventUpdate, e)
}

// RespondPermission 用户在前端对某权限请求做出裁决(§3.4)。
// level: once(允许本次)/ session(本会话允许)/ project(本项目允许)/ deny(本次拒绝)。
// session/project 档令该 handler 后续「所有 RequestPermission」自动放行;project 档另写库(按 project 存、跨 harness 持久)。
func (s *ChatService) RespondPermission(sessionID, reqID, level string) error {
	s.mu.RLock()
	ls, ok := s.active[sessionID]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not active")
	}
	if level == "project" && ls.proj != nil {
		if err := s.st.SetProjectAllowExternal(s.ctx, ls.proj.ID, true); err != nil {
			slog.Warn("persist project allow-external", "err", err)
		}
	}
	if !ls.chat.RespondPermission(reqID, level) {
		return fmt.Errorf("no pending permission: %s", reqID)
	}
	return nil
}

// StopSession 取消正在进行的 Prompt(用户点「停止」):发干净 session/cancel(非杀进程),
// harness 与连接保持可用。runPrompt 在 Prompt 返回后推 idle/cancelled,前端据此切回可发送态。
func (s *ChatService) StopSession(sessionID string) error {
	s.mu.RLock()
	ls, ok := s.active[sessionID]
	s.mu.RUnlock()
	if !ok {
		return nil
	}
	ls.mu.Lock()
	tc := ls.turnCancel
	ls.mu.Unlock()
	if tc != nil {
		tc()
	} else {
		// 无在跑 turn(竞态/重复点):直接推 idle 兜底,避免前端卡在 prompting。
		s.emitStatus(sessionID, "idle", "")
	}
	return nil
}

// GetSessionConfigOptions 返回当前 session 的 config options(给前端渲染下拉:model/mode/effort)。
// B 方案:OpenSession 即异步 spawn,session 始终活跃 → 直接取 live 真相。
func (s *ChatService) GetSessionConfigOptions(sessionID string) ([]acp.ConfigOption, error) {
	s.mu.RLock()
	ls, ok := s.active[sessionID]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("session not active: %s", sessionID)
	}
	return ls.chat.FlatConfigOptions(), nil
}

// SetSessionConfigOption 切换 session 的某个 config option(model/mode/effort),热切、即时生效。
// B 方案:session 始终活跃,经 session/set_config_option 热切并推送 live configOptions。
func (s *ChatService) SetSessionConfigOption(sessionID, configId, value string) error {
	s.mu.RLock()
	ls := s.active[sessionID]
	s.mu.RUnlock()
	if ls == nil {
		return fmt.Errorf("session not active: %s", sessionID)
	}
	if err := ls.chat.SetConfigOption(s.ctx, configId, value); err != nil {
		return err
	}
	s.emit(EventUpdate, acp.SessionEvent{SessionID: sessionID, Kind: "config_option", ConfigOptions: ls.chat.FlatConfigOptions()})
	return nil
}

func (s *ChatService) isActive(sessionID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.active[sessionID]
	return ok
}

// isBusy 报告 session 是否正处在一轮 Prompt 中(未活跃的 session 视为非 busy)。
// 源代码管理的写操作在 turn 进行中应拒绝,避免与 opencode 写文件竞争 git index。
func (s *ChatService) isBusy(sessionID string) bool {
	s.mu.RLock()
	ls := s.active[sessionID]
	s.mu.RUnlock()
	if ls == nil {
		return false
	}
	ls.mu.Lock()
	defer ls.mu.Unlock()
	return ls.busy
}

// errSCMBusy turn 进行中操作源代码管理时返回。
var errSCMBusy = errors.New("对话进行中,请等回合结束再操作源代码管理")

// --- 配置查询(前端设置页用)---

// ListHarnesses 返回受支持的 harness 列表(前端「新建会话」选择器用,§2.1)。
func (s *ChatService) ListHarnesses() []harness.Harness {
	return harness.Supported
}

// IsGitProject 报告某项目目录是否为 git 仓库(前端据此决定「新建分支」开关是否可用,§1.4)。
func (s *ChatService) IsGitProject(projectID string) (bool, error) {
	proj, err := s.st.GetProject(s.ctx, projectID)
	if err != nil {
		return false, err
	}
	if proj == nil {
		return false, fmt.Errorf("project not found: %s", projectID)
	}
	return worktree.IsRepo(proj.Path), nil
}

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
