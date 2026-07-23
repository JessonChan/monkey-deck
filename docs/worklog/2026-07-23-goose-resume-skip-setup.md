# 2026-07-23 goose 会话恢复:跳过 setup 靠 auto-load(不 load 不 resume)

## 起因

接 `2026-07-23-add-goose-builtin-harness` 后,goose 会话"重开"路径有问题。深挖 session 恢复机制,推翻了多个假设。

## 根因(协议 + 源码 + 实测三层验证)

ACP 恢复会话有三个方法,语义不同:
- `session/resume`:重连已持久化 session,**不重放**(规范正典的"跨重启恢复"优化方法)。
- `session/load`:加载持久化 session + **全量重放**(协议无分页,replay 整段历史)。
- `session/new`:全新会话(无上下文)。

**goose 源码(`crates/goose/src/acp/server.rs:1502` `get_session_agent`)实证**:session 操作(含 prompt)若 session 不在内存,会自动从 `session_manager`(sessions.db)加载并激活——**goose 在 prompt 时 auto-load,根本不需要 client 显式 load/resume**。goose 的 ACP **没实现 session/resume**(dispatch.rs 无 resume 路由、无 resume_session 模块、SDK 类型里无 SessionResume;实测返回 -32601 Method not found)。goose CLI 的 `goose session --resume` 是它内部 session 机制,与 ACP 无关。

**实测对照(三轮独立连接 + 多轮 + 续聊)**:
- goose:全新进程、**不做任何 setup、直接 prompt 旧 sessionId** → 自动恢复**完整多轮历史**(连发 3 轮植入 3 个密钥,新进程全部召回)+ 续聊累积正确。✅
- omp:全新进程、不做 setup 直接 prompt → **被拒** `Unsupported ACP session`。omp **必须** resume(或 load)。

即:**resume 对 omp/opencode 是必须的,对 goose 不需要(goose auto-load)**。两者机制不同,都达到"恢复上下文不重放"。

## 改法

1. **`internal/acp/runner.go` `LoadChatSession`**:按 `sessionCapabilities.resume` 能力分流——
   - 有 resume(omp/opencode)→ `ResumeSession`(不重放,必须)。
   - 无 resume(goose)→ **跳过 setup**(不 load、不 resume),等首条 `session/prompt` 由 goose auto-load 激活。
   - (上一版是"无 resume → 回退 load",基于错误假设 load 是 goose 唯一恢复途径;load 的全量重放对 goose 完全多余。)
2. **`internal/chat/chat.go` `startLive`**:goose skip-setup 拿不到 fresh configOptions → live configOptions 为空时用持久化缓存 `se.ConfigOptionsCache` 兜底,否则前端 config_option 事件用空数组覆盖、模型选择器空白。
3. 顺手修 stale 集成测试:`integration_test.go`/`resume_test.go` 用了旧的 4 参 `Prompt`(签名早改成 3 参,因 `//go:build integration` 默认不编译一直没被抓到)→ 改 3 参 + 给 ctx 加超时。这样 `-tags=integration` 能编译,新测试才跑得起来。

## 改了哪些文件

- `internal/acp/runner.go`(LoadChatSession 分流 + 文档)
- `internal/chat/chat.go`(startLive configOptions 缓存兜底)
- `internal/acp/goose_skipsetup_test.go`(新,`//go:build integration`:monkey-deck Runner 层验证 goose skip-setup 重开恢复上下文)
- `internal/acp/integration_test.go`、`internal/acp/resume_test.go`(stale Prompt 调用修正)

## 验证

- `go build . ./internal/...` ✅;`go test ./internal/...` ✅(全 12 包);我改过的文件 gofmt 干净。
- `go vet -tags=integration ./internal/acp/` ✅(修完 stale 调用后,所有 integration 测试可编译)。
- **monkey-deck Runner 层集成测试 PASS**:`TestGooseSkipSetupReopen` —— NewChatSession+Prompt(植入 MANGO-9988)→ Close → LoadChatSession(skip-setup)→ Prompt 召回,reply `"MANGO-9988"` ✅。即 monkey-deck 实际代码路径验证 goose skip-setup 恢复上下文。
- (harness.go 等 gofmt -l 标记是仓库预存的 Go 版本对齐差异,非本次编辑,不动。)

## 结论 / 下一步

- omp/opencode 走 resume、goose 走 auto-load,**两者都不重放、都不破坏 ACP 语义、都最省**。
- 实机 `wails3 dev` 验证:重开 goose 会话续聊、模型选择器从缓存正常渲染。
- 可选:goose 首条 prompt 后若 agent 推 `config_option_update`,可顺带刷新(目前靠缓存已够用)。
