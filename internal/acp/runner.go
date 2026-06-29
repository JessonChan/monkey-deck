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
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/acp-go-sdk"
)

// StopReason 透传 SDK 的 StopReason,供 internal/chat 等业务包引用
//(§2.1:internal/acp 是 ACP 唯一封装层,业务包不直接 import SDK)。
type StopReason = acp.StopReason

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
	_, err = conn.ResumeSession(ctx, acp.ResumeSessionRequest{
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

// Prompt 在已有 session 上发送消息并等待回复(同步返回,期间 SessionUpdate 并发流入)。
// timeout 是「静默超时」(从最后一次活动算)——只要 opencode 还在输出就不超时(§3.3)。
// 返回 StopReason 与可能的错误。崩溃表现为含 "peer disconnected" 的错误(§5.4 #2)。
func (cs *ChatSession) Prompt(ctx context.Context, message string, timeout time.Duration) (acp.StopReason, error) {
	// 用静默超时:每次 OnEvent 回调更新 lastActivity,watchdog 检测静默。
	var lastActivity atomic.Int64
	lastActivity.Store(time.Now().UnixNano())

	wrapped := cs.Handler.OnEvent
	cs.Handler.OnEvent = func(e SessionEvent) {
		lastActivity.Store(time.Now().UnixNano())
		if wrapped != nil {
			wrapped(e)
		}
	}
	defer func() { cs.Handler.OnEvent = wrapped }()

	promptCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	if timeout > 0 {
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-promptCtx.Done():
					return
				case <-ticker.C:
					idle := time.Since(time.Unix(0, lastActivity.Load()))
					if idle > timeout {
						slog.Warn("chat idle timeout", "silence", idle)
						cancel()
						return
					}
				}
			}
		}()
	}

	resp, err := cs.Conn.Prompt(promptCtx, acp.PromptRequest{
		SessionId: cs.SessionID,
		Prompt:    []acp.ContentBlock{acp.TextBlock(message)},
	})
	if err != nil {
		return "", fmt.Errorf("prompt: %w", err)
	}
	return resp.StopReason, nil
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
func IsPeerDisconnected(err error) bool {
	if err == nil {
		return false
	}
	if re, ok := err.(*acp.RequestError); ok {
		return strings.Contains(re.Message, "peer disconnected")
	}
	return strings.Contains(err.Error(), "peer disconnected")
}
