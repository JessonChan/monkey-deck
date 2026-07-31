# 2026-08-01 MCP server 管理(catalog + 导入 + per-session 注入)

## 起因

monkey-deck 驱动 OMP/opencode 走纯 ACP。调研发现:ACP 协议里 client 通过
`session/new.mcpServers` 注入 MCP server(agent 反过来连);**OMP 在 ACP 模式 `enableMCP:false**
(`main.ts:397`),关掉了自己的 `.mcp.json` 发现,MCP 100% 由 client 注入**。我们之前三个 session
入口全传 `[]acp.McpServer{}` → 每个 OMP session 实际**零 MCP 工具**。需要补上 MCP 管理。

## 设计(多轮对话敲定)

- **真相来源**:SQLite 唯一(§1.5)。**不做盘上 `.mcp.json` 发现**(用户明确否决);用户手填或
  **一次性导入** harness 配置(opencode `mcp` 段 / OMP `mcpServers` 段),文件即弃。导入 ≠ 发现。
- **三层职责**:
  - Settings catalog(全局):定义每个 server + 「默认开/关」。
  - NewSessionModal:勾选本次会话连哪些(预勾 = 默认开的)。
  - 聊天头部 chip:只读看选了哪些。
- **严格模式策略**:协议对「创建时 MCP 失败该怎么办」沉默(只 `SHOULD connect to all`);
  OMP 自选严格(`#configureMcpServers` 任一失败 → throw → session 建不起来)。**一律按严格处理**,
  且**不解析 harness 错误文本**(那是 OMP-specific,违反 harness 无关原则):创建失败 → NewSessionModal
  不关、原样展示错误消息 → 用户取消勾选可疑 server(本次不选,catalog 不动)→ 重试。归因靠人读消息。
  - **不做 out-of-band 预校验**(用户否决)。
- **中途断连**:OMP 自动重连(退避+熔断)、工具调用等重连或失败、对话继续;ACP 不回报 MCP 状态,
  monkey-deck 只能从失败的工具调用看「症状」,不做实时健康灯(否则造假,§4.4)。
- **字段丢失**:ACP 只承传输字段,OMP 的 `cwd/timeout/auth/oauth` 导入时丢弃(auth/oauth 告警)。

## 改法(分层,6 commit)

1. **数据层** `internal/store`:migration 0014(mcp_servers catalog)+ 0015(session_mcp 选择);
   CRUD + SetSessionMcp/GetSessionMcpServers(join),DeleteMcpServer 级联清理引用。
2. **转换层** `internal/mcp`(新包):`ToAcpServers`(按 McpCapabilities 协商,stdio 免协商,
   http/sse 不支持丢弃+告警)+ `ImportAuto`(自动识别 opencode/OMP 方言,opencode command 数组
   拆 command+args、environment→env;OMP oauth 告警)。
3. **注入** `internal/acp/runner.go`:NewChatSession/LoadChatSession 加 `mcps []store.McpServer`
   入参,Initialize 后转 ACP 注入;RefreshConfig 的 probe 保持空切片(别让坏 MCP 挡住配置刷新)。
   `chat.startLive` 拉 session 选择传入。
4. **服务+绑定** `internal/chat`:CreateSession/GuestSession 加 `mcpServerIDs`;catalog CRUD +
   ImportMcpConfig + GetSessionMcpServers;`make bindings` 重生成。
5. **前端**:McpSettings pane(catalog + 导入)+ SettingsPanel 加 MCP 分类 + NewSessionModal
   勾选 + ChatView 头部 McpChip(只读)+ i18n zh/en。
6. 测试调用点更新(ast_edit 批量给 svc.CreateSession/GuestSession 加 nil)。

## 改了哪些文件

- `internal/store/migrations/0014_mcp_servers.sql`、`0015_session_mcp.sql`(新)
- `internal/store/mcp.go`、`mcp_test.go`(新)
- `internal/mcp/convert.go`、`import.go`、`mcp_test.go`(新包)
- `internal/acp/runner.go`、`resume_test.go`、`integration_test.go`
- `internal/chat/chat.go`、`guest_test.go`、`integration_test.go`、`worktree_path_test.go`、`last_harness_test.go`
- `frontend/src/components/McpSettings.tsx`、`McpChip.tsx`(新);`SettingsPanel.tsx`、
  `NewSessionModal.tsx`、`ChatView.tsx`、`App.tsx`;`i18n/locales/{en,zh}.json`
- `frontend/bindings/*`(重生成,不入库)

## 验证

- `go build . ./internal/...` ✓;`go vet ./internal/...` ✓(含测试文件编译)。
- `go test ./internal/store/... ./internal/mcp/...` ✓(CRUD/JSON 往返/转换/导入解析/格式识别)。
- `cd frontend && bun run tsc --noEmit` ✓。
- **未跑端到端真 harness**(用户自测)。已知待验:OMP ACP 模式下注入非空 mcpServers 后,
  session 能否正常起来 + 工具是否出现;以及 vanilla opencode 的 MCP 失败行为(本次未验证,是编译二进制)。

## 下一步 / OPEN

- **端到端验证**(用户):配一个 stdio MCP → NewSession 勾选 → 看工具是否出现;故意配错 → 看
  创建失败报错 + 取消重试是否通。
- **字段丢失的 OAuth server**:导入后多半连不上,UI 已告警;是否要做更友好的引导待定。
- **vanilla opencode 的 MCP 行为**未验证(编译二进制,源码不在机);若将来 opencode 也作主力,
  需确认其创建时是否也严格(影响是否需要差异处理——目前「一律按严格」已覆盖)。
- **实时连接状态**:协议不给,长期不做;若强需,正路是做成 MCP server 注入(非协议字段)。
