# 2026-07-28 junie 恢复报 mcpServers missing —— 出站管道补字段兜底

## 起因

用 `junie acp` 接入,第二次对话(恢复 session,走 `session/resume`)必报:
```
start acp session: load session: {"code":-32700,"message":"Field 'mcpServers' is required for type with serial name 'com.agentclientprotocol.model.ResumeSessionRequest', but it was missing"}
```
opencode / omp 不报(对缺失字段宽容);junie 用 Kotlin `kotlinx.serialization @Required`,严格按 ACP 规范要求 mcpServers,所以暴露。

## 根因(SDK bug)

`acp-go-sdk v0.13.5` `types_gen.go` 里三个 session 请求类型的 `McpServers` json tag **不一致**:

| 类型 | tag | 空 `[]McpServer{}` 序列化 |
|---|---|---|
| `NewSessionRequest` | `json:"mcpServers"` | `"mcpServers": []` ✓ |
| `LoadSessionRequest` | `json:"mcpServers"` | `"mcpServers": []` ✓ |
| **`ResumeSessionRequest`** | **`json:"mcpServers,omitempty"`** | **字段整体丢掉** ✗ |

我们恢复时传空 `McpServers`(`runner.go` LoadChatSession),omitempty 把空切片丢了 → 出站 `session/resume` JSON 无 mcpServers → junie 报 -32700。NewSession / LoadSession 没 omitempty,所以第一次对话(`session/new`)正常。属 SDK 生成不一致(且 ResumeSessionRequest.Validate() 也漏了 `McpServers!=nil` 校验,另两个都有)。

## 为什么不在 SDK 层修(取舍)

- `replace → third_party 本地副本` / fork:要往仓库塞 SDK 副本,违背「保持仓库对所有人可编译、不背本地依赖副本」。
- `vendor`:本项目有 modernc.org/sqlite,全量 vendor 体积爆炸,不现实。
- **绕过 `conn.ResumeSession`、改用 SDK 导出的 `SendRequest(*Connection,…,params any)` 自己发**:堵死——`SendRequest` 要 `*Connection` 入参,而 `ClientSideConnection.conn` 是**未导出字段、无 getter**(`client.go:9-12`),外面拿不到。
- 结论:等上游修(已拟 issue),本地用**出站管道补字段**兜底。

## 改法(方案 A:出站管道中间件)

新增 `internal/acp/resume_patch.go`:`resumePatchWriter` 包裹 `NewClientSideConnection` 的 `peerInput`(= harness stdin)。SDK 每条出站消息 = 一个 JSON + '\n'(`connection.go` Marshal + append '\n' + 单次 Write);中间件按 '\n' 切行,**仅**对 `method=="session/resume"` 且 `params` 缺 `mcpServers` 的帧注入 `"mcpServers": []` 后重新序列化,其余帧**字节透传**(零解析开销)。顶层字段用 `map[string]json.RawMessage` 整体回写,不丢字段。

接入点:`internal/acp/runner.go` `spawnAndInit`(搜 `RESUME_PATCH`)——所有连接(对话 session / ProbeHarness / ProbeCapabilities)的唯一构造点;中间件对非 resume 路径是 no-op。

**设计要点(保证上游修后零风险删除)**:
- 只动 session/resume 帧,只在字段**确实缺失**时补;上游修了 tag、字段本就在 → 中间件自动 no-op。
- 独立单文件 + 一处接入点 + 顶部大段注释含**删除步骤**;删 = 删本文件 + 测试 + 接入点那一行包装。
- 5 个单测锁不变量(补字段、已有 no-op、非 resume 字节透传、method 判定非字符串匹配、模拟带 bug SDK 输出端到端)。

## 改了哪些文件

- 新增:`internal/acp/resume_patch.go`、`internal/acp/resume_patch_test.go`
- 改:`internal/acp/runner.go`(spawnAndInit 一行:`stdin` → `newResumePatchWriter(stdin)`,带 `RESUME_PATCH` 标记)

## 验证

- `go build . ./internal/...` 通过;`go test ./...` 全绿;前端 tsc + 147 测试通过。
- module cache 已还原到**带 bug 的上游态**(unpatched),证明是中间件在补、不是 cache 补丁。
- `TestResumePatch_SimulatesBuggySDKOutput` 直接喂「带 omitempty 的 SDK 实际产出的 resume 帧」→ 断言补回 `mcpServers`,即管道层端到端证据。

## 下一步 / OPEN

- **上游 issue**:给 `coder/acp-go-sdk` 提(草稿已拟):`ResumeSessionRequest.McpServers has omitempty, but mcpServers is spec-required` —— 去掉 omitempty + 补 Validate。上游发版后按 `resume_patch.go` 顶部删除步骤撤掉本兜底。
- 中间件是 wire-level hack(解析/重写出站 JSON-RPC),依赖 SDK「一帧一 Write + 换行分帧」稳定;SDK 若改分帧需同步调整(目前 `connection.go:611-619` 稳定)。
