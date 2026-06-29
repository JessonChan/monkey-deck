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
	Prompt(ctx context.Context, message string, timeout time.Duration) (acp.StopReason, error)
	Close()
	RespondPermission(id, optionID string) bool
	// SessionTitle 经 ACP session/list 取 opencode 生成的权威标题(§5.4 #14)。
	SessionTitle(ctx context.Context) (string, error)
}

// liveSession 一个活跃的 ACP 对话(内存态,钉在某个 db session 上)。
type liveSession struct {
	chat chatConn
	proj *store.Project

	mu       sync.Mutex
	agentBuf strings.Builder // 累积本轮 agent_message_chunk 文本
	thought  strings.Builder // 累积本轮 agent_thought_chunk 文本
	tools    map[string]*toolAccum
	seq      int64 // 单调序号,流式事件防乱序(§4.3)

	// 单 turn 生命周期:ACP 协议无 queue,一个 session 同时只允许一个 Prompt
	// (session/prompt 是同步请求-响应,turn 未结束前不能发下一个,见 §5.4 调研结论)。
	// sendMu 串行化所有「发起 turn」入口(SendMessage / InterruptAndSend),
	// busy 在 sendMu 保护下同步置位,杜绝两轮 Prompt 重叠(治本并发隐患)。
	sendMu       sync.Mutex
	busy         bool               // 本轮 Prompt 进行中
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
	acp.SetPgidFile(filepath.Join(s.cfg.DataDir, "opencode-pgids.json")) // §3.2:限定 KillAll 范围到本应用残留
	acp.KillAllOpencode()                                                // 启动时清上轮残留 opencode(§3.2)
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
// 这是**瞬时兜底**:opencode 尚未生成标题前给侧栏一个可读标题。opencode 的权威标题
// 经 session/list 读取(见 runPrompt,§5.4 #14)—— opencode 实证不发 session_info_update
// 通知,但会在 turn 结束后通过 session/list 的 SessionInfo.Title 暴露它生成的标题。
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

// syncSessionTitle 经 session/list 取 opencode 为本 session 生成的权威标题,
// 若与当前存储标题不同则覆盖 + 推前端(§5.4 #14)。opencode 在 turn 结束后才暴露标题,
// 故在 runPrompt 成功后调用。失败(无标题/session/list 不可用)静默跳过,fallback 保留。
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

// CreateSession 新建 session。git 项目自动建独立 worktree+分支(并行隔离);否则用项目目录。
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
	// git 项目:为该 session 建独立 worktree+分支(并行隔离;失败降级用项目目录)。
	if worktree.IsRepo(proj.Path) {
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

// mergeCommitMessage 组合并到主仓库时用的提交信息:优先用 opencode 生成的会话标题
//(AI 对本次工作的总结,经 session/list 取得)作主题,标题为空时降级到分支名。
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
	return s.SendMessage(sessionID, aiCommitPrompt())
}

// SessionDiff 返回该 session 分支相对主仓库的变更摘要(diff --stat + commit log)。
// 供前端在分支标签旁展示"这个分支改了什么",让用户决定是否合并。
func (s *ChatService) SessionDiff(sessionID string) (string, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", err
	}
	if se == nil || se.Branch == "" {
		return "", nil
	}
	proj, err := s.st.GetProject(s.ctx, se.ProjectID)
	if err != nil {
		return "", err
	}
	if proj == nil {
		return "", nil
	}
	stat, _ := worktree.DiffStat(proj.Path, se.Branch)
	log, _ := worktree.BranchLog(proj.Path, se.Branch)
	// 也检查 worktree 里未提交的改动(agent 改了文件但没 commit 时 DiffStat 看不到)
	uncommitted := ""
	if se.WorktreePath != "" {
		uncommitted, _ = worktree.UncommittedStat(se.WorktreePath)
	}
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

// SessionChanges 返回该 session worktree 的文件级变更列表(VS Code 风格:逐文件 + M/A/D/U 状态)。
func (s *ChatService) SessionChanges(sessionID string) ([]worktree.FileChange, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil || se == nil || se.WorktreePath == "" {
		return nil, nil
	}
	return worktree.StatusFiles(se.WorktreePath)
}

// worktreeOf 返回 session 的 worktree 路径;无 worktree(非 git / 未建)返回错误。
func (s *ChatService) worktreeOf(sessionID string) (string, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return "", err
	}
	if se == nil || se.WorktreePath == "" {
		return "", fmt.Errorf("session 无独立 worktree(非 git 项目或未建)")
	}
	return se.WorktreePath, nil
}

// SessionStage 暂存文件;paths 为空暂存全部(供源码管理面板,参考 VS Code SCM)。
// turn 进行中拒绝,避免与 opencode 写文件竞争 git index(§E 并发守卫)。
func (s *ChatService) SessionStage(sessionID string, paths []string) error {
	if s.isBusy(sessionID) {
		return errSCMBusy
	}
	wt, err := s.worktreeOf(sessionID)
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
	wt, err := s.worktreeOf(sessionID)
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
	wt, err := s.worktreeOf(sessionID)
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
	wt, err := s.worktreeOf(sessionID)
	if err != nil {
		return err
	}
	return worktree.Commit(wt, message)
}

// SessionFileDiff 返回单个文件的 unified diff(staged=true:已暂存相对 HEAD;否则工作区相对 index,
// 未跟踪文件展示为纯新增)。供源代码管理面板点击文件查看改动(VSCode SCM 风格)。
func (s *ChatService) SessionFileDiff(sessionID, path string, staged bool) (string, error) {
	wt, err := s.worktreeOf(sessionID)
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
	cwd := proj.Path
	if se.WorktreePath != "" {
		cwd = se.WorktreePath // 每个 session 独占 worktree(并行隔离)
	}

	ls := &liveSession{proj: proj, tools: map[string]*toolAccum{}}
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

// LoadMessagesPage 分页取历史消息(beforeSeq<=0 取最新一页)。返回 limit+1 条:
// 前端用 len > limit 判断 hasMore,多出的那条 slice 掉。首次打开 session 用此方法做懒加载。
func (s *ChatService) LoadMessagesPage(sessionID string, beforeSeq int64, limit int) ([]store.Message, error) {
	return s.st.ListMessagesBefore(s.ctx, sessionID, beforeSeq, limit)
}

// --- Messaging ---

// SendMessage 发送用户消息并驱动 opencode 回复(Prompt,§1.3)。
// 仅在 idle 时可用:协议规定一个 session 同时只允许一个 Prompt(§5.4 调研结论)。
// turn 进行中时前端应把消息入前端队列(不调本方法);busy 守卫兜底防竞态。
func (s *ChatService) SendMessage(sessionID, text string) error {
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
	if err := s.startTurn(ls, sessionID, text); err != nil {
		return err
	}
	return nil
}

// startTurn 同步置 busy + 起后台 runPrompt。调用方须持 ls.sendMu —— 保证 busy 置位与
// runPrompt 启动原子,杜绝两轮 Prompt 重叠。负责:resetBuffers → 持久化用户消息 →
// 推 user 事件 → 推 prompting。
func (s *ChatService) startTurn(ls *liveSession, sessionID, text string) error {
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
	s.maybeAutoTitle(sessionID, text)
	s.emit(EventUpdate, acp.SessionEvent{SessionID: sessionID, Kind: "user_message_chunk", Text: text})
	s.emitStatus(sessionID, "prompting", "")
	go s.runPrompt(ls, sessionID, text)
	return nil
}

// InterruptAndSend 打断当前 turn 并立即发送新消息(前端队列面板「立即发送」按钮)。
// 协议无 queue:turn 进行中发新消息的唯一正确做法 = session/cancel 当前 turn →
// 等其落定 → 发新 prompt。本方法把这几步原子化(sendMu 保护):
//   - 置 suppressIdle:本轮 runPrompt 结束时不发 idle(否则前端 auto-continue 会误续发)
//   - turnCancel:干净 session/cancel(SDK 自动发,非杀进程,连接保持可用)
//   - <-turnDone:等本轮落定(persist 仍执行,partial 回复不丢)
//   - startTurn:发新消息(发 prompting)
// 当前空闲时等价于 SendMessage。其余排队消息由前端持有,本方法不动(用户选「保留其余」)。
func (s *ChatService) InterruptAndSend(sessionID, text string) error {
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
		ls.mu.Lock()
		ls.suppressIdle = true
		tc := ls.turnCancel
		done := ls.turnDone
		ls.mu.Unlock()
		if tc != nil {
			tc()
		}
		if done != nil {
			<-done
		}
	}
	return s.startTurn(ls, sessionID, text)
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
func (s *ChatService) runPrompt(ls *liveSession, sessionID, text string) {
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

	stopReason, err := ls.chat.Prompt(turnCtx, text, 300*time.Second)

	ls.mu.Lock()
	agentText := ls.agentBuf.String()
	thoughtText := ls.thought.String()
	tools := make([]*toolAccum, 0, len(ls.tools))
	for _, t := range ls.tools {
		tools = append(tools, t)
	}
	suppressed := ls.suppressIdle
	ls.suppressIdle = false
	// emit 前清 busy:保证前端收到 idle 时 busy 已 false,drain→SendMessage 不会撞上 stale busy。
	ls.busy = false
	ls.turnCancel = nil
	ls.turnDone = nil
	ls.mu.Unlock()

	cancelled := err != nil && turnCtx.Err() != nil
	// 持久化已收到的部分回复(取消/失败也不丢)。
	s.persistTurn(sessionID, agentText, thoughtText, tools)

	if suppressed {
		return // 打断:不发 status,新轮 startTurn 会发 prompting
	}
	if err != nil {
		if cancelled {
			s.emitStatus(sessionID, "idle", "cancelled")
			return
		}
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
		s.emitStatus(sessionID, "error", detail)
		return
	}
	// 取 opencode 生成的权威标题覆盖兜底标题(§5.4 #14)。
	s.syncSessionTitle(ls, sessionID)
	s.emitStatus(sessionID, "idle", "stopReason="+string(stopReason))
}

// persistTurn 把本轮累积的 agent 回复 + 工具调用写库。
// 顺序:thought → agent → tools。匹配实时流式渲染的心智模型(agent 边回复边调用工具,
// 历史 agent 文本在前、tool 卡片在后),避免历史恢复时 tool 卡片出现在 agent 回复之前。
func (s *ChatService) persistTurn(sessionID, agentText, thoughtText string, tools []*toolAccum) {
	if thoughtText != "" {
		if _, err := s.st.AppendMessage(s.ctx, sessionID, "thought", "agent_thought_chunk", thoughtText, ""); err != nil {
			slog.Warn("persist thought", "err", err)
		}
	}
	if strings.TrimSpace(agentText) != "" {
		if _, err := s.st.AppendMessage(s.ctx, sessionID, "agent", "agent_message_chunk", agentText, ""); err != nil {
			slog.Warn("persist agent", "err", err)
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
		ls.agentBuf.WriteString(e.Text)
		e.Text = ls.agentBuf.String() // 累积全文
	case "agent_thought_chunk":
		ls.thought.WriteString(e.Text)
		e.Text = ls.thought.String()
	case "tool_call":
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
		// opencode 发来的会话标题(更优,覆盖自动标题)。
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
