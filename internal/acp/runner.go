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
	"strings"
	"syscall"

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

// Runner 驱动单个 harness(其 stdio ACP server)。model 不在 spawn 注入:
// 统一走 ACP session config option(category=model)+ session/set_config_option。
type Runner struct {
	HarnessCmd []string // 启动命令,如 ["opencode","acp"]
	Env        []string // 额外环境变量
}

// NewRunner 构造 Runner。command 默认 "opencode acp"。
func NewRunner(command string, env map[string]string) *Runner {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		parts = []string{"opencode", "acp"}
	}
	var envList []string
	for k, v := range env {
		envList = append(envList, k+"="+v)
	}
	return &Runner{HarnessCmd: parts, Env: envList}
}

// ChatSession 保持 harness 进程 + ACP session 跨多轮对话。
type ChatSession struct {
	Runner    *Runner
	Cmd       *exec.Cmd
	Conn      *acp.ClientSideConnection
	Handler   *Handler
	SessionID acp.SessionId
	WorkDir   string
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
		Runner: r, Cmd: cmd, Conn: conn, Handler: handler, SessionID: sess.SessionId, WorkDir: workDir,
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
		Runner: r, Cmd: cmd, Conn: conn, Handler: handler, SessionID: acp.SessionId(sessionID), WorkDir: workDir,
		CanListSessions: initResp.AgentCapabilities.SessionCapabilities.List != nil,
		ConfigOptions:   resumeResp.ConfigOptions,
	}
	if cmd.Process != nil {
		registerHarness(cmd.Process.Pid)
	}
	return cs, nil
}

// spawnAndInit 公共前置:spawn harness(独立进程组)→ 建连接 → Initialize。
func (r *Runner) spawnAndInit(ctx context.Context, workDir string, handler *Handler) (*exec.Cmd, *acp.ClientSideConnection, acp.InitializeResponse, error) {
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

// isTerminalToolStatus 判断 tool status 是否终态(completed/failed)。
// 单调状态保护用:终态后不接受回退到 in_progress/pending(§5.4 #10)。
func isTerminalToolStatus(status string) bool {
	return status == "completed" || status == "failed"
}

// Prompt 在已有 session 上发送消息并等待回复(同步返回,期间 SessionUpdate 并发流入)。
// 不设超时:对齐 omp TUI 的设计——turn 跑到自然结束(end_turn / error),
// 靠用户 Stop(走 ctx cancel)+ harness 崩溃检测(peer disconnected)兜底(§3.3)。
// attachments(@提及的文件/目录)经 ACP ContentBlock::ResourceLink 发送(协议 baseline),
// agent 可直接按 file:// URI 访问;文本本身也照常作为 TextBlock 发出。
func (cs *ChatSession) Prompt(ctx context.Context, message string, attachments []Attachment) (acp.StopReason, error) {
	resp, err := cs.Conn.Prompt(ctx, acp.PromptRequest{
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

// SessionTitle 通过 session/list 拉 harness 为本 session 生成的权威标题(§5.4 #14)。
// 协议硬约束:仅当 harness 在 Initialize 声明 session/list 能力时才可调用(session-list.mdx)。
// 与 session_info_update 推送正交:推送由 handleEvent 的 session_info 分支即时处理,
// 这里是主动拉取的兜底。返回空串 = harness 暂无标题或未声明该能力。
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

// IsAlive 报告 harness 进程是否仍存活(供「预热后空闲断连」检测:开 session 时 eager spawn
// 保持连接等首条消息,若用户迟迟不发、opencode 空闲断连 §5.4 #9,进程已退出 → 返回 false,
// 调用方据此拆掉死连接、下次重 spawn,避免把 broken pipe 抛给用户)。
// 用 signal 0 探活(Unix 标准:进程在返 nil,已退出返 ESRCH)。
func (cs *ChatSession) IsAlive() bool {
	if cs.Cmd == nil || cs.Cmd.Process == nil {
		return false
	}
	return cs.Cmd.Process.Signal(syscall.Signal(0)) == nil
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
