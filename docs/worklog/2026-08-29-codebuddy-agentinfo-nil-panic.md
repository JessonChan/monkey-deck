# codebuddy --acp 无法添加:initialize 响应省略 agentInfo → 探针 nil-panic

## 起因

用户在添加 harness 弹窗里加 `codebuddy --acp`(codebuddy v2.141.0,bun 全局安装),点自检直接报「自检失败」,连能力矩阵都出不来。约束:先分析根因、给方案,用户放行后才动代码(本次已放行并落地)。

## 根因

ACP v1 里 `initialize` 响应的 `agentInfo` 是**可选字段**(SDK 注释明示"in future versions of the protocol, this will be required")。codebuddy 的响应省略了它 → SDK 侧 `InitializeResponse.AgentInfo`(`*Implementation` + `omitempty`)为 nil → 我们三处裸解引用 nil-panic:

- `internal/acp/probe.go:220` `rep.AgentName = initResp.AgentInfo.Name`(自检入口,用户看到的就是这里)
- `internal/acp/probe.go:222` `Initialized.Note` 里再次解引用
- `internal/acp/runner.go:138` `NewChatSession` 的 slog 字段(即使添加成功,开 session 也会崩)

panic 传播链:Wails3 `BoundMethod.Call` recover → `CallError`(message 形如 `…ProbeNewHarness: panic: invalid memory address…`)→ 前端 `AddHarnessModal` setErr →「自检失败」。

排除项(实测验证过,非病因):裸协议 + 同款 SDK(v0.13.5)手工复刻 probe 调用序列,initialize/session/new/session/prompt 全过(end_turn),证明 ACP 通道本身健康,纯粹是我们解引用崩了。

顺带的上游核对(同日完成):acp-go-sdk `main` 分支 HEAD == `release: v0.13.5 (#47)`,无更新 dev 版;11 个 open PR 无一修 `agentInfo` 可选性或 `mcpServers` omitempty(`resume_patch.go` 兜底继续保留);升级 SDK 解决不了本问题。

## 改法(找不变量,不加 if 对抗)

不变量:**`AgentInfo` 永远可能为 nil,取名字必须走唯一的 nil-safe 出口**。

- 新增 `agentName(acp.InitializeResponse) string`(runner.go,spawnAndInit 旁):nil → 空串。三处解引用全部改走它。
- `ConformanceReport.displayName()`:空名渲染人话兜底「(未自报)」(§4.4),用于 `Initialized.Note`(`agent=(未自报) protocol=1`)与 `Summary()`。`AgentName` 字段本身保持空串(诚实数据;前端 `ProbeReport.tsx:36` 对空名已有 `? : null` 降级,无需改前端)。

## 改了哪些文件

- `internal/acp/runner.go`:+`agentName` helper;`NewChatSession` 日志字段改走 helper。
- `internal/acp/probe.go`:`rep.AgentName`/`Initialized.Note`/`Summary()` 改走 helper + `displayName()`。
- `internal/acp/probe_fakeagent_test.go`(新):回归测试。
- `internal/acp/probe_codebuddy_test.go`(新):`//go:build integration` 真 codebuddy 探针测试。

## 验证

- **回归测试先行复现**:`git stash` 修复后跑 `TestProbeHarnessOmittedAgentInfo` → panic 栈直指 `probe.go:220`(旧根因行)→ 恢复修复后 PASS(0.27s)。测试用经典 re-exec helper-process 模式:测试二进制自扮假 harness(initialize 响应故意省略 agentInfo),跑完整探针流程,断言 CanAdd=true、AgentName=""、Note 兜底文案、messageId 归并。无真 harness、无 key、无网络(§5.1)。
- **真 codebuddy 实测**:`go test -tags=integration -run TestProbeCodebuddyACP` 3 跑 2 过,通过时输出 `✅ 可以添加`(init/session/stream/turn 全 ✓;messageId=发、思考流=✓、用量=✓、模型选择器=✓、configOptions=4;resume/list/close 未声明 → 走既有降级)。1 次失败为 codebuddy 首次冷启动不稳(turn 中途 peer 断连、exit 0 自杀),重跑即过——与探针无关,CanAdd 严格门槛本就要求「当前环境真能跑完一轮」。
- **全量**:`go test ./...` rc=0;`go vet ./internal/acp/` 干净。
- 三端(§4.7):纯 Go 后端改动,无前端/样式/manifest 触及;`ProbeReport.tsx` 对空 agentName 既有降级已确认,GUI/浏览器/PWA 三端共用该组件,无回归面。

## 下一步

- 用户在桌面 GUI 里实际添加一次 `codebuddy --acp`(过自检 → 入库 → 开 session 对话),确认端到端体验;冷启动偶发自杀若再现,观察是否需要 ensureLive 重连兜底(已有机制,理论上自动覆盖)。
- codebuddy 不声明 resume/list/close:恢复走 skip-setup、session 标题降级——既有路径,无需动作。
- 上游 SDK 若发版让 `agentInfo` required,探针行为不变(nil-safe 出口常驻,防御老 harness)。
