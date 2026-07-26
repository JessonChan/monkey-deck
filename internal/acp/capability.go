package acp

// capability.go:运行时探测某 harness 的真实 ACP 能力位(CapabilityMatrix)。
//
// 为什么需要它:静态注册表(harness.Supported)只告诉我们「认识这个 harness」,
// 但某 harness 某版本到底支持 image prompt / session/list / session/load / mcp::acp …
// 哪些协议特性,要 spawn 一次问它自己。协议稳定字段(promptCapabilities / sessionCapabilities /
// mcpCapabilities / loadSession)由 Initialize 响应声明;真正发不发 usage_update / plan 事件
// 是行为层面的差异,需要观测实际 Prompt 流(可选,默认不做——会消耗 token)。
//
// ProbeCapabilities 是纯 ACP 路径(§1.1):spawn harness → Initialize → NewSession
// → 可选 noop Prompt。完全独立:独立进程组、独立连接、独立 handler,不影响任何活跃 session
// (与 RefreshConfig 的 probe 模式同构,见 runner.go)。失败返回带 ProbeErr 的矩阵 + 错误,
// 不留孤儿进程(proc.shutdown 幂等回收,§3.2)。

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/acp-go-sdk"
)

// CapabilityMatrix 捕获某 harness 经一次 ACP 探测得到的真实能力位。
//
// 字段分两组:
//   - 协议声明位(Initialize.AgentCapabilities):prompt/session/mcp/loadSession 等硬能力,
//     由 matrixFromInit 从 initResp 抽取。所有位缺省 false(SDK UnmarshalJSON 已补默认)。
//   - 行为观测位(可选,withProbe=true 时填):noop Prompt 期间是否真出现 usage_update / plan
//     事件。协议声明 ≠ 实际发送,此组字段用于「声明了但实际不发 / 没声明但实际发了」的兜底判断。
//
// ProbeErr 非空表示探测失败(Initialize/NewSession 报错或 noop Prompt 报错);此时声明位可能
// 部分填充(Initialize 成功但 NewSession 失败时,声明位已有值)。前端可据此显示「上次检测失败」。
type CapabilityMatrix struct {
	HarnessID string    `json:"harnessId"`             // 关联 harness.Harness.ID(omp/opencode/...)
	ProbedAt  time.Time `json:"probedAt"`              // 探测完成时刻(缓存老化 / 「上次检测」展示用)
	ProbeErr  string    `json:"probeErr,omitempty"`    // 探测失败的错误串(空 = 成功)

	// --- 协议声明位(来自 Initialize.AgentCapabilities)---
	PromptImage           bool `json:"promptImage"`           // ContentBlock::Image in prompts(promptCapabilities.image)
	PromptAudio           bool `json:"promptAudio"`           // ContentBlock::Audio in prompts(promptCapabilities.audio)
	PromptEmbeddedContext bool `json:"promptEmbeddedContext"` // ContentBlock::Resource in prompts(promptCapabilities.embeddedContext)
	LoadSession           bool `json:"loadSession"`           // session/load
	SessionList           bool `json:"sessionList"`           // session/list
	SessionClose          bool `json:"sessionClose"`          // session/close
	SessionResume         bool `json:"sessionResume"`         // session/resume
	SessionDelete         bool `json:"sessionDelete"`         // session/delete(UNSTABLE)
	SessionFork           bool `json:"sessionFork"`           // session/fork(UNSTABLE)
	AdditionalDirectories bool `json:"additionalDirectories"` // additionalDirectories(session lifecycle)
	McpAcp                bool `json:"mcpAcp"`                 // McpServer::Acp(UNSTABLE)
	McpHttp               bool `json:"mcpHttp"`                // McpServer::Http
	McpSse                bool `json:"mcpSse"`                 // McpServer::Sse

	// --- 行为观测位(仅 withProbe=true 且 noop Prompt 成功时填)---
	EmitsUsage bool `json:"emitsUsage,omitempty"` // noop Prompt 期间至少收到一次 usage_update
	EmitsPlan  bool `json:"emitsPlan,omitempty"`  // noop Prompt 期间至少收到一次 plan / plan_update
}

// matrixFromInit 从 Initialize 响应里抽出协议声明的能力位(纯函数,便于单测注入)。
// 不填 HarnessID/ProbedAt/ProbeErr/行为观测位(由调用方在探测生命周期内填)。
// SDK 对未声明字段已补默认(false / 空结构),无需额外兜底。
func matrixFromInit(initResp acp.InitializeResponse) CapabilityMatrix {
	ac := initResp.AgentCapabilities
	return CapabilityMatrix{
		PromptImage:           ac.PromptCapabilities.Image,
		PromptAudio:           ac.PromptCapabilities.Audio,
		PromptEmbeddedContext: ac.PromptCapabilities.EmbeddedContext,
		LoadSession:           ac.LoadSession,
		SessionList:           ac.SessionCapabilities.List != nil,
		SessionClose:          ac.SessionCapabilities.Close != nil,
		SessionResume:         ac.SessionCapabilities.Resume != nil,
		SessionDelete:         ac.SessionCapabilities.Delete != nil,
		SessionFork:           ac.SessionCapabilities.Fork != nil,
		AdditionalDirectories: ac.SessionCapabilities.AdditionalDirectories != nil,
		McpAcp:                ac.McpCapabilities.Acp,
		McpHttp:               ac.McpCapabilities.Http,
		McpSse:                ac.McpCapabilities.Sse,
	}
}

// ProbeCapabilities spawn 一个独立 harness 进程做一次能力探测(纯 ACP,§1.1)。
//
// 流程:spawn harness(独立进程组,§3.2)→ Initialize(拿 AgentCapabilities 声明的能力位)
// → NewSession(验证 harness 真能建 session;协议要求 cwd 存在)→ 可选地发 noop Prompt
// 观察实际事件流(usage_update / plan)→ CloseSession + kill 进程组回收。
//
// 完全独立:不影响任何活跃 session(独立连接、独立 handler)。失败时 proc.shutdown 幂等
// 回收进程组(§3.2),不残留孤儿。
//
// withProbe=false(默认推荐):只做 Initialize + NewSession,零 token 成本,覆盖绝大多数能力位。
// withProbe=true:额外发 noop Prompt("ping"),观察 SessionUpdate 流。会消耗少量 token,
// 且观测结果依赖 agent 当次行为(声明了未必发),默认关闭——前端如需「实际事件流」观测应
// 在真实对话里统计,而非 probe。
//
// workDir 必须存在(spawnAndInit 设 cmd.Dir;NewSession 的 cwd 也填它),用 t.TempDir() 或
// 应用缓存目录下的稳定 probe 目录。返回 (矩阵, error):error 非 nil 时矩阵仍带已取得的声明位
// + ProbeErr 串,调用方可读 ProbeErr 展示「上次检测失败」或只看 error。
func (r *Runner) ProbeCapabilities(ctx context.Context, harnessID, workDir string, withProbe bool) (CapabilityMatrix, error) {
	// probeObs 收集 noop Prompt 期间 OnEvent 收到的事件种类(并发安全:handler 回调可并发流入)。
	var probeObs struct {
		mu       sync.Mutex
		usage    bool
		plan     bool
	}
	onEvent := func(e SessionEvent) {
		probeObs.mu.Lock()
		defer probeObs.mu.Unlock()
		if e.Kind == "usage_update" {
			probeObs.usage = true
		}
		if e.Kind == "plan" {
			probeObs.plan = true
		}
	}
	handler := NewHandler(workDir, onEvent, func(PermissionPrompt) {}, 0)

	proc, conn, initResp, err := r.spawnAndInit(ctx, workDir, handler)
	if err != nil {
		return CapabilityMatrix{HarnessID: harnessID, ProbedAt: time.Now(), ProbeErr: err.Error()},
			fmt.Errorf("probe capabilities: spawn: %w", err)
	}
	defer proc.shutdown()

	// Initialize 成功:声明位可用。HarnessID/ProbedAt 由本函数填,ProbeErr 视后续步骤而定。
	m := matrixFromInit(initResp)
	m.HarnessID = harnessID

	sess, err := conn.NewSession(ctx, acp.NewSessionRequest{
		Cwd:        workDir,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		m.ProbedAt = time.Now()
		m.ProbeErr = err.Error()
		return m, fmt.Errorf("probe capabilities: new session: %w", err)
	}

	if withProbe {
		// noop Prompt:发极简 prompt 观察实际事件流。失败不致命(harness 可能需鉴权/配置),
		// 记 ProbeErr + 继续返回已得声明位(降级:行为观测位留 false)。
		if _, perr := conn.Prompt(ctx, acp.PromptRequest{
			SessionId: sess.SessionId,
			Prompt:    []acp.ContentBlock{acp.TextBlock("ping")},
		}); perr == nil {
			probeObs.mu.Lock()
			m.EmitsUsage = probeObs.usage
			m.EmitsPlan = probeObs.plan
			probeObs.mu.Unlock()
		} else {
			slog.Warn("probe noop prompt failed", "harness", harnessID, "err", perr)
			m.ProbeErr = "noop prompt: " + perr.Error()
		}
	}

	// 清理 probe 创建的 session:harness 可能持久化记录,CloseSession 收尾。失败不致命(忽略)。
	_, _ = conn.CloseSession(ctx, acp.CloseSessionRequest{SessionId: sess.SessionId})

	m.ProbedAt = time.Now()
	return m, nil
}
