package acp

// runner.go:Runner 管理 harness 子进程 + ACP 连接的完整生命周期。
// 生命周期(AGENTS.md §1.3):
//
//	spawn harness(独立进程组)→ NewClientSideConnection → Initialize → NewSession(cwd)
//	→ Prompt(同步返回,期间 SessionUpdate 并发流入)→ 判定 StopReasonEndTurn
//	→ kill 进程组 + 注销活跃 + reap 逃逸子进程
//
// ChatSession: persistent session, reuses the harness process + session across turns (supports Resume recovery, §1.4).
// Prompt 用「静默超时」(从最后一次 SessionUpdate 活动算,非总超时)——agent 还在输出就不算超时(§3.3)。

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/coder/acp-go-sdk"
	"github.com/jessonchan/monkey-deck/internal/mcp"
	"github.com/jessonchan/monkey-deck/internal/permissions"
	"github.com/jessonchan/monkey-deck/internal/shellenv"
	"github.com/jessonchan/monkey-deck/internal/store"
)

// maxListPages:session/list 分页拉取的页数上限(防 misbehaving peer 永远返回非空 cursor
// 致死循环,peer 不可全信)。每页 ~50-100 条,100 页覆盖万级 session,远超任何单项目。
const maxListPages = 100

// StopReason 透传 SDK 的 StopReason,供 internal/chat 等业务包引用
// (§2.1:internal/acp 是 ACP 唯一封装层,业务包不直接 import SDK)。
type StopReason = acp.StopReason

// StopReasonEndTurn 透传 SDK 常量:agent 自然完成一轮(internal/chat 据此判定 turn 是否正常结束)。
const StopReasonEndTurn = acp.StopReasonEndTurn

// Attachment 是随 prompt 发给 agent 的引用(@提及 / 回形针文件 / 内联图片 / 音频 / 内联资源)。
//
// Kind 决定发出的 ContentBlock 类型(baseline 之外的能力需 agent 声明对应 prompt 能力,§3.5):
//   - "" / "file" → ContentBlock::ResourceLink(file:// URI,协议 baseline,所有 agent MUST support)
//   - "image"     → ContentBlock::Image(内联 base64,需 image 能力)
//   - "audio"     → ContentBlock::Audio(内联 base64,需 audio 能力)
//   - "resource"  → ContentBlock::Resource(内联文本/二进制,需 embeddedContext 能力)
//
// 兼容旧调用:Kind 空且 Data 非空时按 image 处理(buildPromptBlocks 兜底,历史粘贴图片路径)。
// 能力门控由前端依 SupportsImage/SupportsAudio/SupportsEmbeddedContext 决定,buildPromptBlocks
// 只管按 Kind 构造(与 image 既有行为一致:构造不门控,门控在调用方)。
type Attachment struct {
	Kind string `json:"kind,omitempty"`
	Name string `json:"name"`
	// Path:文件/目录路径(相对 session cwd 或绝对)。用于 ResourceLink 与 Resource 的 URI 兜底。
	Path string `json:"path,omitempty"`
	// Data:base64 编码的内联二进制数据。image/audio 的载体;resource 的 Blob 变体也用此字段。
	Data string `json:"data,omitempty"`
	// MimeType:Data/Text 的 MIME 类型(建议填写;image 默认 image/png,audio 默认 audio/wav)。
	MimeType string `json:"mimeType,omitempty"`
	// Text:resource 的内联文本内容(TextResourceContents 变体)。设置时优先于 Data。
	Text string `json:"text,omitempty"`
	// URI:resource 的标识 URI(可选)。空则按 Path(file:// 形式)或 Name(urn: 形式)兜底。
	URI string `json:"uri,omitempty"`
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
// onPermission 接收权限裁决提示(→ 前端弹窗,§3.4);
// onElicitation 接收 elicitation 提示(→ 前端弹窗,ACP v1 标准协议)。调用方负责 Close()。
//
// mcps 是该 session 选中的 MCP server(catalog 子集);按 Initialize 协商的 mcpCapability
// 转成 ACP 线格式注入 session/new。stdio 免协商,http/sse 不被支持则丢弃并告警。严格 harness
// (如 OMP)任一 server 连接失败会让 NewSession 整个失败——上层据此在 NewSessionModal 原样展示
// 报错,用户取消勾选可疑 server 后重试(本次不选,catalog 不动)。
func (r *Runner) NewChatSession(ctx context.Context, workDir string, mcps []store.McpServer, onEvent func(SessionEvent), onPermission func(PermissionPrompt), onElicitation func(ElicitationPrompt)) (*ChatSession, error) {
	handler := NewHandler(workDir, onEvent, onPermission, onElicitation, 0)
	proc, conn, initResp, err := r.spawnAndInit(ctx, workDir, handler)
	if err != nil {
		return nil, err
	}
	acpServers, skipped := mcp.ToAcpServers(mcps, initResp.AgentCapabilities.McpCapabilities)
	if len(skipped) > 0 {
		slog.Warn("mcp servers skipped (transport unsupported by harness)", "cwd", workDir, "skipped", skipped)
	}
	sess, err := conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        workDir,
		McpServers: acpServers,
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

// ResumeChatSession resumes an existing session: spawn harness → initialize → session/resume (§1.4).
// Used to restore conversation context after app restart (Cwd must match the original session).
func (r *Runner) ResumeChatSession(ctx context.Context, workDir, sessionID string, mcps []store.McpServer, onEvent func(SessionEvent), onPermission func(PermissionPrompt), onElicitation func(ElicitationPrompt)) (*ChatSession, error) {
	handler := NewHandler(workDir, onEvent, onPermission, onElicitation, 0)
	proc, conn, initResp, err := r.spawnAndInit(ctx, workDir, handler)
	if err != nil {
		return nil, err
	}
	// Protocol MUST: verify session/resume capability before calling it
	// (session-setup.mdx — Clients MUST check sessionCapabilities.resume, MUST NOT call otherwise).
	if initResp.AgentCapabilities.SessionCapabilities.Resume == nil {
		proc.shutdown()
		return nil, fmt.Errorf("resume session: harness does not advertise sessionCapabilities.resume")
	}
	// 抑制 resume 期间 harness 重放的历史消息/工具/plan 事件:前端已从 DB 加载历史,重放会重复显示。
	// 但不能 blanket 吞——available_commands 是会话级元数据(不在 load 响应里、也不入库),opencode 在
	// load 响应*之前*发它(service.ts sendAvailableCommands 在 return 前),会落在 ResumeSession 阻塞窗口
	// 里被吞掉、永久丢失。故只抑制历史重放,放行元数据(available_commands / config_option 等)。
	realOnEvent := handler.OnEvent
	handler.OnEvent = func(e SessionEvent) {
		switch e.Kind {
		case "agent_message_chunk", "agent_thought_chunk", "user_message_chunk",
			"tool_call", "tool_call_update", "plan", "plan_update", "plan_removed":
			return // 历史重放:前端已从 DB 加载,丢弃
		}
		realOnEvent(e) // 会话级元数据:放行
	}
	acpServers, skipped := mcp.ToAcpServers(mcps, initResp.AgentCapabilities.McpCapabilities)
	if len(skipped) > 0 {
		slog.Warn("mcp servers skipped (transport unsupported by harness)", "cwd", workDir, "skipped", skipped)
	}
	resumeResp, err := conn.ResumeSession(ctx, acp.ResumeSessionRequest{
		SessionId:  acp.SessionId(sessionID),
		Cwd:        workDir,
		McpServers: acpServers,
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
	// Ensure PATH includes the user's login-shell dirs before resolving the
	// harness binary. Fixes Finder/Dock double-click launch (launchd gives a
	// minimal PATH that misses ~/.bun/bin etc.); idempotent per process, so this
	// is a fast no-op if the Discover path already resolved it (§5.4 #17).
	_ = shellenv.Resolve(ctx)
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
		// ErrNotFound = binary not on PATH (exec.Command's internal LookPath failed).
		// Surface a human-readable message instead of a raw technical error (§4.4:
		// never expose raw technical format to users). The session record stays in
		// the DB, so the user can install the harness later and resume (§1.4).
		if errors.Is(err, exec.ErrNotFound) {
			return nil, nil, acp.InitializeResponse{}, fmt.Errorf(
				"找不到 %s 命令,请确认该 harness 已安装(或已在终端用 `open` 启动本应用)。错误: %w",
				r.HarnessCmd[0], err)
		}
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("start harness: %w", err)
	}
	slog.Info("harness started", "cmd", strings.Join(r.HarnessCmd, " "), "cwd", workDir)

	// cmd 已 Start:交给 harnessProcess 独占 Wait(单一 reap,杜绝双 Wait 竞态)。
	proc := newHarnessProcess(cmd, strings.Join(r.HarnessCmd, " "), stderr)

	// RESUME_PATCH(临时兜底,见 resume_patch.go):补 SDK 的 ResumeSessionRequest.McpServers
	// omitempty bug —— 出站 session/resume 帧缺 mcpServers 时在此补回。上游修后删此包装。
	conn := acp.NewClientSideConnection(handler, newResumePatchWriter(stdin), stdout)
	conn.SetLogger(slog.Default())

	initResp, err := conn.Initialize(ctx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			Fs: acp.FileSystemCapabilities{
				ReadTextFile:  true,
				WriteTextFile: true,
			},
			// Elicitation(ACP v1 标准协议,SDK 标 UNSTABLE):声明 form 能力,让 harness(如 omp)
			// 把 interactive 命令(/review 选模式、/fast 确认)桥接成 elicitation/create → 前端弹窗。
			// 不声明时 omp 的 select/confirm/input 返 undefined → 命令静默空(§5.4 #12)。
			Elicitation: &acp.ElicitationCapabilities{
				Form: &acp.ElicitationFormCapabilities{},
			},
		},
	})
	if err != nil {
		proc.shutdown()
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("initialize: %w", err)
	}
	// Protocol version negotiation (initialization.mdx: client SHOULD close if the agent
	// returns an unsupported version). We only implement v1; bail on mismatch instead of
	// proceeding against an unknown version and corrupting the session.
	if initResp.ProtocolVersion != acp.ProtocolVersionNumber {
		proc.shutdown()
		return nil, nil, acp.InitializeResponse{}, fmt.Errorf("initialize: protocol version mismatch: client=%d agent=%d", acp.ProtocolVersionNumber, initResp.ProtocolVersion)
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
// 首块恒为 TextBlock(用户输入);其后每个 attachment 一个块,Kind 决定块类型:
//   - "image"    → ContentBlock::Image(内联 base64,需 image 能力,§3.5)
//   - "audio"    → ContentBlock::Audio(内联 base64,需 audio 能力)
//   - "resource" → ContentBlock::Resource(内联文本/二进制,需 embeddedContext 能力)
//   - 其它/""    → ContentBlock::ResourceLink(file:// URI,协议 baseline,所有 agent MUST support)
//
// 兼容旧调用:Kind 空且 Data 非空时按 image 处理(历史粘贴图片路径,Data!= "" 即图片)。
func buildPromptBlocks(message string, attachments []Attachment, workDir string) []acp.ContentBlock {
	blocks := []acp.ContentBlock{acp.TextBlock(message)}
	for _, a := range attachments {
		blocks = append(blocks, attachmentBlock(a, workDir))
	}
	return blocks
}

// attachmentBlock 按 Attachment.Kind 构造单个 ContentBlock。
func attachmentBlock(a Attachment, workDir string) acp.ContentBlock {
	kind := a.Kind
	if kind == "" && a.Data != "" {
		kind = "image" // 兼容旧路径:未声明 Kind 但有 Data → 图片
	}
	switch kind {
	case "image":
		mt := a.MimeType
		if mt == "" {
			mt = "image/png" // 兜底 mime:前端未给则按 png(粘贴图片常见)
		}
		return acp.ImageBlock(a.Data, mt)
	case "audio":
		mt := a.MimeType
		if mt == "" {
			mt = "audio/wav" // 兜底 mime:前端未给则按 wav(录音常见)
		}
		return acp.AudioBlock(a.Data, mt)
	case "resource":
		return acp.ResourceBlock(buildEmbeddedResource(a, workDir))
	default: // "" / "file" / 未知 → baseline ResourceLink
		name := a.Name
		if name == "" {
			name = filepath.Base(a.Path)
		}
		return acp.ResourceLinkBlock(name, fileURI(workDir, a.Path))
	}
}

// buildEmbeddedResource 构造 ContentBlock::Resource 的 EmbeddedResourceResource:
//   - Text 非空 → TextResourceContents(内联文本,mimeType 可选)
//   - 否则 → BlobResourceContents(base64 blob,取自 Data)
//
// URI 来自 a.URI;空则按 Path 的 file:// 形式(workDir 兜底相对路径);都没有则用 Name 生成 urn。
func buildEmbeddedResource(a Attachment, workDir string) acp.EmbeddedResourceResource {
	uri := a.URI
	if uri == "" {
		switch {
		case a.Path != "":
			uri = fileURI(workDir, a.Path)
		case a.Name != "":
			uri = "urn:monkey-deck:" + a.Name
		}
	}
	var mt *string
	if a.MimeType != "" {
		s := a.MimeType
		mt = &s
	}
	if a.Text != "" {
		return acp.EmbeddedResourceResource{TextResourceContents: &acp.TextResourceContents{
			Text:     a.Text,
			Uri:      uri,
			MimeType: mt,
		}}
	}
	return acp.EmbeddedResourceResource{BlobResourceContents: &acp.BlobResourceContents{
		Blob:     a.Data,
		Uri:      uri,
		MimeType: mt,
	}}
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

// RespondElicitation 透传给 handler(前端用户响应 elicitation 提示,ACP v1 标准协议)。
func (cs *ChatSession) RespondElicitation(id string, resp ElicitationResponse) bool {
	return cs.Handler.RespondElicitation(id, resp)
}

// ElicitDeclined 报告本次 turn 期间用户是否主动 decline 过 elicitation(Skip)。
// runPrompt 的 empty-turn 检测据此区分「用户主动跳过导致的空 turn」(静默)与「真异常空 turn」(提示)。
func (cs *ChatSession) ElicitDeclined() bool {
	return cs.Handler.elicitDeclined.Load()
}

// ResetElicitDeclined 清除 decline 标志(新 turn 开始时调,保证只反映当前 turn)。
func (cs *ChatSession) ResetElicitDeclined() {
	cs.Handler.elicitDeclined.Store(false)
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
	// listOnePage 注入 session/list 单页拉取(便于单测注入 mock,§5.1):按 cwd 过滤 + cursor 分页。
	listOnePage := func(ctx context.Context, cwd string, cursor *string) ([]acp.SessionInfo, *string, error) {
		lr, err := cs.Conn.ListSessions(ctx, acp.ListSessionsRequest{Cwd: &cwd, Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		return lr.Sessions, lr.NextCursor, nil
	}
	return findSessionTitle(ctx, listOnePage, cs.WorkDir, cs.SessionID)
}

// sessionLister 抽象 session/list 的单页拉取,便于 findSessionTitle 单测注入 mock(§5.1)。
// 返回本页 session 列表 + 下一页 cursor(nil/空 = 无更多页)。
type sessionLister func(ctx context.Context, cwd string, cursor *string) ([]acp.SessionInfo, *string, error)

// findSessionTitle 在 harness 的 session 列表里按 sessionId 找 harness 生成的权威标题。
//
// 设计依据(探针确认,Task #22117):
//   - 协议支持 cwd 过滤 + cursor 分页(ListSessionsRequest.{Cwd,Cursor} / NextCursor)。
//   - OMP/opencode 实测均支持 cwd 过滤:全量首页 50/100 条(跨所有项目,OMP 还分页)→
//     按 cwd 过滤后只剩本项目 2/3 条,NextCursor=nil。旧实现无过滤拉首页,目标 session
//     仅因「最新」侥幸落在首页;切项目 / 续旧 session 时极易被挤出首页 → 静默漏抓标题。
//   - 每个 session 的 cwd = 其项目目录 / worktree(§1.4),目标 session 必在 cwd 过滤集里。
//
// 不变量(§5.3):按协议主键 sessionId 归并,不猜边界。逐页跟进 NextCursor 直到命中或耗尽;
// maxListPages 防止 misbehaving peer 永远返回非空 cursor 致死循环(peer 不可全信)。
func findSessionTitle(ctx context.Context, list sessionLister, cwd string, sid acp.SessionId) (string, error) {
	var cursor *string
	for page := 0; page < maxListPages; page++ {
		sessions, next, err := list(ctx, cwd, cursor)
		if err != nil {
			return "", err
		}
		for _, s := range sessions {
			if s.SessionId == sid && s.Title != nil {
				return *s.Title, nil
			}
		}
		if next == nil || *next == "" {
			return "", nil
		}
		cursor = next
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

// SupportsAudio 报告 agent 是否声明了 audio prompt 能力(Initialize 响应的
// promptCapabilities.audio)。前端据此门控音频输入入口:不支持则隐藏/禁用 + 提示。
// 协议:ContentBlock::Audio in prompts REQUIRES 'audio' prompt capability。
func (cs *ChatSession) SupportsAudio() bool {
	return cs.PromptCapabilities.Audio
}

// SupportsEmbeddedContext 报告 agent 是否声明了 embeddedContext prompt 能力(Initialize 响应的
// promptCapabilities.embeddedContext)。前端据此决定附件是否可内联(ContentBlock::Resource)发送 ——
// 内联可省去 agent 读盘往返,协议推荐优先(when available, ContentBlock::Resource is preferred)。
// 不支持时回退 ResourceLink(协议 baseline)。协议:ContentBlock::Resource REQUIRES 'embeddedContext'。
func (cs *ChatSession) SupportsEmbeddedContext() bool {
	return cs.PromptCapabilities.EmbeddedContext
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
	handler := NewHandler(cs.WorkDir, func(SessionEvent) {}, func(PermissionPrompt) {}, nil, 0)
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
	// Best-effort cleanup of the probe session (harness may persist session records;
	// failure is harmless — it may already be dead). Capability-gated: only call
	// session/close when advertised (session-setup.mdx: MUST NOT call when unsupported).
	if initResp.AgentCapabilities.SessionCapabilities.Close != nil {
		_, _ = conn.CloseSession(ctx, acp.CloseSessionRequest{SessionId: sess.SessionId})
	}
	// RefreshConfig 只刷新【可选列表】(同步外部新加的 provider/model),不应动当前选择:
	// probe 是全新 session,CurrentValue 是 harness 默认值;整列覆盖会把用户刚切的模型盖回默认
	// (打开下拉触发 probe → 几秒后模型回退)。合并:保留活 session 的 CurrentValue(仅当仍在新列表里)。
	cs.ConfigOptions = mergeConfigCurrentValues(cs.ConfigOptions, sess.ConfigOptions)
	cs.PromptCapabilities = initResp.AgentCapabilities.PromptCapabilities
	slog.Info("refreshed config options", "sessionId", cs.SessionID, "cwd", cs.WorkDir, "options", len(cs.ConfigOptions))
	return FlattenConfigOptions(cs.ConfigOptions), nil
}

// mergeConfigCurrentValues 把 old(活 session)各 Select 选项的 CurrentValue 还原进 fresh(probe 刷新
// 的可选列表),仅当该值仍在 fresh 的可选项里(避免还原已下架的模型)。fresh 保留 probe 的最新可选列表,
// 只把当前选择从 old 搬回来。Boolean(unstable)不处理 —— 模型/模式/思考档都是 Select。
func mergeConfigCurrentValues(old, fresh []acp.SessionConfigOption) []acp.SessionConfigOption {
	prev := map[acp.SessionConfigId]acp.SessionConfigValueId{}
	for _, o := range old {
		if o.Select != nil {
			prev[o.Select.Id] = o.Select.CurrentValue
		}
	}
	for i := range fresh {
		sel := fresh[i].Select
		if sel == nil {
			continue
		}
		live, ok := prev[sel.Id]
		if !ok || live == "" {
			continue
		}
		if selectOptionAvailable(sel.Options, live) {
			fresh[i].Select.CurrentValue = live
		}
	}
	return fresh
}

// selectOptionAvailable 判断 value 是否在 SessionConfigSelectOptions(Ungrouped + Grouped 都查)里。
func selectOptionAvailable(opts acp.SessionConfigSelectOptions, value acp.SessionConfigValueId) bool {
	if opts.Ungrouped != nil {
		for _, e := range *opts.Ungrouped {
			if e.Value == value {
				return true
			}
		}
	}
	if opts.Grouped != nil {
		for _, g := range *opts.Grouped {
			for _, e := range g.Options {
				if e.Value == value {
					return true
				}
			}
		}
	}
	return false
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
// Two equivalent signals, same root cause (harness process gone; must tear down connection and reconnect via Resume next time):
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
