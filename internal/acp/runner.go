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

	"github.com/coder/acp-go-sdk"
	"github.com/jessonchan/monkey-deck/internal/permissions"
)

// StopReason 透传 SDK 的 StopReason,供 internal/chat 等业务包引用
// (§2.1:internal/acp 是 ACP 唯一封装层,业务包不直接 import SDK)。
type StopReason = acp.StopReason

// Attachment 是随 prompt 发给 agent 的引用(@提及 / 回形针文件 / 内联图片)。
// 默认经 ACP ContentBlock::ResourceLink 发送 —— baseline 能力,所有 agent 必须支持
// (协议:agent MUST support ContentBlock::ResourceLink in prompts)。
// Path 相对 session cwd 或绝对路径;Name 是显示名(空则取 Path 基名)。
//
// Data 非空时改发 ContentBlock::Image(内联 base64 图片)—— 需 agent 声明 image prompt
// 能力(Initialize 响应的 promptCapabilities.image)。Data 与 Path 互斥:Data 优先。
type Attachment struct {
	Path string `json:"path,omitempty"`
	Name string `json:"name"`
	// Data:base64 编码的内联图片数据(设置时发 Image 块,需 image 能力)。
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
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
	Conn      *acp.ClientSideConnection
	Handler   *Handler
	SessionID acp.SessionId
	WorkDir   string
	// proc:harness 子进程生命周期单主(独占 cmd.Wait)+ 结构化 exit 根因日志。
	// 由 spawnAndInit 创建;Close 经 proc.shutdown() 主动关停(标记 expected)。
	proc *harnessProcess
	// stderr:harness stderr 的环形缓冲捕获;崩溃时其尾部拼进 exit 根因日志(stderr.go)。
	stderr *stderrRing
	// CanListSessions:agent 是否声明了 session/list 能力(Initialize 响应的
	// capabilities.session.list)。协议硬约束:未声明时禁止调用 session/list
	// (session-list.mdx:Clients MUST verify this capability before calling)。
	CanListSessions bool
	// ConfigOptions:agent 在 NewSession/LoadSession 响应里自报的 session config options
	// (model/mode/effort)。set_config_option 返回时更新为最新全量。FlatConfigOptions 扁平化给前端。
	ConfigOptions []acp.SessionConfigOption
	// PromptCapabilities:agent 在 Initialize 响应里声明的 prompt 能力(image/audio/embedded)。
	// 用于能力门控:前端据此决定是否展示图片输入入口(image=false 时隐藏/禁用,§3.5)。
	PromptCapabilities acp.PromptCapabilities
}

// NewChatSession 创建持久对话 session:spawn harness → initialize → newSession(cwd=workDir)。
// onEvent 接收每条扁平化的 SessionUpdate(→ 前端流式渲染);
// onPermission 接收权限裁决提示(→ 前端弹窗,§3.4)。调用方负责 Close()。
func (r *Runner) NewChatSession(ctx context.Context, workDir string, onEvent func(SessionEvent), onPermission func(PermissionPrompt)) (*ChatSession, error) {
	handler := NewHandler(workDir, onEvent, onPermission, 0)
	proc, conn, initResp, err := r.spawnAndInit(ctx, workDir, handler)
	if err != nil {
		return nil, err
	}
	sess, err := conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        workDir,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		proc.shutdown()
		return nil, fmt.Errorf("new session: %w", err)
	}
	slog.Info("chat session created", "sessionId", sess.SessionId, "cwd", workDir, "agent", initResp.AgentInfo.Name)
	cs := &ChatSession{
		Runner: r, proc: proc, Conn: conn, Handler: handler, SessionID: sess.SessionId, WorkDir: workDir,
		CanListSessions:    initResp.AgentCapabilities.SessionCapabilities.List != nil,
		ConfigOptions:      sess.ConfigOptions,
		PromptCapabilities: initResp.AgentCapabilities.PromptCapabilities,
	}
	registerHarness(proc.pgid) // §3.2:注册活跃,reaper 保护其逃逸子进程
	return cs, nil
}

// LoadChatSession 恢复已有 session:spawn harness → initialize → loadSession(resume)(§1.4)。
// 用于应用重启后恢复对话上下文(Cwd 必须匹配原 session)。
func (r *Runner) LoadChatSession(ctx context.Context, workDir, sessionID string, onEvent func(SessionEvent), onPermission func(PermissionPrompt)) (*ChatSession, error) {
	handler := NewHandler(workDir, onEvent, onPermission, 0)
	proc, conn, initResp, err := r.spawnAndInit(ctx, workDir, handler)
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
		proc.shutdown()
		return nil, fmt.Errorf("load session: %w", err)
	}
	slog.Info("chat session loaded", "sessionId", sessionID, "cwd", workDir)
	cs := &ChatSession{
		Runner: r, proc: proc, Conn: conn, Handler: handler, SessionID: acp.SessionId(sessionID), WorkDir: workDir,
		CanListSessions:    initResp.AgentCapabilities.SessionCapabilities.List != nil,
		ConfigOptions:      resumeResp.ConfigOptions,
		PromptCapabilities: initResp.AgentCapabilities.PromptCapabilities,
	}
	registerHarness(proc.pgid)
	return cs, nil
}

// spawnAndInit 公共前置:spawn harness(独立进程组)→ 建连接 → Initialize。
// 返回 harnessProcess(独占 cmd.Wait + exit 根因日志,见 proc.go)+ stderr ring。
// 失败时已 shutdown(回收进程组);调用方无需再清理。
func (r *Runner) spawnAndInit(ctx context.Context, workDir string, handler *Handler) (*harnessProcess, *acp.ClientSideConnection, acp.InitializeResponse, error) {
	cmd := exec.CommandContext(ctx, r.HarnessCmd[0], r.HarnessCmd[1:]...)
	cmd.Dir = workDir
	cmd.Env = append(os.Environ(), r.Env...)
	// stderr → 环形缓冲(根因日志素材)+ tee 到 os.Stderr(保留 dev 模式实时看 harness 日志的既有行为)。
	stderr := newStderrRing(os.Stderr)
	cmd.Stderr = stderr
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

	// cmd 已 Start:交给 harnessProcess 独占 Wait(单一 reap,杜绝双 Wait 竞态)。
	proc := newHarnessProcess(cmd, strings.Join(r.HarnessCmd, " "), stderr)

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
		proc.shutdown()
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("initialize: %w", err)
	}
	return proc, conn, initResp, nil
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
	// PromptResponse.Usage 带 token 明细(CachedRead/Write/Input/Output/Total,UNSTABLE,§1.6)。
	// SDK 注释这些字段已是 session 级累积值,直接覆盖。streaming UsageUpdate 只有 used/size/cost,
	// 明细只能在此取;多数 harness 不回填(resp.Usage == nil)则无操作。
	if resp.Usage != nil {
		cs.Handler.EmitTurnUsage(string(cs.SessionID), resp.Usage)
	}
	return resp.StopReason, nil
}

// buildPromptBlocks 构造 session/prompt 的 ContentBlock 序列:
// 首块是文本(用户输入),其后每个 attachment 一个块:
//   - Data 非空 → ContentBlock::Image(内联 base64 图片,需 image 能力,§3.5)
//   - 否则 → ContentBlock::ResourceLink(file:// URI,协议 baseline,所有 agent MUST support)
func buildPromptBlocks(message string, attachments []Attachment, workDir string) []acp.ContentBlock {
	blocks := []acp.ContentBlock{acp.TextBlock(message)}
	for _, a := range attachments {
		if a.Data != "" {
			mt := a.MimeType
			if mt == "" {
				mt = "image/png" // 兜底 mime:前端未给则按 png(粘贴图片常见)
			}
			blocks = append(blocks, acp.ImageBlock(a.Data, mt))
			continue
		}
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

// SetPermissionRules 更新该 session 的分级权限规则快照(§3.4)。透传给 handler。
func (cs *ChatSession) SetPermissionRules(rules []permissions.Rule) {
	cs.Handler.SetPermissionRules(rules)
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

// SupportsImage 报告 agent 是否声明了 image prompt 能力(Initialize 响应的
// promptCapabilities.image)。前端据此门控图片输入入口:不支持则隐藏/禁用 + 提示。
// 协议:ContentBlock::Image in prompts REQUIRES 'image' prompt capability。
func (cs *ChatSession) SupportsImage() bool {
	return cs.PromptCapabilities.Image
}

// RefreshConfig 重新拉取最新 configOptions + prompt capabilities(同步外部配置改动)。
//
// 用途:用户在 harness 自己的配置(如 opencode config)外部改动了 provider/model 列表
// (加了新模型 / 新 provider),当前活跃 session 的 harness 进程是改动前 spawn 的,内存里
// 的 ConfigOptions 已过期。点「刷新」让模型下拉看到新选项。
//
// ACP 协议没有「重新拉 configOptions」的标准方法(configOptions 只在 NewSession/LoadSession/
// set_config_option 响应 + config_option_update 通知里出现)。唯一能拿到最新配置的路径是
// 新 spawn 一个 harness:新进程会读最新 harness 配置 → NewSession 响应带最新 configOptions。
//
// 实现为「probe harness」:用当前 session 的 cwd + 同一 harness 命令临时 spawn 一个独立
// harness(独立进程组),Initialize + NewSession 拿到最新 configOptions,然后立即
// CloseSession(清理 harness 持久化的 session 记录)+ kill 进程组回收。
// probe 完全独立:不影响当前活跃连接、不中断进行中的对话流。
//
// 成功后覆盖 cs.ConfigOptions / cs.PromptCapabilities 为最新全量,返回扁平化结果。
func (cs *ChatSession) RefreshConfig(ctx context.Context) ([]ConfigOption, error) {
	handler := NewHandler(cs.WorkDir, func(SessionEvent) {}, func(PermissionPrompt) {}, 0)
	proc, conn, initResp, err := cs.Runner.spawnAndInit(ctx, cs.WorkDir, handler)
	if err != nil {
		return nil, fmt.Errorf("refresh config: spawn probe: %w", err)
	}
	// probe 拿到结果或出错都要 shutdown 回收进程组(防泄漏,§3.2)。
	defer proc.shutdown()
	sess, err := conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        cs.WorkDir,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		return nil, fmt.Errorf("refresh config: probe new session: %w", err)
	}
	// 清理 probe 创建的 session:harness 可能持久化 session 记录,CloseSession 收尾。
	// 失败不致命(harness 可能已随 kill 退出),忽略错误。
	_, _ = conn.CloseSession(ctx, acp.CloseSessionRequest{SessionId: sess.SessionId})
	cs.ConfigOptions = sess.ConfigOptions
	cs.PromptCapabilities = initResp.AgentCapabilities.PromptCapabilities
	slog.Info("refreshed config options", "sessionId", cs.SessionID, "cwd", cs.WorkDir, "options", len(cs.ConfigOptions))
	return FlattenConfigOptions(cs.ConfigOptions), nil
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
	if cs.proc != nil {
		pgid = cs.proc.pgid
		cs.proc.shutdown() // 标记 expected → 信号整组 → 等 watcher reap 落定
	}
	if pgid != 0 {
		// 只注销活跃。reap 由调用方在「无其他活跃 session」时做:
		// 多 session 并发时,reap 会误杀其他活跃 session 的逃逸 worker(RAK reaper 假设单 harness)。
		unregisterHarness(pgid)
	}
}

// IsAlive 报告 harness 进程是否仍存活(供「预热后空闲断连」检测:开 session 时 eager spawn
// 保持连接等首条消息,若用户迟迟不发、opencode 空闲断连 §5.4 #9,进程已退出 → 返回 false,
// 调用方据此拆掉死连接、下次重 spawn,避免把 broken pipe 抛给用户)。
func (cs *ChatSession) IsAlive() bool {
	if cs.proc == nil {
		return false
	}
	return cs.proc.IsAlive()
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
