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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jessonchan/monkey-deck/internal/acp"
	"github.com/jessonchan/monkey-deck/internal/config"
	"github.com/jessonchan/monkey-deck/internal/fsview"
	"github.com/jessonchan/monkey-deck/internal/harness"
	"github.com/jessonchan/monkey-deck/internal/permissions"
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
	EventHarnesses   = "chat:harnesses"    // harness 发现/版本变更(前端据此重拉 ListHarnesses)
)

// StatusPayload 会话状态变更。
type StatusPayload struct {
	SessionID string `json:"sessionId"`
	Status    string `json:"status"` // started | prompting | idle | error | closed | readonly
	// Code 是稳定的机器错误码;前端按 code 经 i18n 翻译成人话提示(§4.4)。
	// 仅 error 状态填(如 ErrCodeHarnessDisconnected),其余状态留空。
	Code   string `json:"code,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// 错误码(前端按 code 经 i18n 翻译,见 locales 的 chat.error.*)。
const (
	// ErrCodeHarnessDisconnected:harness 崩溃/断连或 Prompt 失败,连接已重置,正在/将自动重连。
	ErrCodeHarnessDisconnected = "harness_disconnected"
	// ErrCodeHarnessEmptyTurn:Prompt 成功返回但零输出(通常 resume 后 session 状态损坏),按错误处理并重连。
	ErrCodeHarnessEmptyTurn = "harness_empty_turn"
	// ErrCodeHarnessReconnectFailed:断连后自动重连耗尽重试上限仍失败,需用户手动(发消息)触发再次尝试。
	ErrCodeHarnessReconnectFailed = "harness_reconnect_failed"
)

// 会话状态(会随 SessionEvent/StatusPayload 推前端)。
const (
	// statusReconnecting:harness 断连后正在后台自动重连(spawn 新 harness)。
	// 前端据此显示「重连中」提示;非 prompting,不阻塞用户输入(用户发消息会走 ensureLive,
	// 与重连循环的 ensureLive 经 spawnMu 串行化,不会双 spawn)。
	statusReconnecting = "reconnecting"
)

// reconnectCtl 管理一次自动重连的后台 goroutine 生命周期。
//   - stop:关闭即要求循环退出(CloseSession/DeleteSession/ServiceShutdown 用)。
//   - done:循环退出时关闭,供 stopReconnect 等待落定(确保 goroutine 不泄漏)。
type reconnectCtl struct {
	stop chan struct{}
	done chan struct{}
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

// isTerminalToolStatus 判断 tool status 是否终态(completed/failed)。
// 用于单调状态保护:终态后不接受回退到 in_progress/pending(§5.4 #10)。
func isTerminalToolStatus(status string) bool {
	return status == "completed" || status == "failed"
}

// chatConn 是 *acp.ChatSession 的最小行为接口,供单测注入 mock(AGENTS.md §5.1:
// ACP 行为靠接口注入 mock,单测不启真 harness)。*acp.ChatSession 满足此接口。
type chatConn interface {
	Prompt(ctx context.Context, message string, attachments []acp.Attachment) (acp.StopReason, error)
	Close()
	// IsAlive 报告 harness 进程是否存活(预热后空闲断连兜底:活跃但进程已死 → 拆掉重 spawn)。
	IsAlive() bool
	RespondPermission(id, optionID string) bool
	// SessionTitle 经 ACP session/list 拉 harness 生成的权威标题(§5.4 #14)。
	SessionTitle(ctx context.Context) (string, error)
	// FlatConfigOptions 返回扁平化的 config options(给前端渲染下拉)。
	FlatConfigOptions() []acp.ConfigOption
	// SupportsImage 报告 agent 是否声明了 image prompt 能力(前端据此门控图片输入入口)。
	SupportsImage() bool
	// SetConfigOption 切换 config option(model/mode/effort),热切同 session 即时生效。
	SetConfigOption(ctx context.Context, configId, value string) error
	// RefreshConfig 重新 spawn probe harness 拉最新 configOptions(同步外部配置改动),
	// 不影响当前活跃连接、不中断对话流。详见 acp.ChatSession.RefreshConfig。
	RefreshConfig(ctx context.Context) ([]acp.ConfigOption, error)
	// SetPermissionRules 更新该 session 的分级权限规则快照(§3.4)。规则变更时由 service 对所有活跃 session 调用。
	SetPermissionRules(rules []permissions.Rule)
}

// turnEntry 一轮时序里的一项,由稳定标识驱动(对标 omp/opencode 的"对象归并"模型):
// 同一 messageId 的所有 message chunk 归并到同一条 entry(thought/text 各一,主键=mid+role);
// 同一 toolCallId 的 tool_call + 所有 update 归并到同一条 tool entry。
// 单一时序队列 timeline 保证 persistTurn 按真实发生顺序写库(thought→tool→agent 交错),
// 消灭旧实现"先写所有段再写所有工具 → 工具堆 turn 末尾"的 bug(§5.4 #12),
// 也消灭"tool_call_update 打断流式 agent 气泡"的 bug(§5.4 #11)。
type turnEntry struct {
	id    string          // 主键:message=messageId+role 复合 / tool=toolCallId / user=合成
	kind  string          // "message" | "tool"
	role  string          // message: "agent"|"thought"|"user";tool:""
	text  strings.Builder // message 累积全文(chunk 是增量,按 id 归并累加)
	tool  *toolAccum      // kind=="tool":工具状态(update 就地 patch,指针单例)
	final bool            // message 收口(轮结束 finalize)/ tool 终态
}

// liveSession 一个活跃的 ACP 对话(内存态,钉在某个 db session 上)。
type liveSession struct {
	chat      chatConn
	proj      *store.Project
	harnessID string // 该 session 使用的 harness(omp/opencode);自动升级据此判定「该 harness 是否有运行中进程」

	mu           sync.Mutex
	timeline     []*turnEntry          // 单一时序队列:真相,持久化按此序写库
	index        map[string]*turnEntry // 主键 → entry(归并用);message 主键=mid+role,tool 主键=toolCallId
	seq          int64                 // 单调序号,流式事件防乱序(§4.3)
	syntheticGen int                   // 无 messageId(harness 不发,如 goose)时的合成消息代际:tool_call 递增,使 tool 后的同 role 文本落新段(§5.3 无 messageId 回退)

	// 当前 turn 的标识与 plan 快照(用于按 turn 保留历史 plan):
	//   - currentTurnID:开启该 turn 的 user message ID(由 client 生成,协议无 turnId)。
	//     plan 事件携带它,前端据此把 plan 钉在对应 turn 上。
	//   - currentPlan:本轮 plan 的最新全量快照(ACP plan 整表替换模型)。turn 结束时若非空
	//     则持久化为 role='plan' message,使重开会话能回看每轮 plan。
	// resetBuffers(turn 开始)清空两者。
	currentTurnID string
	currentPlan   []acp.PlanEntry // flat shape(与 SessionEvent.PlanEntries 一致),持久化与实时事件同形

	// 单 turn 生命周期:ACP 协议无 queue,一个 session 同时只允许一个 Prompt
	// (session/prompt 是同步请求-响应,turn 未结束前不能发下一个,见 §5.4 调研结论)。
	// sendMu 串行化所有「发起 turn」入口(SendMessage / InterruptAndSend),
	// busy 在 sendMu 保护下同步置位,杜绝两轮 Prompt 重叠(治本并发隐患)。
	sendMu       sync.Mutex
	busy         bool               // 本轮 Prompt 进行中
	lastActivity int64              // 最后活动时间(unix milli);startLive 初始化、turn 结束时更新。idle reaper 据此判定关闭。
	turnCancel   context.CancelFunc // 取消本轮 Prompt(干净 session/cancel,非杀进程)
	turnDone     chan struct{}      // 本轮 runPrompt 返回时关闭(供 InterruptAndSend 等待其落定)
	suppressIdle bool               // InterruptAndSend 置位:本轮结束不发 idle(打断后由新轮发 prompting,避免触发 auto-continue 误续发)
}

// resetBuffers 清空本轮 timeline(turn 开始时调)。调用方:startTurn/SendAndWaitSync。
func (ls *liveSession) resetBuffers() {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.timeline = nil
	ls.index = map[string]*turnEntry{}
	ls.currentTurnID = ""
	ls.currentPlan = nil
	ls.syntheticGen = 0
}

// appendEntry 新建 entry 并入队 timeline + 登记 index。调用方须持 ls.mu。
func (ls *liveSession) appendEntry(e *turnEntry) {
	ls.timeline = append(ls.timeline, e)
	ls.index[e.id] = e
}

// finalizeTurn 把所有非终态 entry 标记为 final(轮结束收口),返回 timeline 供持久化。
// 调用方须持 ls.mu。runPrompt 与 SendAndWaitSync 收尾共用。
func (ls *liveSession) finalizeTurn() []*turnEntry {
	for _, e := range ls.timeline {
		e.final = true
	}
	return ls.timeline
}

// segmentEntries 返回 timeline 里 message 类 entry 的(role,content)快照,供回归测试断言。
func (ls *liveSession) segmentEntries() []segEntry {
	out := make([]segEntry, 0, len(ls.timeline))
	for _, e := range ls.timeline {
		if e.kind == "message" {
			out = append(out, segEntry{e.role, e.text.String()})
		}
	}
	return out
}

// toolByID 返回某 toolCallId 的 toolAccum(测试断言用)。不存在返回 nil。
func (ls *liveSession) toolByID(id string) *toolAccum {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	if e := ls.index[id]; e != nil && e.kind == "tool" {
		return e.tool
	}
	return nil
}

// segEntry 仅供测试断言用(role+content 快照)。
type segEntry struct {
	role    string
	content string
}

// ChatService 暴露给前端的主服务。
type ChatService struct {
	cfg *config.Config
	st  *store.Store
	ctx context.Context

	mu      sync.RWMutex
	active  map[string]*liveSession // db sessionID → live
	spawnMu sync.Mutex              // 串行化 ensureLive 的 spawn 段,杜绝 warm 与首条消息并发双 spawn

	// harness 缓存:Discover 的运行时结果(已发现/版本/可升级)。启动后异步填充;
	// 前端经 ListHarnesses 读快照、RefreshHarnesses 触发重刷。nil = 用静态 Supported 兜底。
	harnessCache atomic.Pointer[[]harness.Harness]

	// idle reaper:超 idleTimeout 未活动且非 busy 的 session 自动 CloseSession,释放资源(B 方案)。
	// ServiceStartup 起 goroutine,ServiceShutdown 优雅停。测试注入短 timeout。
	idleTimeout time.Duration
	reaperStop  chan struct{}
	reaperDone  chan struct{}

	// harness 断连自动重连(§3.3):disconnect 后后台 spawn 新 harness,使 session 自愈、
	// 用户下一条消息零延迟。exponential backoff + 重试上限防崩溃循环;busy/idle 两条分支
	// 分别由 runPrompt(peer-disconnected)与 health watcher(空闲进程死)触发;userStopped
	// (StopSession 干净 cancel 不 teardown → 天然不触发)与 CloseSession(显式 stopReconnect)抑制。
	reconnects        map[string]*reconnectCtl // sessionID → 进行中的重连(去重:同时只一个)
	reconnectGiveUp   map[string]bool          // sessionID → 重连耗尽,放弃自动重连(用户发消息时清)
	reconnectEnabled  bool                     // ServiceStartup 置 true;未启 ServiceStartup 的单测默认 false(不触发重连)
	healthStop        chan struct{}            // health watcher 停止信号
	healthDone        chan struct{}            // health watcher 退出信号(优雅停)
	healthInterval    time.Duration            // health watcher 扫描间隔(检测空闲断连)
	reconnMaxAttempt  int                      // 重连最大尝试次数
	reconnInitBackoff time.Duration            // 重连初始退避
	reconnMaxBackoff  time.Duration            // 重连退避上限
	reconnStability   time.Duration            // 重连 spawn 后稳定观察期(期内死算失败)

	// harness 版本更新周期刷新(可选,check_harness_updates 设置开关):周期重跑
	// refreshHarnessesAsync,持续刷新「上游最新版本」(前端据此显示可升级提示)。
	// ServiceStartup 按持久化设置决定是否起;SetCheckHarnessUpdates 实时启停。
	// 默认开启,周期 harnessRefreshEvery(测试可注入短间隔加速)。
	harnessRefreshStop  chan struct{}
	harnessRefreshDone  chan struct{}
	harnessRefreshEvery time.Duration

	// 自动升级(auto_harness_upgrade 设置开关):周期 ticker 发现 UpgradeAvailable 后,
	// 若开关开启且该 harness 无运行中进程(§5.3 先验证再动手),静默调 UpgradeHarness。
	// 失败进冷却(autoUpgradeCooldown[id] = 可再试时刻)防每个 tick 反复重试同一失败升级。
	// 与 check_harness_updates 共用同一 ticker(ticker 在二者任一开启时运行)。
	autoUpgradeCooldown    map[string]time.Time // harnessID → 冷却到期时刻(受 s.mu 保护)
	autoUpgradeCooldownDur time.Duration        // 失败冷却时长(生产默认 1h;测试注入短值加速)

	// 测试钩子(nil = 生产路径,见 emit/persistTurn):emitHook 捕获 emit 事件序列、
	// persistHook 在 persistTurn 入口阻塞。仅单测注入,用于确定性复现 runPrompt
	// 收尾与并发 send 的竞态(§5.4 覆盖竞态)。
	emitHook    func(name string, data any)
	persistHook func()

	// spawnFn 启动一个 liveSession(spawn harness + Init + NewSession/LoadSession)。
	// 默认 = s.startLive;单测注入 mock 以免启真 harness(§5.1)。ensureLive 经它 spawn,
	// 使懒 spawn(OpenSession/ContinueSession/SendMessage)的触发路径可被单测断言。
	spawnFn func(se *store.Session, proj *store.Project, acpSessionID string, resume bool) error
}

// NewChatService 构造(尚未启动;ServiceStartup 时 open store)。
func NewChatService(cfg *config.Config) *ChatService {
	return &ChatService{
		cfg: cfg, active: map[string]*liveSession{}, idleTimeout: 5 * time.Minute,
		reconnects: map[string]*reconnectCtl{}, reconnectGiveUp: map[string]bool{},
		healthInterval:         3 * time.Second,
		reconnMaxAttempt:       5,
		reconnInitBackoff:      1 * time.Second,
		reconnMaxBackoff:       30 * time.Second,
		reconnStability:        5 * time.Second,
		harnessRefreshEvery:    time.Hour,
		autoUpgradeCooldown:    map[string]time.Time{},
		autoUpgradeCooldownDur: time.Hour,
	}
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
	s.spawnFn = s.startLive                                               // 默认 spawn 实现;单测可注入 mock(§5.1)
	acp.SetPgidFile(filepath.Join(s.cfg.CachesDir, "harness-pgids.json")) // §3.2:限定回收范围到本应用派生的 harness
	acp.SetHarnessCommands(harness.Commands())                            // 注入受支持 harness 命令,回收层据此识别 omp/opencode/...(不再写死 opencode)
	acp.KillAllHarnesses()                                                // 启动时清上轮残留 harness 进程组(§3.2)
	s.startIdleReaper()                                                   // B 方案:idle reaper 回收空闲 harness
	s.startHealthWatcher()                                                // §3.3:空闲断连检测 → 自动重连
	s.reconnectEnabled = true                                             // 启用断连自动重连(单测默认 false,不触发)
	// 异步发现本机已安装 harness + 查上游最新版本(不阻塞启动;完成后推 EventHarnesses 让前端重拉)。
	// 失败静默降级:ListHarnesses 会用静态 Supported 兜底,前端照常可选 harness(只是没版本信息)。
	go s.refreshHarnessesAsync()
	// 周期刷新 harness 版本(check / auto 设置共用同一 ticker):按持久化设置决定是否起。
	// check 负责「周期刷新上游版本」(红点),auto 负责「发现可升级且安全时静默 UpgradeHarness」。
	// 二者任一开启即运行 ticker;都关闭则不耗资源。
	s.syncHarnessRefreshTicker()
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
	// 停 health watcher 与全部重连 goroutine(避免它们在关 session 后还操作 active)。
	if s.healthStop != nil {
		close(s.healthStop)
		<-s.healthDone
	}
	s.stopHarnessRefresh() // 停 harness 周期刷新 ticker
	s.stopAllReconnects()
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

// emitError 推 error 状态并附带稳定错误码(前端按 code 翻译,§4.4)。
// detail 留空:不把协议/OS 裸错误抛给用户,文案统一由前端 i18n 提供。
func (s *ChatService) emitError(sessionID, code string) {
	s.emit(EventStatus, StatusPayload{SessionID: sessionID, Status: "error", Code: code})
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
	var stopped []string
	for sid, ls := range s.active {
		if ls.proj != nil && ls.proj.ID == id {
			ls.chat.Close()
			delete(s.active, sid)
			s.reconnectGiveUp[sid] = true
			stopped = append(stopped, sid)
		}
	}
	s.mu.Unlock()
	for _, sid := range stopped {
		s.stopReconnect(sid)
	}
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

// SetSessionPinned 设置会话置顶(0008)。前端侧栏右键菜单切换 → 乐观本地重排即时生效;
// 持久化在 DB,pinned 由 ListSessions ORDER BY 接管顶部位置。
func (s *ChatService) SetSessionPinned(sessionID string, pinned bool) error {
	return s.st.SetSessionPinned(s.ctx, sessionID, pinned)
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
	// 记住本次选择的 harness,下次新建对话默认选中(§5.3 本地是真相来源)。
	if err := s.st.SetSetting(s.ctx, "lastHarness", hid); err != nil {
		slog.Warn("persist lastHarness", "err", err)
	}
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
		wtPath := filepath.Join(s.cfg.CachesDir, "worktrees", proj.ID, se.ID)
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
	s.reconnectGiveUp[sessionID] = true // 抑制自动重连(session 要删了)
	s.mu.Unlock()
	s.stopReconnect(sessionID)
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

// SessionCurrentBranch 返回 session 工作目录的当前分支(供源代码管理面板顶部展示)。
// worktree 模式 = md/<id> 分支;非 worktree 的 git 项目 = 项目目录当前分支(detached HEAD 时为短 commit);
// 非 git 项目返回空串(前端不展示 SCM,分支位也无意义)。
//
// 关键:Branch 字段只在 worktree 模式有值(= md/<id>),非 worktree 恒空 —— 前端若直接读
// session.Branch 会在非 worktree 的 git 项目里显示空分支。这里读真实 HEAD 修正该展示。
func (s *ChatService) SessionCurrentBranch(sessionID string) (string, error) {
	dir, err := s.scmDir(sessionID)
	if err != nil {
		return "", nil // 非 git 上下文:静默返回空
	}
	br, err := worktree.HeadShort(dir)
	if err != nil {
		return "", nil
	}
	return br, nil
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

// OpenSession 打开已有 session。懒 spawn(§3.x):
//   - 历史会话(已有消息):只读打开,不 spawn harness —— 仅从 DB 读历史展示,
//     推 readonly 状态让前端给「只读 - 发消息以继续」提示。用户发新消息或点「继续会话」
//     (ContinueSession)时才 spawn 并切为可交互态。避免只读查看浪费一个 harness 进程。
//   - 新建会话(无消息):保持原行为,立即异步 spawn(B 方案:切过去就绪,首条消息零延迟)。
//
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
	// 历史会话:只读,不 spawn。发消息 / ContinueSession 时才 ensureLive。
	if has, _ := s.st.SessionHasMessages(s.ctx, sessionID); has {
		s.emitStatus(sessionID, "readonly", "")
		return nil
	}
	go func() {
		if err := s.ensureLive(sessionID); err != nil {
			slog.Warn("open session spawn failed", "session", sessionID, "err", err)
		}
	}()
	return nil
}

// ContinueSession 显式触发懒 spawn:只读态下用户点「继续会话」时调用,
// spawn harness(LoadSession resume 历史会话 / NewSession 新会话)并切为可交互态。
// 已活跃则 no-op。与 SendMessage 共用 ensureLive(spawnMu 串行化,不双 spawn)。
func (s *ChatService) ContinueSession(sessionID string) error {
	if s.isActive(sessionID) {
		return nil
	}
	return s.ensureLive(sessionID)
}

// ensureLive 确保 session 的 harness 已启动且仍存活:未活跃则 spawn;活跃但进程已死
// (预热后空闲断连 / 崩溃)则先拆掉再 spawn(用 LoadSession resume),不把 broken pipe 抛给用户。
// 开 session 时冷缓存会预热 spawn 保持连接等首条消息(见 maybeWarmSession)。
//
// spawn 段持 spawnMu 串行化:杜绝「预热 goroutine 与首条消息并发各 spawn 一个 harness」
// (二者都不持 sendMu)——后到者拿到锁后重检 active,已活跃则直接复用。
//
// 用户主动调用(发消息 / 继续 / 切配置)经此入口 → 清 reconnectGiveUp:重连耗尽后用户
// 手动再试,给一个新的重连预算(§3.3 自动重连上限)。重连循环内部用 ensureLiveNoReset
// 不清(否则耗尽 set 的 giveUp 会被自身 attempt 清掉,失去防崩溃循环作用)。
func (s *ChatService) ensureLive(sessionID string) error {
	s.mu.Lock()
	delete(s.reconnectGiveUp, sessionID)
	s.mu.Unlock()
	return s.ensureLiveNoReset(sessionID)
}

// ensureLiveNoReset 与 ensureLive 同,但不清 reconnectGiveUp(供自动重连循环用)。
func (s *ChatService) ensureLiveNoReset(sessionID string) error {
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
	return s.spawnFn(se, proj, se.ACPSession, resume)
}

// startLive 启动一个 liveSession(spawn harness + Init + NewSession/LoadSession)。
func (s *ChatService) startLive(se *store.Session, proj *store.Project, acpSessionID string, resume bool) error {
	// 按 session 选择的 harness 解析启动命令(§2.1 harness 适配层)。
	cmdStr := harness.Command(se.Harness)
	// model 不在 spawn 注入:统一走 ACP session config option(model selector)
	// + session/set_config_option 在 NewSession 后应用(见 SetSessionConfigOption)。
	runner := acp.NewRunner(cmdStr, nil)
	cwd := proj.Path
	if se.WorktreePath != "" {
		cwd = se.WorktreePath // 每个 session 独占 worktree(并行隔离)
	}

	ls := &liveSession{proj: proj, harnessID: se.Harness, index: map[string]*turnEntry{}, lastActivity: time.Now().UnixMilli()}
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
	// 加载分级权限规则快照到 handler(§3.4:allow/ask/deny 路由)。规则是全局的(全应用一份),
	// 每个 session 启动时拿当前快照;规则变更时由 applyPermissionRulesToAll 刷新全部活跃 session。
	chat.SetPermissionRules(s.snapshotPermissionRules())
	// 注册「全局允许」回调:用户在某 session 选 onRespond("global") 时,handler 把当前请求
	// 固化成的准确匹配 allow 规则交回 service 持久化进 DB + 刷新全部活跃 session(跨 session/project 全局生效,§3.4)。
	chat.Handler.OnGlobalRule = s.persistGlobalPermissionRule

	s.mu.Lock()
	s.active[se.ID] = ls
	s.mu.Unlock()

	// 新建时记录 opencode 返回的 session id(供下次 resume)。
	if !resume {
		_ = s.st.UpdateSessionACP(s.ctx, se.ID, string(chat.SessionID), se.Title)
	}
	s.emitStatus(se.ID, "started", "")
	// 推送 agent 自报的 config options(model/mode/effort),前端据此渲染下拉。
	// 同时附带 image prompt 能力门控(前端据此决定是否展示图片输入入口,§3.5)。
	// 即使无 config options 也要发,以投递 imageSupported(去掉 len>0 守卫)。
	flatOpts := chat.FlatConfigOptions()
	// goose skip-setup(无 resume/load):拿不到 fresh configOptions → 用持久化缓存兜底,
	// 否则前端 config_option 事件用空数组覆盖、模型选择器空白(goose 首条 prompt 自动加载
	// session 时模型已在它那持久化;此处仅渲染选择器,不影响实际生效的 model)。
	if len(flatOpts) == 0 && se.ConfigOptionsCache != "" {
		var cached []acp.ConfigOption
		if json.Unmarshal([]byte(se.ConfigOptionsCache), &cached) == nil {
			flatOpts = cached
		}
	}
	s.emit(EventUpdate, acp.SessionEvent{
		SessionID:      se.ID,
		Kind:           "config_option",
		ConfigOptions:  flatOpts,
		ImageSupported: chat.SupportsImage(),
	})
	// 持久化 config options 快照(懒 spawn:只读态用缓存渲染 ModelSelect,§3.x)。
	s.persistConfigCache(se.ID, flatOpts)
	slog.Info("session live", "id", se.ID, "resume", resume, "cwd", proj.Path, "model", se.Model)
	return nil
}

// CloseSession 关闭活跃 ACP session(保留 db 记录,可再次 Open)。
// busy(turn 进行中)时拒绝:idle reaper 跳过、用户需先 Stop。避免杀掉正在输出的 turn。
// 用户主动关 → 抑制自动重连(stopReconnect + giveUp),防在途重连把刚关的 session 又拉起来。
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
	s.reconnectGiveUp[sessionID] = true // 抑制在途 / 后续自动重连
	s.mu.Unlock()
	ls.chat.Close()
	s.reapIfIdle()
	s.stopReconnect(sessionID) // 停在跑的重连 goroutine(已 giveUp,startReconnect 也不会再启)
	s.emitStatus(sessionID, "closed", "")
	return nil
}

// errSessionBusy turn 进行中关闭/操作时返回(idle reaper 静默跳过,用户需先停)。
var errSessionBusy = errors.New("对话进行中,请等回合结束再关闭")

// reapIfIdle 仅当无活跃 session 时 reap 逃逸 harness(多 session 并发安全,§3.2)。
func (s *ChatService) reapIfIdle() {
	s.mu.RLock()
	n := len(s.active)
	s.mu.RUnlock()
	if n == 0 {
		acp.ReapStrayHarnesses()
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

// ─── harness 断连自动重连(§3.3)─────────────────────────────────────────────
//
// 触发:disconnect 后 proactively spawn 新 harness,使 session 自愈、用户下条消息零延迟。
//   - busy 分支:runPrompt 收到 peer-disconnected → teardownLive + startReconnect。
//   - idle 分支:health watcher 检测 active 中进程已死且非 busy → teardownLive + startReconnect。
//
// 抑制(userStopped):
//   - StopSession 干净 cancel:不 teardown,harness 仍存活 → 天然不触发(§5.4 #13)。
//   - CloseSession/DeleteSession/RemoveProject:stopReconnect + setReconnectGiveUp,防在途触发。
//
// 防崩溃循环:reconnectLoop 每次尝试后等「稳定观察期」确认 harness 存活才算成功;spawn 后
// 迅速死掉也计为一次失败。耗尽上限 → setReconnectGiveUp,后续 health watcher 不再自动重连,
// 直到用户主动操作(发消息/继续/切配置 经 ensureLive)清掉 giveUp 重新给预算。

// startHealthWatcher 启动 health watcher:周期扫描 active session,检测「进程已死但 session
// 仍在 active」(空闲断连——harness 在 turn 之间自行退出,§5.4 #9 opencode 空闲自杀)。
// 检测到 → teardownLive + startReconnect(idle 分支)。busy 的交给 runPrompt 处理。
// ServiceShutdown 经 healthStop 优雅停。
func (s *ChatService) startHealthWatcher() {
	s.healthStop = make(chan struct{})
	s.healthDone = make(chan struct{})
	go s.healthWatcher()
}

func (s *ChatService) healthWatcher() {
	defer close(s.healthDone)
	if s.healthInterval <= 0 {
		return // 测试未注入:不启用 health watcher
	}
	ticker := time.NewTicker(s.healthInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.healthStop:
			return
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.checkSessionHealth()
		}
	}
}

// checkSessionHealth 扫描 active session:进程死且非 busy 的视为空闲断连,拆 + 重连。
// busy 的跳过(runPrompt 的 peer-disconnected 路径会处理)。giveUp 的不重连(耗尽过)。
func (s *ChatService) checkSessionHealth() {
	type deadSession struct {
		id string
		ls *liveSession
	}
	var dead []deadSession
	s.mu.RLock()
	for id, ls := range s.active {
		if ls.chat.IsAlive() {
			continue
		}
		ls.mu.Lock()
		busy := ls.busy
		ls.mu.Unlock()
		if busy {
			continue // turn 中断连:runPrompt 处理
		}
		dead = append(dead, deadSession{id, ls})
	}
	s.mu.RUnlock()
	for _, d := range dead {
		slog.Info("idle harness died (health watcher), reconnecting", "session", d.id)
		s.teardownLive(d.id, d.ls)
		// 不推 error:空闲断连用户无感知,直接进 reconnecting,避免打扰。
		s.startReconnect(d.id)
	}
}

// startReconnect 启动一个后台重连 goroutine(幂等:已有在跑则 no-op;giveUp 则不启动)。
// 未启用(ServiceStartup 未调 / 单测)时 no-op:既存的 disconnect 单测默认不触发重连。
func (s *ChatService) startReconnect(sessionID string) {
	if !s.reconnectEnabled || s.reconnMaxAttempt <= 0 {
		return
	}
	s.mu.Lock()
	if s.reconnectGiveUp[sessionID] {
		s.mu.Unlock()
		return
	}
	if _, ok := s.reconnects[sessionID]; ok {
		s.mu.Unlock()
		return // 已有重连在跑
	}
	ctl := &reconnectCtl{stop: make(chan struct{}), done: make(chan struct{})}
	s.reconnects[sessionID] = ctl
	s.mu.Unlock()
	go func() {
		defer close(ctl.done)
		s.reconnectLoop(sessionID, ctl.stop)
		s.mu.Lock()
		delete(s.reconnects, sessionID)
		s.mu.Unlock()
	}()
}

// stopReconnect 停止某 session 的重连 goroutine 并等其落定(幂等;无在跑则 no-op)。
// CloseSession/DeleteSession 用:用户主动关 → 不应再自动重连。
func (s *ChatService) stopReconnect(sessionID string) {
	s.mu.Lock()
	ctl, ok := s.reconnects[sessionID]
	if ok {
		// 先从 map 移除,防止 stop 期间另一路 startReconnect 抢入。
		delete(s.reconnects, sessionID)
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	close(ctl.stop)
	<-ctl.done
}

// stopAllReconnects 停止全部重连 goroutine(ServiceShutdown 用)。
func (s *ChatService) stopAllReconnects() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.reconnects))
	for id := range s.reconnects {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.stopReconnect(id)
	}
}

// reconnectLoop 自动重连主循环:exponential backoff + 重试上限 + 稳定观察期。
//
// 成功判定:ensureLiveNoReset 成功 spawn 后,等 reconnStability 确认 harness 仍存活。
// 期内死掉(health watcher 拆了 / IsAlive 翻 false)算失败,继续下一次尝试——覆盖
// 「spawn 成功但立刻崩溃」的崩溃循环场景。
//
// 耗尽:setReconnectGiveUp(后续自动重连停摆,直到用户主动 ensureLive 清 giveUp)+ 推 error。
func (s *ChatService) reconnectLoop(sessionID string, stop <-chan struct{}) {
	s.emitStatus(sessionID, statusReconnecting, "")
	backoff := s.reconnInitBackoff
	for attempt := 1; attempt <= s.reconnMaxAttempt; attempt++ {
		select {
		case <-stop:
			return
		case <-s.ctx.Done():
			return
		case <-time.After(backoff):
		}
		if err := s.ensureLiveNoReset(sessionID); err != nil {
			slog.Warn("reconnect attempt failed", "session", sessionID, "attempt", attempt, "err", err)
			backoff = min(backoff*2, s.reconnMaxBackoff)
			continue
		}
		// spawn 成功(startLive 已推 started)。等稳定观察期确认不是立刻崩溃。
		if !s.awaitStability(sessionID, stop) {
			backoff = min(backoff*2, s.reconnMaxBackoff)
			continue
		}
		slog.Info("reconnect succeeded", "session", sessionID, "attempt", attempt)
		return
	}
	slog.Error("reconnect exhausted retries", "session", sessionID, "attempts", s.reconnMaxAttempt)
	s.mu.Lock()
	s.reconnectGiveUp[sessionID] = true
	s.mu.Unlock()
	s.emitError(sessionID, ErrCodeHarnessReconnectFailed)
}

// awaitStability 等 reconnStability 确认 harness 仍存活。期内进程死(active 被拆 /
// IsAlive 翻 false)→ 返回 false(算失败)。stop/s.ctx 取消 → 返回 false(循环上层退出)。
func (s *ChatService) awaitStability(sessionID string, stop <-chan struct{}) bool {
	deadline := time.NewTimer(s.reconnStability)
	defer deadline.Stop()
	tick := time.NewTicker(s.reconnStability / 5)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return false
		case <-s.ctx.Done():
			return false
		case <-deadline.C:
			// 度过完整稳定期:最终确认仍存活。
			s.mu.RLock()
			ls, ok := s.active[sessionID]
			alive := ok && ls.chat.IsAlive()
			s.mu.RUnlock()
			return alive
		case <-tick.C:
			s.mu.RLock()
			ls, ok := s.active[sessionID]
			alive := ok && ls.chat.IsAlive()
			s.mu.RUnlock()
			if !alive {
				return false // 期内死掉:算失败
			}
		}
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
	userMsg, err := s.st.AppendMessage(s.ctx, sessionID, "user", "", text, "")
	if err != nil {
		ls.mu.Lock()
		ls.busy = false
		ls.mu.Unlock()
		detail := "保存消息失败:" + err.Error()
		s.emitStatus(sessionID, "error", detail)
		return fmt.Errorf("%s", detail)
	}
	// 记录本轮 turnID(= user message ID,协议无 turnId,client 生成)。
	// plan 事件据此把 plan 钉在对应 turn 上(见 handleEvent / persistTurnPlan)。
	ls.mu.Lock()
	ls.currentTurnID = userMsg.ID
	ls.mu.Unlock()
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
	userMsg, err := s.st.AppendMessage(s.ctx, sessionID, "user", "", text, "")
	if err != nil {
		return "", err
	}
	ls.mu.Lock()
	ls.currentTurnID = userMsg.ID
	ls.mu.Unlock()
	s.emit(EventUpdate, acp.SessionEvent{SessionID: sessionID, Kind: "user_message_chunk", Text: text})
	s.emitStatus(sessionID, "prompting", "")

	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	stopReason, err := ls.chat.Prompt(ctx, text, attachments)
	ls.mu.Lock()
	timeline := ls.finalizeTurn()
	planSnapshot := ls.currentPlan
	turnID := ls.currentTurnID
	ls.currentPlan = nil
	ls.currentTurnID = ""
	ls.mu.Unlock()
	s.persistTurn(sessionID, timeline)
	s.persistTurnPlan(sessionID, turnID, planSnapshot)
	agentText := ""
	for _, e := range timeline {
		if e.kind == "message" && e.role == "agent" {
			agentText = e.text.String()
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
		s.emitError(sessionID, ErrCodeHarnessDisconnected)
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

	stopReason, err := ls.chat.Prompt(turnCtx, text, attachments)

	// 收尾段持 sendMu:与 startTurn/SendMessage 互斥,杜绝「busy 已清、emit 未发」窗口被
	// 并发 send 抢占 → 旧 emit 延迟覆盖新 prompting(§5.4 覆盖竞态)。defer 早于 close(done)
	// (LIFO)执行 —— InterruptAndSend 等 turnDone 时 sendMu 已释放,不会死锁。
	ls.sendMu.Lock()
	defer ls.sendMu.Unlock()
	ls.mu.Lock()
	// 收尾:finalize 所有 entry,取本轮完整 timeline。
	timeline := ls.finalizeTurn()
	// 捕获本轮 plan 快照 + turnID 用于持久化(见 persistTurnPlan)。resetBuffers 在下一个
	// startTurn 调用,但提前清空避免任何路径遗漏(plan 不应跨 turn 残留)。
	planSnapshot := ls.currentPlan
	turnID := ls.currentTurnID
	ls.currentPlan = nil
	ls.currentTurnID = ""
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
	s.persistTurn(sessionID, timeline)
	// 持久化本轮 plan 快照(role='plan' message),使重开会话能回看每轮 plan。
	// 放在 status emit 之前:前端收到 idle 时持久化已落库,重开会话 / 翻页能拿到。
	s.persistTurnPlan(sessionID, turnID, planSnapshot)

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
		// §4.4:不把裸 error(协议 JSON/OS 错)抛给用户,改推稳定 code,前端按 code 经 i18n 翻译。
		s.emitError(sessionID, ErrCodeHarnessDisconnected)
		// §3.3 busy 分支自动重连:harness 断连后后台 spawn 新 harness,使 session 自愈。
		// userStopped(cancelled)天然不触发——干净 cancel 不 teardown、harness 仍可用。
		s.startReconnect(sessionID)
		return
	}
	// 空响应检测:Prompt 成功返回但零输出(timeline 空)——通常是 resume 后
	// harness 内部 session 状态损坏(§5.4)。不静默当成功,否则用户发了消息没反应。
	// 按 error 路径处理:拆连接 + 用户可见提示,下条消息走 ensureLive 重连。
	if len(timeline) == 0 {
		s.teardownLive(sessionID, ls)
		slog.Error("prompt empty turn", "session", sessionID, "stopReason", stopReason)
		s.emitError(sessionID, ErrCodeHarnessEmptyTurn)
		// 空响应也是 harness 状态损坏的信号:尝试自动重连(新 harness + resume 可能恢复)。
		s.startReconnect(sessionID)
		return
	}
	// 取 harness 生成的权威标题覆盖兜底标题(§5.4 #14)。
	s.syncSessionTitle(ls, sessionID)
	s.emitStatus(sessionID, "idle", "stopReason="+string(stopReason))
}

// persistTurn 把本轮 timeline 按真实发生顺序写库。
// message(thought/agent)与 tool 交错写入 —— 重开会话加载历史时,顺序与实时流式一一对应,
// 工具卡片不会全部堆到 turn 末尾(§5.4 #12)。
func (s *ChatService) persistTurn(sessionID string, timeline []*turnEntry) {
	if s.persistHook != nil {
		s.persistHook() // 测试钩子:在此阻塞放大收尾窗口(生产 nil,直通)
	}
	for _, e := range timeline {
		switch e.kind {
		case "message":
			content := e.text.String()
			if strings.TrimSpace(content) == "" {
				continue
			}
			kind := "agent_message_chunk"
			if e.role == "thought" {
				kind = "agent_thought_chunk"
			}
			if _, err := s.st.AppendMessage(s.ctx, sessionID, e.role, kind, content, ""); err != nil {
				slog.Warn("persist "+e.role, "err", err)
			}
		case "tool":
			body, _ := json.Marshal(e.tool)
			if _, err := s.st.AppendMessage(s.ctx, sessionID, "tool", "tool_call", string(body), e.tool.ID); err != nil {
				slog.Warn("persist tool", "err", err)
			}
		}
	}
}

// persistTurnPlan 把本轮 plan 最终快照写库(role='plan' message),使重开会话能回看
// 每轮 plan。空 entries 不写(无 plan 的 turn 不留痕)。turnID 存进 tool_call_id 列,
// 前端据此把 plan item 钉在对应 turn(plan 是按 turn 索引的历史快照)。
func (s *ChatService) persistTurnPlan(sessionID, turnID string, entries []acp.PlanEntry) {
	if len(entries) == 0 {
		return
	}
	body, err := json.Marshal(entries)
	if err != nil {
		slog.Warn("marshal plan entries", "err", err)
		return
	}
	if _, err := s.st.AppendMessage(s.ctx, sessionID, "plan", "plan", string(body), turnID); err != nil {
		slog.Warn("persist plan", "err", err)
	}
}

// persistConfigCache 把最新的扁平化 config options 序列化写库(懒 spawn:只读态渲染 ModelSelect 用)。
// 在 spawn 完成(startLive)/ config_option_update(handleEvent) / set_config_option / refresh config 时调用。
// 空切片不写(避免清空有效缓存)。写失败只记日志,不影响主流程。
func (s *ChatService) persistConfigCache(sessionID string, opts []acp.ConfigOption) {
	if len(opts) == 0 {
		return
	}
	b, err := json.Marshal(opts)
	if err != nil {
		slog.Warn("marshal config options cache", "err", err)
		return
	}
	if err := s.st.UpdateSessionConfigOptionsCache(s.ctx, sessionID, string(b)); err != nil {
		slog.Warn("persist config options cache", "err", err)
	}
}

// handleEvent 处理一条 SessionUpdate:按稳定标识归并进 timeline + 推前端(§5.4 #11/#12)。
//
// 归并主键(对标 omp/opencode 的"对象归并"):
//   - message: messageId(协议,优先)+ role 复合。同 messageId+role 的 chunk 累积进同一条 entry。
//     协议 messageId 是 UNSTABLE,harness 可能不发 → 回退:role 变化 / 被 tool 打断 = 新 entry
//     (把启发式降级成 fallback,主干仍是主键归并)。
//   - tool: toolCallId(协议必填)。tool_call 注册新 entry;update 就地 patch,**不动位置**。
//
// agent/thought 发增量 text → 按 id 累积成全文,对外发累积全文 + 单调 seq(前端按 seq 替换防乱序)。
// tool_call_update 只命中 tool entry(toolCallId),物理上碰不到 message entry → #11 构造性消灭。
func (s *ChatService) handleEvent(ls *liveSession, sessionID string, e acp.SessionEvent) {
	e.SessionID = sessionID
	ls.mu.Lock()
	ls.seq++
	e.Seq = ls.seq
	switch e.Kind {
	case "agent_message_chunk", "agent_thought_chunk":
		role := "agent"
		if e.Kind == "agent_thought_chunk" {
			role = "thought"
		}
		id := messageKey(ls, e.MessageID, role)
		entry := ls.index[id]
		if entry == nil || entry.kind != "message" || entry.role != role {
			// 新 entry(messageId 变化 / role 变化 / 首条):归并中断,新开一条。
			entry = &turnEntry{id: id, kind: "message", role: role}
			ls.appendEntry(entry)
		}
		entry.text.WriteString(e.Text)
		e.Text = entry.text.String()
	case "tool_call":
		ls.syntheticGen++ // 新工具 = 段边界:无 messageId 的 harness(如 goose)在此后产的文本落新段
		t, exists := ls.index[e.ToolCallID]
		if exists && t.kind == "tool" && t.tool != nil {
			// 重复 tool_call(异常):就地更新,不动位置。
			t.tool.Title = e.ToolTitle
			t.tool.Status = e.ToolStatus
			t.tool.Kind = e.ToolKind
			t.tool.RawInput = e.RawInput
		} else {
			ta := &toolAccum{ID: e.ToolCallID, Title: e.ToolTitle, Status: e.ToolStatus, Kind: e.ToolKind, RawInput: e.RawInput}
			ls.appendEntry(&turnEntry{id: e.ToolCallID, kind: "tool", tool: ta})
		}
	case "tool_call_update":
		t, exists := ls.index[e.ToolCallID]
		if exists && t.kind == "tool" && t.tool != nil {
			// 就地 patch,不动位置(§5.4 #10 单调状态 + #11 不打断流式 协同)。
			ta := t.tool
			if e.ToolTitle != "" {
				ta.Title = e.ToolTitle
			}
			if e.ToolStatus != "" && !isTerminalToolStatus(ta.Status) {
				ta.Status = e.ToolStatus
			}
			if e.ToolKind != "" {
				ta.Kind = e.ToolKind
			}
			if e.RawOutput != nil {
				ta.RawOutput = e.RawOutput
			}
		} else {
			// 孤儿 update(无对应 tool_call 的异常乱序):兜底建条。
			ta := &toolAccum{ID: e.ToolCallID, Title: e.ToolTitle, Status: e.ToolStatus, Kind: e.ToolKind, RawOutput: e.RawOutput}
			ls.appendEntry(&turnEntry{id: e.ToolCallID, kind: "tool", tool: ta})
		}
	case "plan":
		// plan 按 turn 索引(协议无 turnId,client 用 user message ID 作 turnID,见 startTurn)。
		// 整表替换:每条 plan 事件都是全量,直接覆盖 ls.currentPlan;turn 结束时落库。
		// 同时把 turnID 透传给前端,前端据此把 livePlan 钉在当前 turn。
		e.TurnID = ls.currentTurnID
		ls.currentPlan = e.PlanEntries
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
		// token 明细(来自 PromptResponse.Usage,Task #15138):仅在事件带明细时回写,
		// streaming UsageUpdate 不含明细(全 0)则跳过,避免覆盖已有值。
		if e.TotalTokens > 0 || e.InputTokens > 0 || e.OutputTokens > 0 || e.CachedReadTokens > 0 || e.CachedWriteTokens > 0 || e.ThoughtTokens > 0 {
			if err := s.st.UpdateSessionTokens(s.ctx, sessionID, e.CachedReadTokens, e.CachedWriteTokens, e.InputTokens, e.OutputTokens, e.ThoughtTokens, e.TotalTokens); err != nil {
				slog.Warn("persist token breakdown", "err", err)
			}
		}
	}
	if e.Kind == "config_option" && len(e.ConfigOptions) > 0 {
		// 持久化 config options 快照(懒 spawn:只读态用缓存渲染 ModelSelect)。
		// agent 经 config_option_update 主动推的最新全量(config_option_update)。
		s.persistConfigCache(sessionID, e.ConfigOptions)
	}
	s.emit(EventUpdate, e)
}

// messageKey 生成 message entry 的归并主键。
//
// 有 messageId(协议 UNSTABLE 但 omp/opencode 发):用 messageId+role,同 id 同 role 的 chunk 归并一条 —— 主干不变量。
// 无 messageId(goose 等不发):用 role+syntheticGen 做稳定键,连续同 role chunk 归并一条;
//
//	tool_call 递增 syntheticGen(handleEvent),使 tool 后的文本落新段 —— 边界信号从 messageId 换成 tool。
//	(§5.3:协议 messageId 是 UNSTABLE/可选,不能当稳定不变量;无 id 时的稳定信号是 tool 边界 + role。)
//
// 调用方须持 ls.mu。
func messageKey(ls *liveSession, messageId, role string) string {
	if messageId != "" {
		return "msg:" + messageId + ":" + role
	}
	return "msg:_" + role + ":" + strconv.Itoa(ls.syntheticGen)
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
// 懒 spawn:历史会话只读打开时未活跃 → 报错;spawn 后(发消息/继续会话)才可用。
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
// 懒 spawn:只读态(未活跃)下切换视为「继续会话」触发 spawn,spawn 完成后应用用户选的配置
// (语义统一:切换 = 先 spawn 再应用,与发消息触发 spawn 一致)。已活跃则直接热切。
func (s *ChatService) SetSessionConfigOption(sessionID, configId, value string) error {
	s.mu.RLock()
	ls := s.active[sessionID]
	s.mu.RUnlock()
	if ls == nil {
		// 懒 spawn:只读态切换 config option → ensureLive(spawn harness)→ 再应用配置。
		if err := s.ensureLive(sessionID); err != nil {
			return err
		}
		s.mu.RLock()
		ls = s.active[sessionID]
		s.mu.RUnlock()
		if ls == nil {
			return fmt.Errorf("session not active after spawn: %s", sessionID)
		}
	}
	if err := ls.chat.SetConfigOption(s.ctx, configId, value); err != nil {
		return err
	}
	flat := ls.chat.FlatConfigOptions()
	s.emit(EventUpdate, acp.SessionEvent{SessionID: sessionID, Kind: "config_option", ConfigOptions: flat})
	s.persistConfigCache(sessionID, flat)
	return nil
}

// GetSessionCachedConfigOptions 返回 session 持久化的 config options 快照(懒 spawn:只读态渲染用)。
// 无缓存(空会话 / 从未 spawn 过 / 缓存损坏)返回 nil, nil —— 前端据此决定是否渲染 ModelSelect。
func (s *ChatService) GetSessionCachedConfigOptions(sessionID string) ([]acp.ConfigOption, error) {
	se, err := s.st.GetSession(s.ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if se == nil || se.ConfigOptionsCache == "" {
		return nil, nil
	}
	var opts []acp.ConfigOption
	if err := json.Unmarshal([]byte(se.ConfigOptionsCache), &opts); err != nil {
		return nil, nil // 损坏的缓存静默忽略,前端走空(下次 spawn 会覆盖)
	}
	return opts, nil
}

// RefreshSessionConfig 重新拉取 session 的最新 configOptions(同步外部配置改动)。
//
// 用户在 harness 配置(如 opencode config)外部加了新 provider/model 后,点聊天界面的
// 「刷新」按钮触发此方法。后端 spawn 一个临时 probe harness(同 cwd + 同 harness 命令)
// 拉取最新 configOptions,更新到活跃 session 内存,并推 config_option event 让前端
// 模型下拉立即看到新选项。详见 acp.ChatSession.RefreshConfig。
//
// probe 完全独立:不影响当前活跃连接、不中断进行中的对话流(哪怕 turn 正在跑)。
// 调用方应配超时(spawn harness 可能慢),失败返回错误供前端提示。
func (s *ChatService) RefreshSessionConfig(sessionID string) ([]acp.ConfigOption, error) {
	s.mu.RLock()
	ls, ok := s.active[sessionID]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("session not active: %s", sessionID)
	}
	// probe 用独立 context + 超时兜底(spawn harness 卡死时避免无限等待)。
	// 不挂 s.ctx:probe 不应被应用退出以外的取消打断;这里用 60s 足够覆盖 spawn。
	ctx, cancel := context.WithTimeout(s.ctx, 60*time.Second)
	defer cancel()
	flat, err := ls.chat.RefreshConfig(ctx)
	if err != nil {
		return nil, err
	}
	// 持久化刷新后的 config options 快照(懒 spawn:只读态用缓存渲染 ModelSelect)。
	s.persistConfigCache(sessionID, flat)
	s.emit(EventUpdate, acp.SessionEvent{
		SessionID:      sessionID,
		Kind:           "config_option",
		ConfigOptions:  flat,
		ImageSupported: ls.chat.SupportsImage(),
	})
	return flat, nil
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

// ListHarnesses 返回当前已发现的 harness 列表(含本地安装版本与上游最新版本)。
// 启动后异步刷新;未就绪时回退静态 Supported(无版本信息,但前端能继续选 harness)。
// 前端监听 EventHarnesses 事件以在刷新后重拉。
func (s *ChatService) ListHarnesses() []harness.Harness {
	if p := s.harnessCache.Load(); p != nil {
		return *p
	}
	return harness.Supported
}

// RefreshHarnesses 立即重新发现 harness 并查上游最新版本,更新缓存并返回。
// 用户在 harness 管理面板点「刷新」时调;比启动时的异步刷新慢但更完整(无短超时)。
func (s *ChatService) RefreshHarnesses() ([]harness.Harness, error) {
	list := harness.Discover(s.ctx)
	s.harnessCache.Store(&list)
	s.emit(EventHarnesses, nil)
	return list, nil
}

// refreshHarnessesAsync 启动时后台发现:限时 5s(网络/超时不阻塞应用启动太长)。
// 出错也写空缓存 → ListHarnesses 拿到 nil 走 Supported 静态兜底,前端体验不退化。
func (s *ChatService) refreshHarnessesAsync() {
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	list := harness.Discover(ctx)
	s.harnessCache.Store(&list)
	s.emit(EventHarnesses, nil)
}

// ─── harness 版本更新周期刷新(check_harness_updates 设置开关)──────────────────
//
// 周期重跑 refreshHarnessesAsync,持续刷新「上游最新版本」:用户装了新 harness、上游发了
// 新版本时,前端能持续看到可升级提示(不必手动点刷新)。GitHub API 免鉴权 60/小时/IP,
// 默认每小时一次、每个有 Source 的 harness 一请求,远在限额内。
//
// 开关持久化在 settings(check_harness_updates),默认开启;SetCheckHarnessUpdates 实时启停
// 后台 ticker;ServiceShutdown/Close 时优雅停(等待 goroutine 落定,不泄漏)。

const settingKeyCheckHarnessUpdates = "check_harness_updates"

// settingKeyAutoHarnessUpgrade:「自动升级 harness」开关键(默认关闭:静默跑官方安装脚本较重,
// 由用户在设置里显式开启)。与 check_harness_updates 共用同一周期 ticker:
// check 负责周期刷新上游版本(红点),auto 负责「发现可升级且安全时静默 UpgradeHarness」。
// 二者任一开启即运行 ticker;都关闭则停。
const settingKeyAutoHarnessUpgrade = "auto_harness_upgrade"

// settingBool 把 setting 字符串值解释为 bool;空/无法识别按 def
// (避免设置项刚引入、缺省时读不出而误判)。
func settingBool(v string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// checkHarnessUpdatesSetting 读 check_harness_updates 设置(默认开启:开箱即得更新提示)。
func (s *ChatService) checkHarnessUpdatesSetting() bool {
	v, _ := s.st.GetSetting(s.ctx, settingKeyCheckHarnessUpdates)
	return settingBool(v, true)
}

// autoHarnessUpgradeSetting 读 auto_harness_upgrade 设置(默认关闭:跑官方安装脚本较重,显式开启)。
func (s *ChatService) autoHarnessUpgradeSetting() bool {
	v, _ := s.st.GetSetting(s.ctx, settingKeyAutoHarnessUpgrade)
	return settingBool(v, false)
}

// refreshTickerNeeded 报告是否需要运行周期 ticker:check 或 auto 任一开启即需要。
func (s *ChatService) refreshTickerNeeded() bool {
	return s.checkHarnessUpdatesSetting() || s.autoHarnessUpgradeSetting()
}

// GetCheckHarnessUpdates 返回「周期检查 harness 更新」开关当前值(前端设置面板复选框)。
// store 未就绪(单测未启 ServiceStartup)时按默认 true,与启动默认一致。
func (s *ChatService) GetCheckHarnessUpdates() bool {
	if s.st == nil {
		return true
	}
	return s.checkHarnessUpdatesSetting()
}

// GetAutoHarnessUpgrade 返回「自动升级 harness」开关当前值(前端设置面板复选框)。
// store 未就绪(单测)时按默认 false,与启动默认一致。
func (s *ChatService) GetAutoHarnessUpgrade() bool {
	if s.st == nil {
		return false
	}
	return s.autoHarnessUpgradeSetting()
}

// syncHarnessRefreshTicker 按「check 或 auto 任一开启」实时启停周期 ticker。
// 两个开关的 setter 都调它,避免各自 start/stop 互相踩(如:关 check 但 auto 仍开时 ticker 不该停)。
func (s *ChatService) syncHarnessRefreshTicker() {
	if s.refreshTickerNeeded() {
		s.startHarnessRefresh()
	} else {
		s.stopHarnessRefresh()
	}
}

// SetCheckHarnessUpdates 设置「周期检查 harness 更新」开关并实时启停后台 ticker:
// 仅当 auto 也关闭时关 check 才会真正停 ticker。值持久化,重启后保持。
func (s *ChatService) SetCheckHarnessUpdates(on bool) error {
	val := "false"
	if on {
		val = "true"
	}
	if err := s.st.SetSetting(s.ctx, settingKeyCheckHarnessUpdates, val); err != nil {
		return err
	}
	s.syncHarnessRefreshTicker()
	return nil
}

// SetAutoHarnessUpgrade 设置「自动升级 harness」开关并实时启停后台 ticker:
// 开启即起周期 ticker(发现可升级且安全时静默 UpgradeHarness);关闭且 check 也关时停 ticker。
// 值持久化,重启后保持。
func (s *ChatService) SetAutoHarnessUpgrade(on bool) error {
	val := "false"
	if on {
		val = "true"
	}
	if err := s.st.SetSetting(s.ctx, settingKeyAutoHarnessUpgrade, val); err != nil {
		return err
	}
	s.syncHarnessRefreshTicker()
	return nil
}

// startHarnessRefresh 启动 harness 周期刷新 goroutine(幂等:已在跑则不重复起)。
// ServiceStartup(设置开启时)与 SetCheckHarnessUpdates(true)调用。
func (s *ChatService) startHarnessRefresh() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.harnessRefreshStop != nil {
		return // 已在跑
	}
	if s.harnessRefreshEvery <= 0 {
		return // 未配置周期(测试默认 0):不起
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	s.harnessRefreshStop = stop
	s.harnessRefreshDone = done
	go s.harnessRefreshLoop(stop, done)
}

// stopHarnessRefresh 停止 harness 周期刷新 goroutine 并等待落定(幂等:未起则直接返回)。
func (s *ChatService) stopHarnessRefresh() {
	s.mu.Lock()
	stop := s.harnessRefreshStop
	done := s.harnessRefreshDone
	s.harnessRefreshStop = nil
	s.harnessRefreshDone = nil
	s.mu.Unlock()
	if stop == nil {
		return
	}
	close(stop)
	<-done
}

// harnessRefreshLoop 周期重跑 refreshHarnessesAsync(发现新装 harness / 上游新版本 → 推 EventHarnesses)。
// 每个 tick 后追加 maybeAutoUpgrade:若 auto_harness_upgrade 开启,对「可升级且无运行中进程」
// 的 harness 静默 UpgradeHarness(失败进冷却,见 maybeAutoUpgrade)。
// stop 由 startHarnessRefresh 创建,stopHarnessRefresh close 它请求退出并等待 done 落定。
func (s *ChatService) harnessRefreshLoop(stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	ticker := time.NewTicker(s.harnessRefreshEvery)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.refreshHarnessesAsync()
			s.maybeAutoUpgrade()
		}
	}
}

// maybeAutoUpgrade 由 harnessRefreshLoop 在每个 tick 后调用:若 auto_harness_upgrade 开启,
// 遍历缓存的 harness,对「UpgradeAvailable 且无运行中进程 且 未在失败冷却期」的 harness 静默升级。
//
// 两条安全闸门(§5.3 外部事实是设计前提时先验证再动手):
//  1. 运行中进程安全:升级一个正在被某活跃 session 使用的 harness 可能与运行中进程冲突
//     (Windows 无法覆写运行中 .exe;Unix 虽换 inode 但官方安装脚本可能重启服务/动用户数据)。
//     故先扫 s.active,任一活跃 session 使用该 harness 即跳过,等下个 tick 再试(那时通常已 idle)。
//  2. 失败冷却:升级失败则置 autoUpgradeCooldown[id]=now+cooldown,冷却期内不再反复重试同一失败升级
//     (防每个 tick 反复跑同一失败的安装脚本,打满日志/网络)。成功则清冷却。
//
// 纯静默:不向用户弹错误(后台行为);失败仅 slog + 冷却。升级成功会经 UpgradeHarness 刷新缓存 + 推事件,
// 前端自然看到新版本号(红点消失)。
func (s *ChatService) maybeAutoUpgrade() {
	if !s.autoHarnessUpgradeSetting() {
		return
	}
	p := s.harnessCache.Load()
	if p == nil {
		return
	}
	now := time.Now()
	s.mu.Lock()
	inUse := make(map[string]bool, len(s.active))
	for _, ls := range s.active {
		inUse[ls.harnessID] = true
	}
	var candidates []string
	for _, h := range *p {
		if !h.UpgradeAvailable {
			continue
		}
		if inUse[h.ID] {
			continue // 运行中进程安全:跳过(§5.3)
		}
		if until := s.autoUpgradeCooldown[h.ID]; until.After(now) {
			continue // 失败冷却期内:跳过
		}
		candidates = append(candidates, h.ID)
	}
	s.mu.Unlock()

	// 串行升级(不并行跑多个安装脚本,避免互相打架/抢网络)。
	for _, id := range candidates {
		s.autoUpgradeOne(id)
	}
}

// autoUpgradeOne 对单个 harness 静默升级;失败置冷却,成功清冷却。
// 复用 UpgradeHarness(它会重发现 + 刷缓存 + 推事件);auto 路径仅额外做冷却簿记。
func (s *ChatService) autoUpgradeOne(id string) {
	if _, err := s.UpgradeHarness(id); err != nil {
		slog.Warn("auto harness upgrade failed, entering cooldown", "harness", id, "err", err, "cooldown", s.autoUpgradeCooldownDur)
		s.mu.Lock()
		s.autoUpgradeCooldown[id] = time.Now().Add(s.autoUpgradeCooldownDur)
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	delete(s.autoUpgradeCooldown, id)
	s.mu.Unlock()
}

// UpgradeHarness 触发某 harness 的升级(委托给 Registry 配置的 Upgrader,通常是官方安装脚本)。
// 升级后自动重新发现并刷新缓存,返回最新列表(让前端能看到新版本号)。
// 升级报错时仍刷新一次并把错误塞进对应 harness 的 UpgradeError 字段,便于前端展示。
func (s *ChatService) UpgradeHarness(id string) ([]harness.Harness, error) {
	// 升级可能慢(下大文件/跑安装脚本);给个较长但有限的超时,避免永远挂起。
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Minute)
	defer cancel()
	upgradeErr := harness.Upgrade(ctx, id)

	list := harness.Discover(s.ctx)
	if upgradeErr != nil {
		// 把升级错误塞到对应 harness 的 UpgradeError 字段(便于前端展示具体原因)。
		for i := range list {
			if list[i].ID == id {
				list[i].UpgradeError = upgradeErr.Error()
				break
			}
		}
	}
	s.harnessCache.Store(&list)
	s.emit(EventHarnesses, nil)
	return list, upgradeErr
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

// GetLastHarness 返回上次新建对话选择的 harness(下次新建对话默认选中)。无则空串,前端自行回退首个。
func (s *ChatService) GetLastHarness() string {
	v, _ := s.st.GetSetting(s.ctx, "lastHarness")
	return v
}

// GetConfig 返回当前配置(默认 model、各数据目录)。
func (s *ChatService) GetConfig() map[string]string {
	return map[string]string{
		"defaultModel":        s.cfg.DefaultModel,
		"checkHarnessUpdates": strconv.FormatBool(s.GetCheckHarnessUpdates()),
		"autoHarnessUpgrade":  strconv.FormatBool(s.GetAutoHarnessUpgrade()),
		"dataDir":             s.cfg.DataDir,
		"logsDir":             s.cfg.LogsDir,
		"cachesDir":           s.cfg.CachesDir,
		"stateDir":            s.cfg.StateDir,
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
	// 权限规则:表空时写入默认规则(§3.4),否则保留用户已定制。
	if _, err := s.st.SeedDefaultPermissionRules(s.ctx, defaultPermissionRulesForStore()); err != nil {
		slog.Warn("seed default permission rules", "err", err)
	}
}

// snapshotPermissionRules 从 DB 读权限规则并转成 permissions.Rule(handler 引擎用)。
func (s *ChatService) snapshotPermissionRules() []permissions.Rule {
	stored, err := s.st.ListPermissionRules(s.ctx)
	if err != nil {
		slog.Warn("list permission rules", "err", err)
		return nil
	}
	out := make([]permissions.Rule, 0, len(stored))
	for _, r := range stored {
		out = append(out, permissions.Rule{
			ID: r.ID, ToolName: r.ToolName, ActionType: r.ActionType,
			PathPattern: r.PathPattern, CommandPattern: r.CommandPattern,
			Level: r.Level, SortOrder: r.SortOrder, Enabled: r.Enabled,
		})
	}
	return out
}

// applyPermissionRulesToAll 把当前规则快照刷进所有活跃 session 的 handler(规则变更后调用)。
func (s *ChatService) applyPermissionRulesToAll() {
	rules := s.snapshotPermissionRules()
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, ls := range s.active {
		ls.chat.SetPermissionRules(rules)
	}
}

// persistGlobalPermissionRule 把「全局允许」(onRespond("global"))固化出的准确匹配 allow 规则
// 持久化进 DB,并经 CreatePermissionRule → applyPermissionRulesToAll 刷新全部活跃 session 的规则
// 快照——使后续「同工具 + 同命令/同路径」的请求被规则引擎自动放行(跨 session/project 全局生效,§3.4)。
// 由 handler 在用户裁决 "global" 时经 OnGlobalRule 回调;handler 已另写满本 session 内存记忆,
// 故即使持久化失败,当前 session 仍即时放行(降级安全)。
func (s *ChatService) persistGlobalPermissionRule(r permissions.Rule) {
	sr := store.PermissionRule{
		ID:             "", // CreatePermissionRule 自动生成
		ToolName:       r.ToolName,
		ActionType:     r.ActionType,
		PathPattern:    r.PathPattern,
		CommandPattern: r.CommandPattern,
		Level:          r.Level,
		Enabled:        true,
	}
	if _, err := s.CreatePermissionRule(sr); err != nil {
		slog.Warn("persist global permission rule", "err", err, "tool", r.ToolName, "action", r.ActionType, "cmd", r.CommandPattern, "path", r.PathPattern)
	}
}

// defaultPermissionRulesForStore 把 permissions.DefaultRules 转成 store.PermissionRule(持久化用)。
// store 不依赖 internal/permissions(避免反向依赖),故转换在 service 层做。
func defaultPermissionRulesForStore() []store.PermissionRule {
	defs := permissions.DefaultRules()
	out := make([]store.PermissionRule, 0, len(defs))
	for _, d := range defs {
		out = append(out, store.PermissionRule{
			ID: d.ID, ToolName: d.ToolName, ActionType: d.ActionType,
			PathPattern: d.PathPattern, CommandPattern: d.CommandPattern,
			Level: d.Level, SortOrder: d.SortOrder, Enabled: d.Enabled,
		})
	}
	return out
}

// --- 权限规则 CRUD(前端设置面板用,§3.4)---

// ListPermissionRules 返回全部权限规则(按优先级 sort_order ASC)。
func (s *ChatService) ListPermissionRules() ([]store.PermissionRule, error) {
	return s.st.ListPermissionRules(s.ctx)
}

// CreatePermissionRule 新建一条权限规则,并刷新所有活跃 session 的规则快照。
func (s *ChatService) CreatePermissionRule(rule store.PermissionRule) (*store.PermissionRule, error) {
	if err := validatePermissionRule(rule); err != nil {
		return nil, err
	}
	r, err := s.st.CreatePermissionRule(s.ctx, rule)
	if err != nil {
		return nil, err
	}
	s.applyPermissionRulesToAll()
	return r, nil
}

// UpdatePermissionRule 更新一条权限规则,并刷新所有活跃 session 的规则快照。
func (s *ChatService) UpdatePermissionRule(rule store.PermissionRule) error {
	if err := validatePermissionRule(rule); err != nil {
		return err
	}
	if err := s.st.UpdatePermissionRule(s.ctx, rule); err != nil {
		return err
	}
	s.applyPermissionRulesToAll()
	return nil
}

// DeletePermissionRule 按 id 删除一条权限规则,并刷新所有活跃 session 的规则快照。
func (s *ChatService) DeletePermissionRule(id string) error {
	if err := s.st.DeletePermissionRule(s.ctx, id); err != nil {
		return err
	}
	s.applyPermissionRulesToAll()
	return nil
}

// ReorderPermissionRules 按传入 id 顺序重写优先级,并刷新所有活跃 session 的规则快照。
func (s *ChatService) ReorderPermissionRules(ids []string) error {
	if err := s.st.ReorderPermissionRules(s.ctx, ids); err != nil {
		return err
	}
	s.applyPermissionRulesToAll()
	return nil
}

// ResetPermissionRules 清空全部规则并重写为默认规则(用户点「恢复默认」)。
func (s *ChatService) ResetPermissionRules() error {
	existing, err := s.st.ListPermissionRules(s.ctx)
	if err != nil {
		return err
	}
	for _, r := range existing {
		if err := s.st.DeletePermissionRule(s.ctx, r.ID); err != nil {
			return err
		}
	}
	if _, err := s.st.SeedDefaultPermissionRules(s.ctx, defaultPermissionRulesForStore()); err != nil {
		return err
	}
	s.applyPermissionRulesToAll()
	return nil
}

// validatePermissionRule 校验规则基本合法(level 必须是 allow/ask/deny)。
// 其余字段允许空(空 = 通配),不在此强约束。
func validatePermissionRule(r store.PermissionRule) error {
	switch r.Level {
	case permissions.LevelAllow, permissions.LevelAsk, permissions.LevelDeny:
		return nil
	default:
		return fmt.Errorf("invalid permission level %q (want allow/ask/deny)", r.Level)
	}
}
