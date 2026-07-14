# 2026-07-14 ACP 模型配置刷新(probe harness)+ 聊天刷新按钮

## 起因

模型列表完全由 agent(harness)在 ACP session 握手时自报(`NewSession` 响应的
`configOptions`),客户端不维护任何自有 model 清单(见 `internal/acp/runner.go:94`)。
当前活跃 session 的 harness 进程是在 spawn 时读了一次 harness 自己的配置(如 opencode
config),之后内存里的 `configOptions` 不再变化。

用户在 harness 配置外部改动(加了新 provider / model)后,当前 session 的模型下拉看不到
新选项 —— 必须关掉 session 再重开(重新 spawn harness)才能生效。需要一个「刷新」入口,
不中断当前对话流即可同步外部配置改动。

## 根因(协议调研结论)

ACP 协议里 `configOptions` 只在以下场景出现:
- `NewSession` / `LoadSession` / `ResumeSession` 响应(初始化时一次性)
- `SetSessionConfigOption` 响应(切换时返回最新全量)
- `config_option_update` 通知(agent 主动推)

**没有「重新拉 configOptions」的标准方法**(client 无法主动请求刷新)。要拿到「外部配置
改动后的最新模型列表」,唯一路径是**新 spawn 一个 harness 进程**:新进程会读最新 harness
配置 → `NewSession` 响应带最新 `configOptions`。

## 改法

### 后端:probe harness 方案

新增 `ChatSession.RefreshConfig(ctx)`(`internal/acp/runner.go`):用当前 session 的
`cwd` + 同一 harness 命令(`cs.Runner`)临时 spawn 一个独立 probe harness(独立进程组),
`Initialize` + `NewSession` 拿到最新 `configOptions` + `PromptCapabilities`,然后立即
`CloseSession`(清理 harness 持久化的 session 记录)+ `killProcessGroup` 回收。成功后覆盖
`cs.ConfigOptions` / `cs.PromptCapabilities` 为最新全量。

- probe 完全独立:不影响当前活跃连接、不中断进行中的对话流(哪怕 turn 正在跑)。
- probe 的 `OnEvent` / `OnPermission` 是 no-op(`NewSession` 本身不推 `SessionUpdate`)。
- 失败也保证 `killProcessGroup` 回收(`defer`,防泄漏,§3.2)。

新增 `ChatService.RefreshSessionConfig(sessionID)` Wails3 binding(`internal/chat/chat.go`):
取活跃 session → 用 60s 超时 context 调 `ls.chat.RefreshConfig(ctx)` → 推 `config_option`
event(附带 `ImageSupported`,probe 也更新了 prompt 能力)→ 返回扁平化结果。

- `chatConn` 接口加 `RefreshConfig` + `SupportsImage` 两个方法(`*acp.ChatSession` 已实现)。
- 两个 mock(`fakeChat` / `mockChatConn`)补空实现保持编译。

### 前端:聊天 header 刷新按钮

`ChatView.tsx` header actions 加 `RefreshCw` 图标按钮(`data-testid="refresh-config-btn"`),
loading 时图标 `.spin` + disable,react-tooltip 说明用途(§4.5)。按钮放在 status-badge 与
终端切换按钮之间。

`App.tsx` 加 `refreshingConfigBySession` state(per-session 隔离,切走保留)+ `refreshConfig`
callback:调 `ChatService.RefreshSessionConfig`,成功后后端推 `config_option` event 自动
更新下拉(已有 `applyEvent` 的 `config_option` 分支处理),失败走全局 `error` 反馈。

## 改了哪些文件

后端:
- `internal/acp/runner.go` — `ChatSession.RefreshConfig`(probe harness 拉最新 configOptions)
- `internal/chat/chat.go` — `chatConn` 接口 + `RefreshSessionConfig` binding 方法
- `internal/chat/queue_test.go` — `fakeChat` 补 `SupportsImage` / `RefreshConfig`
- `internal/chat/idle_reaper_test.go` — `mockChatConn` 补同上 + 两个新测试
- `internal/acp/runner_test.go` — `TestRefreshConfigSpawnFailure`(probe 失败错误路径)

前端:
- `frontend/src/components/ChatView.tsx` — 刷新按钮 + props
- `frontend/src/App.tsx` — state + callback + props 传递
- `frontend/src/i18n/locales/{zh,en}.json` — 刷新相关文案

Go 导出方法签名有变更(新增 `RefreshSessionConfig`)→ 已跑 `wails3 generate bindings`
重新生成前端 bindings(bindings 不入库,dev/build 时重生成)。

## 验证

- `go build ./...` ✅(仅 macOS SDK linker warning,非错误)
- `go vet ./...` ✅ 干净
- `go test ./...` ✅ 全绿(含新增 `TestRefreshConfigSpawnFailure` /
  `TestRefreshSessionConfigNotActive` / `TestRefreshSessionConfigActiveEmitsConfigOption`)
- `cd frontend && npm run build` ✅(tsc + vite,仅 chunk size warning)

## 设计权衡 / 已知限制

- **probe 会创建临时 session 记录**:`NewSession` 可能让 harness(如 opencode)持久化 session
  记录。已用 `CloseSession` 清理;即使 `CloseSession` 不彻底,也只是 harness 内部多一条
  closed 记录,不影响功能。下一步实机验证 opencode 的 `CloseSession` 是否完全清理。
- **probe 有 spawn 开销**:每次刷新要 spawn 一个 harness(约 1-2s),已用 60s 超时兜底 +
  loading 反馈。这是 ACP 协议无标准刷新方法的代价,可接受(用户主动触发,非高频)。
- **probe 与活跃 session 共享 `*Runner`**:`Runner` 只持有 `HarnessCmd` / `Env`(无状态),
  共享安全;probe 用独立 `cmd` / `conn`,不影响活跃连接。

## 下一步

- 实机验证(`wails3 dev`):点刷新按钮后模型下拉是否出现新选项;opencode 的 `CloseSession`
  是否清理临时 session。
- 若 opencode 的 `CloseSession` 不清理(留下垃圾 session),考虑改用 `UnstableDeleteSession`
  或记录 probe session id 供后续清理。
