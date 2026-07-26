# 2026-07-26 后端 CapabilityMatrix + ProbeCapabilities(纯 ACP 能力探测)+ 异步触发

## 起因

Task #23414:补一个运行时能力探测层。静态注册表(`harness.Supported`)只告诉我们「认识这个
harness」,但某 harness 某版本到底支持哪些 ACP 特性(image prompt / session/list / session/load /
mcp::acp / …)要 spawn 一次问它自己(Initialize.AgentCapabilities)。声明位 ≠ 实际行为,某些
harness 声明了未必发 usage_update/plan 事件,需要观测实际 Prompt 流兜底(可选)。

这是后续「按能力位门控 UI / 路径」(如 §3.5 image 能力门控已部分存在、未来 session/list 能力位
统一从 probe 取)的基础。

## 根因 / 协议调研

- ACP `Initialize` 响应的 `AgentCapabilities` 声明所有协议硬能力:
  - `PromptCapabilities{Image, Audio, EmbeddedContext}`
  - `SessionCapabilities{List, Close, Resume, Delete, Fork, AdditionalDirectories}`(指针,非 nil = 支持)
  - `McpCapabilities{Acp, Http, Sse}`
  - `LoadSession bool`
- SDK 的 UnmarshalJSON 对未声明字段补默认(false / nil),不需额外兜底。
- 行为层面:`PromptResponse.Usage` 常为 nil(§1.6/§5.4 #2),真实 usage 靠流式 `SessionUsageUpdate`;
  plan 靠 `SessionUpdate.Plan` / `PlanUpdate`。要观测「实际发不发」需跑一次 Prompt(消耗 token)。
- 项目已有 probe 模式:`ChatSession.RefreshConfig`(runner.go)用「spawn 独立 harness → Initialize →
  NewSession → CloseSession → kill 进程组」拿 configOptions,完全独立、不影响活跃 session。本任务
  复用同构模式。

## 改法

1. **`internal/acp/capability.go`(新文件)**:
   - `CapabilityMatrix` 结构:HarnessID / ProbedAt / ProbeErr + 协议声明位(prompt/session/mcp/
     loadSession 全部位)+ 行为观测位(EmitsUsage / EmitsPlan,默认 false)。
   - `matrixFromInit(initResp)`:纯函数,从 Initialize 响应抽声明位(便于单测注入,不填 HarnessID/
     ProbedAt/ProbeErr/行为位——那些由 ProbeCapabilities 在生命周期内填)。
   - `Runner.ProbeCapabilities(ctx, harnessID, workDir, withProbe)`:spawn harness → Initialize(拿
     声明位)→ NewSession(验证 harness 真能建 session)→ 可选 noop Prompt("ping")观测实际事件流
     → CloseSession + kill 进程组回收。失败返回带 ProbeErr 的矩阵 + error,降级路径明确。
     `withProbe=false` 是零 token 成本的默认推荐;`withProbe=true` 才发 noop Prompt。

2. **`internal/chat/chat.go`(改动)**:
   - 新事件 `EventHarnessCapabilities = "chat:harness-capabilities"`:probe 完成后下发,前端据此
     重拉 `ListHarnessCapabilities`。
   - 新字段 `capabilityCache atomic.Pointer[map[string]acp.CapabilityMatrix]`:probe 结果缓存。
   - `probeCapabilitiesAsync()`:Discover 之后异步 probe 所有 `Installed=true` 的 harness。各 harness
     独立 goroutine 并行 spawn(独立进程组,§3.2),整体限时 `probeCapTimeout=30s`。失败静默降级
     (ProbeErr 填错误串)。合并时**保留旧缓存里不在本次 installed 集合中的项**(避免 harness 临时
     未装就抹掉历史探测结果,§5.3 尊重数据源)。
   - `ListHarnessCapabilities()`:导出方法,返回缓存快照(nil = 未就绪,前端显示「检测中」)。
   - `refreshHarnessesThenMaybeAutoUpgrade` 在 `refreshHarnessesAsync` 后 `go probeCapabilitiesAsync()`
     (Discover 之后异步触发,不阻塞主流程)。
   - workDir 用 `cfg.CachesDir/probe` 稳定目录(EnsureDir 已建 CachesDir;惰性创建子目录,复用)。

3. **单测**:
   - `internal/acp/capability_test.go`:`matrixFromInit` 三例(全声明 / 全默认 false / 部分 session 能力)+
     `ProbeCapabilities` spawn 失败路径 × 2(withProbe true/false,均安全返回不 panic,§3.2)。
   - `internal/chat/capability_test.go`:6 例覆盖「未就绪 nil」「无 Installed no-op」「未 Discover no-op」
     「端到端 probe + 事件下发」「合并保留历史项」「probe workDir 创建」。不真启 harness(§5.1):
     fakeStubProbe 让 Discover 标记 Installed,实际 spawn 不存在的二进制 → ProbeErr 路径。

## 改了哪些文件

- `internal/acp/capability.go`(新)
- `internal/acp/capability_test.go`(新)
- `internal/chat/chat.go`(改:事件常量 + capabilityCache 字段 + probeCapabilitiesAsync +
  ListHarnessCapabilities + refreshHarnessesThenMaybeAutoUpgrade hook)
- `internal/chat/capability_test.go`(新)

## 验证

- `go build ./internal/...` / `go vet ./internal/acp/... ./internal/chat/...`:clean。
- `go test ./internal/acp/ ./internal/chat/`:全绿(新测试 9 例全过,旧测试无回归)。
- `go test ./...`:仅根包 `github.com/jessonchan/monkey-deck [setup failed]`(pre-existing,main.go
  的 `embed all:frontend/dist` 需要先构建前端,与本改动无关——已 git stash 复现确认)。

## 下一步

- 前端:接 `EventHarnessCapabilities` → 重拉 `ListHarnessCapabilities` → 在 harness 管理面板 /
  model-select / 能力相关 UI 入口按位门控(替代当前零散的 `SupportsImage` 单点判定)。
- 若需要「实际事件流」观测(EmitsUsage/EmitsPlan)填值:再开 `withProbe=true` 路径(当前默认 false,
  零 token 成本)。真实对话内的 usage/plan 统计更适合在 handler 层做,而非 probe。
