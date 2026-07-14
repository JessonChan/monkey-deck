# 2026-07-14 历史会话懒 spawn harness(isReadOnly/lazySpawn)

## 起因
Task #15136。此前打开任意 session(含纯查看历史)都会异步 spawn harness(B 方案:
OpenSession → ensureLive → spawn)。只读浏览历史时白白占用一个 harness 进程,浪费资源。
需改为:打开历史会话只读加载消息,需要交互(发消息 / 点「继续会话」)时才 spawn。

## 设计
- **懒 spawn 判定**:用「session 是否已有消息」区分历史会话(有消息 → 只读)与新建会话
  (无消息 → 立即 spawn,保持原行为,§3.1 不影响新建流程)。判据来自 SQLite(`SessionHasMessages`),
  稳定且不依赖启发式(§5.3 找不变量)。
- **只读态**:不在 `s.active` 中 = 只读态(无需额外 flag,absence 即语义)。推 `readonly` 状态事件
  让前端给视觉提示。
- **触发 spawn**:`SendMessage`/`InterruptAndSend`/`SendAndWaitSync` 本就先 `ensureLive` →
  天然支持「发消息即 spawn」。新增 `ContinueSession` 导出方法供「继续会话」按钮显式 spawn。
- **资源释放**:`CloseSession` 对非活跃 session 本就是 no-op(只读未 spawn → 无需回收);
  已 spawn → 走原 Close(杀进程组 + reap)。满足「关闭时已 spawn 则回收,只读未 spawn 则无需回收」。
- **可测**:`ensureLive` 的 spawn 步骤抽成 `spawnFn` 字段(默认 = `s.startLive`),单测注入 mock
  免启真 harness(§5.1)。

## 改法
### 后端
- `internal/store/messages.go`:新增 `SessionHasMessages`(EXISTS 查询,毫秒级)。
- `internal/chat/chat.go`:
  - `StatusPayload.status` 注释补 `readonly`。
  - `ChatService` 新增 `spawnFn` 字段;`ServiceStartup` 置 `s.startLive`;`ensureLive` 调 `s.spawnFn`。
  - `OpenSession` 改懒:历史会话(有消息)→ 推 `readonly` 不 spawn;新建会话 → 异步 spawn(原行为)。
  - 新增 `ContinueSession(sessionID)`:显式 `ensureLive`,已活跃 no-op。
  - 更新 `GetSessionConfigOptions`/`SetSessionConfigOption` 过时注释(B 方案描述不再准确)。
- `internal/chat/lazy_spawn_test.go`(新):6 条单测覆盖历史/新建打开、ContinueSession、
  只读态发消息触发 spawn、只读/已活跃 CloseSession 回收差异。

### 前端
- `types.ts`:`StatusPayload.status` 加 `readonly`。
- `App.tsx`:
  - chat:status handler 加守卫:`started` 不把 `prompting` 降级(发消息触发 spawn 时 started 紧跟 prompting,
    避免瞬态 ready 闪烁)。
  - 新增 `continueSession` 回调 → `ChatService.ContinueSession`;`onContinue` 传给 ChatView。
- `ChatView.tsx`:STATUS_MAP 加 `readonly`;header 下新增只读横幅(Eye 图标 + 提示 + 「继续会话」按钮,
  `data-testid="readonly-banner"`/`"continue-session-btn"`)。
- `i18n`(zh/en):`chat.status.readonly`、`chat.readonlyHint`、`chat.continueSession`、`chat.continueSessionTip`。
- `index.css`:`.st-readonly` + `.readonly-banner`/`.readonly-continue-btn`(轻量 CSS,无重绘开销)。

## 改了哪些文件
- internal/store/messages.go
- internal/chat/chat.go
- internal/chat/lazy_spawn_test.go(新)
- frontend/src/types.ts
- frontend/src/App.tsx
- frontend/src/components/ChatView.tsx
- frontend/src/i18n/locales/zh.json
- frontend/src/i18n/locales/en.json
- frontend/src/index.css
- (bindings 自动重生,不入库)

## 验证
- `go build ./...` / `go vet ./...`:clean。
- `go test ./...`:全过(含 6 条新懒 spawn 单测)。
- `cd frontend && bun run build`(tsc + vite):无类型/编译错误。
- git status:无 AGENTS.md / RAK 运行时文件 / dist / bindings 入库。

## 下一步
- 实机验证:打开历史会话应见「只读」横幅且无 harness 进程;发消息或点「继续会话」后转就绪并可交互。
- 可选:侧栏 session 状态点目前对 readonly 显示为「空闲」(dotTip),如需区分可单独映射。
