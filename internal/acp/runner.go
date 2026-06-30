package acp

// runner.go:Runner 管理 harness 子进程 + ACP 连接的完整生命周期。
// 生命周期(AGENTS.md §1.3):
//
//	spawn harness(独立进程组)→ NewClientSideConnection → Initialize → NewSession(cwd)
//	→ Prompt(同步返回,期间 SessionUpdate 并发流入)→ 判定 StopReasonEndTurn
//	→ kill 进程组 + 注销活跃 + reap 逃逸子进程
//
// ChatSession:持久 session,跨多轮对话复用 harness 进程 + session(支撑 LoadSession 恢复,§1.4)。
// Prompt 用「静默超时」(从最后一次 SessionUpdate 活动算,非总超时)——agent 还在输出就不算超时(§3.3)。

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/acp-go-sdk"
)

// StopReason 透传 SDK 的 StopReason,供 internal/chat 等业务包引用
// (§2.1:internal/acp 是 ACP 唯一封装层,业务包不直接 import SDK)。
type StopReason = acp.StopReason

// Attachment 是随 prompt 发给 agent 的文件/目录引用(@提及)。
// 经 ACP ContentBlock::ResourceLink 发送 —— baseline 能力,所有 agent 必须支持
// (协议:agent MUST support ContentBlock::ResourceLink in prompts)。
// Path 相对 session cwd 或绝对路径;Name 是显示名(空则取 Path 基名)。
type Attachment struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// Runner 驱动单个 harness(opencode acp)。
type Runner struct {
	HarnessCmd []string // 启动命令,如 ["opencode","acp"]
	Env        []string // 额外环境变量
	Model      string   // per-agent model(provider/model 格式,非空时在 workDir 写 opencode.json 注入,§3.5)
}

// NewRunner 构造 Runner。command 默认 "opencode acp"。
func NewRunner(command string, env map[string]string, model string) *Runner {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		parts = []string{"opencode", "acp"}
	}
	var envList []string
	for k, v := range env {
		envList = append(envList, k+"="+v)
	}
	return &Runner{HarnessCmd: parts, Env: envList, Model: model}
}

// WriteModelConfig 在 workDir 写一份 opencode.json(只含 model 字段),规避协议层传 model 被忽略的 bug(§3.5)。
// opencode 启动时按 cwd → 父目录 → global 顺序找 config,我们写的覆盖 global model。
// 只在 model 非空时写;best-effort:写失败只告警不阻塞。
func (r *Runner) WriteModelConfig(workDir string) {
	if r.Model == "" || workDir == "" {
		return
	}
	configPath := workDir + string(os.PathSeparator) + "opencode.json"
	content := `{"$schema":"https://opencode.ai/config.json","model":` + strconv.Quote(r.Model) + "}\n"
	if err := os.WriteFile(configPath, []byte(content), 0o644); err != nil {
		slog.Warn("runner: write opencode.json for per-agent model failed", "dir", workDir, "model", r.Model, "err", err)
	}
}

// ChatSession 保持 harness 进程 + ACP session 跨多轮对话。
type ChatSession struct {
	Runner    *Runner
	Cmd       *exec.Cmd
	Conn      *acp.ClientSideConnection
	Handler   *Handler
	SessionID acp.SessionId
	WorkDir   string
	Model     string
	// CanListSessions:agent 是否声明了 session/list 能力(Initialize 响应的
	// capabilities.session.list)。协议硬约束:未声明时禁止调用 session/list
	// (session-list.mdx:Clients MUST verify this capability before calling)。
	CanListSessions bool
	// ConfigOptions:agent 在 NewSession/LoadSession 响应里自报的 session config options
	// (model/mode/effort)。set_config_option 返回时更新为最新全量。FlatConfigOptions 扁平化给前端。
	ConfigOptions []acp.SessionConfigOption
}

// NewChatSession 创建持久对话 session:spawn harness → initialize → newSession(cwd=workDir)。
// onEvent 接收每条扁平化的 SessionUpdate(→ 前端流式渲染);
// onPermission 接收权限裁决提示(→ 前端弹窗,§3.4)。调用方负责 Close()。
func (r *Runner) NewChatSession(ctx context.Context, workDir string, onEvent func(SessionEvent), onPermission func(PermissionPrompt)) (*ChatSession, error) {
	handler := NewHandler(workDir, onEvent, onPermission, 0)
	cmd, conn, initResp, err := r.spawnAndInit(ctx, workDir, handler)
	if err != nil {
		return nil, err
	}
	sess, err := conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        workDir,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		killProcessGroup(cmd)
		return nil, fmt.Errorf("new session: %w", err)
	}
	slog.Info("chat session created", "sessionId", sess.SessionId, "cwd", workDir, "agent", initResp.AgentInfo.Name)
	cs := &ChatSession{
		Runner: r, Cmd: cmd, Conn: conn, Handler: handler, SessionID: sess.SessionId, WorkDir: workDir, Model: r.Model,
		CanListSessions: initResp.AgentCapabilities.SessionCapabilities.List != nil,
		ConfigOptions:   sess.ConfigOptions,
	}
	if cmd.Process != nil {
		registerHarness(cmd.Process.Pid) // §3.2:注册活跃,reaper 保护其逃逸子进程
	}
	return cs, nil
}

// LoadChatSession 恢复已有 session:spawn harness → initialize → loadSession(resume)(§1.4)。
// 用于应用重启后恢复对话上下文(Cwd 必须匹配原 session)。
func (r *Runner) LoadChatSession(ctx context.Context, workDir, sessionID string, onEvent func(SessionEvent), onPermission func(PermissionPrompt)) (*ChatSession, error) {
	handler := NewHandler(workDir, onEvent, onPermission, 0)
	cmd, conn, initResp, err := r.spawnAndInit(ctx, workDir, handler)
	if err != nil {
		return nil, err
	}
	// 抑制 resume 期间 opencode 重放的历史事件:前端已从 DB 加载历史,
	// 重放会重复显示。临时把 OnEvent 换成 no-op,resume 完再恢复。
	realOnEvent := handler.OnEvent
	handler.OnEvent = func(SessionEvent) {}
	resumeResp, err := conn.ResumeSession(ctx, acp.ResumeSessionRequest{
		SessionId:  acp.SessionId(sessionID),
		Cwd:        workDir,
		McpServers: []acp.McpServer{},
	})
	handler.OnEvent = realOnEvent
	if err != nil {
		killProcessGroup(cmd)
		return nil, fmt.Errorf("load session: %w", err)
	}
	slog.Info("chat session loaded", "sessionId", sessionID, "cwd", workDir)
	cs := &ChatSession{
		Runner: r, Cmd: cmd, Conn: conn, Handler: handler, SessionID: acp.SessionId(sessionID), WorkDir: workDir, Model: r.Model,
		CanListSessions: initResp.AgentCapabilities.SessionCapabilities.List != nil,
		ConfigOptions:   resumeResp.ConfigOptions,
	}
	if cmd.Process != nil {
		registerHarness(cmd.Process.Pid)
	}
	return cs, nil
}

// spawnAndInit 公共前置:写 model config → spawn harness(独立进程组)→ 建连接 → Initialize。
func (r *Runner) spawnAndInit(ctx context.Context, workDir string, handler *Handler) (*exec.Cmd, *acp.ClientSideConnection, acp.InitializeResponse, error) {
	r.WriteModelConfig(workDir) // §3.5
	cmd := exec.CommandContext(ctx, r.HarnessCmd[0], r.HarnessCmd[1:]...)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(), r.Env...)
	cmd.Stderr = os.Stderr
	setProcGroup(cmd) // §3.2:独立进程组

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("start harness: %w", err)
	}
	slog.Info("harness started", "cmd", strings.Join(r.HarnessCmd, " "), "cwd", workDir)

	conn := acp.NewClientSideConnection(handler, stdin, stdout)
	conn.SetLogger(slog.Default())

	initResp, err := conn.Initialize(ctx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			Fs: acp.FileSystemCapabilities{
				ReadTextFile:  true,
				WriteTextFile: true,
			},
		},
	})
	if err != nil {
		killProcessGroup(cmd)
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("initialize: %w", err)
	}
	return cmd, conn, initResp, nil
}

// activityTracker 跟踪一个 prompt turn 的活动状态:最后活动时间 + in_progress tool 计数。
//
// 静默超时判定时,只要还有 tool 处于 in_progress(ToolCallStatus,协议级「正在工作」信号)
// 就不算超时 —— 长 tool 期间即便无 chunk 流入也不误判卡死(AGENTS.md §3.3)。
// 纯静默(无 chunk 且无 in_progress tool)仍按 timeout 兜底,避免 agent 真卡死时永久挂起。
type activityTracker struct {
	lastActivity atomic.Int64
	inProgress   atomic.Int64 // 当前 in_progress 的 tool 数
	mu           sync.Mutex
	toolStatus   map[string]string // callID -> 上次 status(用于正确增减计数)
}

func newActivityTracker() *activityTracker {
	return &activityTracker{toolStatus: map[string]string{}}
}

// observe 收到一条 SessionEvent:刷新活动时间,并维护 in_progress tool 计数。
func (a *activityTracker) observe(e SessionEvent) {
	a.lastActivity.Store(time.Now().UnixNano())
	if (e.Kind != "tool_call" && e.Kind != "tool_call_update") || e.ToolCallID == "" || e.ToolStatus == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	prev := a.toolStatus[e.ToolCallID]
	if prev == e.ToolStatus {
		return
	}
	if prev == "in_progress" {
		a.inProgress.Add(-1)
	}
	if e.ToolStatus == "in_progress" {
		a.inProgress.Add(1)
	}
	a.toolStatus[e.ToolCallID] = e.ToolStatus
}

// timedOut 判定是否静默超时:静默超过 timeout 且无 in_progress tool。
// 有 tool 在 in_progress 时永不超时(协议级「正在工作」信号)。
func (a *activityTracker) timedOut(timeout time.Duration) bool {
	return a.timedOutAt(time.Now(), timeout)
}

// timedOutAt 是 timedOut 的可注入版(now 显式传入,供 shouldCancelTurn 单测):
// 有 in_progress tool 时不超时(§3.3)。
func (a *activityTracker) timedOutAt(now time.Time, timeout time.Duration) bool {
	if a.inProgress.Load() > 0 {
		return false
	}
	return now.Sub(time.Unix(0, a.lastActivity.Load())) > timeout
}

// maxTurnAbsolute 是单轮 Prompt 的绝对墙上时间上限,独立于静默超时与 in_progress 豁免。
// 防止 harness 在某个 in_progress tool 中途死亡(tool 永不到终态)→ 静默超时被永久豁免
// → turn 永久挂起、死 harness 永不拆(变僵尸)(§5.4 #16)。设得足够大以容纳真正长时的
// tool(如大构建/长 bash),仅作兜底。
const maxTurnAbsolute = 15 * time.Minute

// shouldCancelTurn 统一判定静默超时 goroutine 是否应取消本轮,返回原因(""=不取消):
//   - "absolute":elapsed > absolute,一律取消(忽略 in_progress 豁免)——治本 in_progress 挂死;
//   - "idle":静默超时(有 in_progress tool 时不命中,§3.3)。
//
// 抽成纯函数(显式传 now/start)便于单测,无需真定时器。
func (a *activityTracker) shouldCancelTurn(start, now time.Time, silence, absolute time.Duration) string {
	if now.Sub(start) > absolute {
		return "absolute"
	}
	if a.timedOutAt(now, silence) {
		return "idle"
	}
	return ""
}

// Prompt 在已有 session 上发送消息并等待回复(同步返回,期间 SessionUpdate 并发流入)。
// timeout 是「静默超时」(从最后一次活动算)——只要 opencode 还在输出就不超时(§3.3)。
// 有 tool 处于 in_progress 时豁免静默超时(协议级「正在工作」信号,见 activityTracker),
// 避免「长 tool 期间无 chunk」被误判为卡死。返回 StopReason 与可能的错误。
// attachments(@提及的文件/目录)经 ACP ContentBlock::ResourceLink 发送(协议 baseline),
// agent 可直接按 file:// URI 访问;文本本身也照常作为 TextBlock 发出。
// 崩溃表现为含 "peer disconnected" 的错误(§5.4 #2)。
func (cs *ChatSession) Prompt(ctx context.Context, message string, attachments []Attachment, timeout time.Duration) (acp.StopReason, error) {
	act := newActivityTracker()
	act.lastActivity.Store(time.Now().UnixNano())

	wrapped := cs.Handler.OnEvent
	cs.Handler.OnEvent = func(e SessionEvent) {
		act.observe(e)
		if wrapped != nil {
			wrapped(e)
		}
	}
	defer func() { cs.Handler.OnEvent = wrapped }()

	promptCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	if timeout > 0 {
		start := time.Now()
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-promptCtx.Done():
					return
				case <-ticker.C:
				}
				switch act.shouldCancelTurn(start, time.Now(), timeout, maxTurnAbsolute) {
				case "absolute":
					slog.Warn("chat absolute turn timeout", "elapsed", time.Since(start), "inProgress", act.inProgress.Load())
					cancel()
					return
				case "idle":
					slog.Warn("chat idle timeout", "silence", time.Since(time.Unix(0, act.lastActivity.Load())))
					cancel()
					return
				}
				// 诊断:已静默超阈值却未取消,通常是 in_progress tool 豁免(尚未到绝对上限)。
				if d := time.Since(time.Unix(0, act.lastActivity.Load())); d > timeout && act.inProgress.Load() > 0 {
					slog.Debug("chat idle exempt by in_progress tool", "silence", d, "inProgress", act.inProgress.Load())
				}
			}
		}()
	}

	resp, err := cs.Conn.Prompt(promptCtx, acp.PromptRequest{
		SessionId: cs.SessionID,
		Prompt:    buildPromptBlocks(message, attachments, cs.WorkDir),
	})
	if err != nil {
		return "", fmt.Errorf("prompt: %w", err)
	}
	return resp.StopReason, nil
}

// buildPromptBlocks 构造 session/prompt 的 ContentBlock 序列:
// 首块是文本(用户输入),其后每个 attachment 一个 ResourceLink(file:// URI)。
// ResourceLink 是协议 baseline(agent MUST support),无需探测 promptCapabilities。
func buildPromptBlocks(message string, attachments []Attachment, workDir string) []acp.ContentBlock {
	blocks := []acp.ContentBlock{acp.TextBlock(message)}
	for _, a := range attachments {
		name := a.Name
		if name == "" {
			name = filepath.Base(a.Path)
		}
		blocks = append(blocks, acp.ResourceLinkBlock(name, fileURI(workDir, a.Path)))
	}
	return blocks
}

// fileURI 把(可能相对 workDir 的)路径转成 file:// 绝对 URI,供 agent 按协议访问。
func fileURI(workDir, path string) string {
	p := filepath.FromSlash(path)
	if !filepath.IsAbs(p) {
		p = filepath.Join(workDir, p)
	}
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	return "file://" + p
}

// RespondPermission 透传给 handler(前端用户裁决权限请求,§3.4)。
func (cs *ChatSession) RespondPermission(id, optionID string) bool {
	return cs.Handler.RespondPermission(id, optionID)
}

// SessionTitle 通过 session/list 取 opencode 为本 session 生成的权威标题(§5.4 #14)。
// opencode 实证不发 session_info_update 通知,但会把它生成的标题写进自身库并通过
// session/list 的 SessionInfo.Title 暴露。返回空串 = 暂无标题或 session/list 不可用。
func (cs *ChatSession) SessionTitle(ctx context.Context) (string, error) {
	if !cs.CanListSessions {
		// 协议硬约束:agent 未声明 session/list 能力时禁止调用(session-list.mdx)。
		return "", nil
	}
	lr, err := cs.Conn.ListSessions(ctx, acp.ListSessionsRequest{})
	if err != nil {
		return "", err
	}
	for _, s := range lr.Sessions {
		if s.SessionId == cs.SessionID && s.Title != nil {
			return *s.Title, nil
		}
	}
	return "", nil
}

// FlatConfigOptions 返回扁平化的 config options(给前端渲染下拉:model/mode/effort)。
func (cs *ChatSession) FlatConfigOptions() []ConfigOption {
	return FlattenConfigOptions(cs.ConfigOptions)
}

// SetConfigOption 切换某个 config option(model/mode/effort),热切、同 session 即时生效。
// 成功后更新 cs.ConfigOptions 为 agent 返回的最新全量。configId 如 "model"/"mode"/"effort"。
func (cs *ChatSession) SetConfigOption(ctx context.Context, configId, value string) error {
	resp, err := cs.Conn.SetSessionConfigOption(ctx, acp.SetSessionConfigOptionRequest{
		ValueId: &acp.SetSessionConfigOptionValueId{
			SessionId: cs.SessionID,
			ConfigId:  acp.SessionConfigId(configId),
			Value:     acp.SessionConfigValueId(value),
		},
	})
	if err != nil {
		return err
	}
	cs.ConfigOptions = resp.ConfigOptions
	return nil
}

// Close 销毁 session:kill 整个 harness 进程组 + 注销活跃(§3.2)。
func (cs *ChatSession) Close() {
	pgid := 0
	if cs.Cmd != nil && cs.Cmd.Process != nil {
		pgid = cs.Cmd.Process.Pid
	}
	killProcessGroup(cs.Cmd)
	if pgid != 0 {
		// 只注销活跃 + 杀本组。reap 由调用方在「无其他活跃 session」时做:
		// 多 session 并发时,reap 会误杀其他活跃 session 的逃逸 worker(RAK reaper 假设单 harness)。
		unregisterHarness(pgid)
	}
}

// IsPeerDisconnected 判断错误是否为 harness 进程崩溃/断开(§5.4 #2)。
//
// 两类等价信号,根因相同(harness 进程已不在,须拆连接、下次 LoadSession 重连):
//   - "peer disconnected":SDK 在 peer 消失时返回(§5.4 #2/#9/#11)。
//   - "broken pipe":本地写已关闭的 harness stdin 管道失败的 OS 错误;SDK 经 toReqErr
//     包成 *RequestError{-32603,"Internal error",data:{error:"write |1: broken pipe"}}
//     (见 acp-go-sdk errors.go),message 里只有 "Internal error",信号埋在 data,
//     旧实现只查 re.Message 故漏判 → 死 harness 不拆、session 卡死、裸 JSON 推前端。
//
// err.Error() 已把 Message+Data marshal 成完整 JSON 字符串(RequestError.Error,同 SDK),
// 故一次大小写不敏感的子串匹配即可同时命中两类,不必拆字段。
func IsPeerDisconnected(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "peer disconnected") ||
		strings.Contains(s, "broken pipe")
}
