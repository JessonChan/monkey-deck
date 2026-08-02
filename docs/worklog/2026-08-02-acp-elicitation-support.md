# 2026-08-02 实现 ACP elicitation 支持(让 omp /review 等交互命令可用)

## 起因

紧接 `2026-08-02-empty-turn-not-teardown.md`:omp `/review` 在 client 无 elicitation 能力时静默空。
根因是 omp 把 interactive 命令的 `select/confirm/input` 桥接成 ACP `elicitation/create`,client 不声明
`elicitation.form` 能力 → omp 的 select 返 undefined → 命令整体返空 → end_turn。

A 修了我们对「合法零输出」的过度反应(不再 teardown)。B 是治本:**声明 elicitation 能力 + 实现
回调 + 前端弹窗**,让 omp 的交互类命令(`/review` 选模式、`/fast` 确认)真正可用。

## elicitation 是标准协议吗

是。协议官网 v1 schema 已正式收录 `elicitation/create`、`elicitation/complete` 方法 +
`ClientCapabilities.elicitation` 能力声明位(form / url 两种 mode)。我们用的 `acp-go-sdk@v0.13.5`
把它标 `UNSTABLE`(注释 "not part of the spec yet")——SDK 是 elicitation 刚成型那版,协议未定稿;
标 UNSTABLE 不代表不能用。omp 已实际依赖它(`acp-agent.ts:390` 检查 `clientCapabilities?.elicitation?.form`)。
故支持无心理负担(§5.3:外部事实先验证 —— 已验证协议位真实存在、对端真在用)。

## 设计

镜像 §3.4 权限裁决(RequestPermission)的全链路模式:

1. **Initialize 声明能力**:`ClientCapabilities.Elicitation.Form = &ElicitationFormCapabilities{}`。
2. **Handler 实现 `UnstableCreateElicitation` 回调**(SDK 经 interface 断言调用):
   - `req.Form` → 从 `RequestedSchema.Properties` 扁平化出字段列表 → 推前端(经 OnElicitation)。
   - 等用户响应 / ctx 取消 / 超时降级(decline)。
   - accept → `UnstableCreateElicitationAccept{Content}`;decline/cancel/超时各自分支。
   - `req.Url` → 暂不支持(omp 不用),decline 让 harness 自行处理。
3. **service 层**:`onElicitation` 回调对齐 SessionID + emit `chat:elicitation` event;暴露
   `ChatService.RespondElicitation`(前端用户响应后调)。
4. **前端 ElicitationCard**:按 field.type 渲染(string→input、string+enum→select、boolean→checkbox),
   accept 提交,decline/cancel 退出。

omp 约定:select/confirm/input 都包装成 `{type:object, properties:{value:<schema>}, required:["value"]}`
(字段名固定 "value")。我们的扁平化支持多字段(单字段是其特例)。

## 改了哪些文件

后端:
- `internal/acp/elicitation.go`(新):`ElicitationPrompt`/`ElicitationField`/`ElicitationResponse` 类型 +
  `UnstableCreateElicitation` 方法 + `elicitFields`(schema 扁平化)+ `elicitResponseToSDK`。
- `internal/acp/handler.go`:加 `OnElicitation`/`pendingElicit`/`elicitSeq` 字段 + `RespondElicitation`
  方法 + `NewHandler` 加 `onElicitation` 参数。
- `internal/acp/runner.go`:`NewChatSession`/`LoadChatSession` 加 `onElicitation` 参数透传;
  `ChatSession.RespondElicitation` 透传方法;**Initialize 声明 `elicitation.form` 能力**;
  `RefreshConfig`/`capability.go`/`probe.go` 的 NewHandler 调用补 nil 参数。
- `internal/acp/elicitation_test.go`(新):7 个测试(schema 扁平化 select/boolean、拒绝非法、响应转换、
  端到端 dispatch/respond、url decline、超时 decline)。
- `internal/chat/chat.go`:`chatConn` 接口加 `RespondElicitation`;`EventElicitation` 常量;
  `startLive` 加 `onElicitation`(emit event + SessionID 对齐);`ChatService.RespondElicitation`
  导出方法(content 经 JSON string 中转:Wails3 binding 生成器对 `map[string]any` 不生成 TS)。
- mock 补 `RespondElicitation` stub:`internal/chat/{idle_reaper_test,queue_test}.go`。
- `internal/acp/*_test.go`:NewHandler 调用补 nil 参数(sed 批量,18 处)。

前端:
- `frontend/src/types.ts`:`ElicitationPrompt`/`ElicitationField` 类型。
- `frontend/src/components/ChatView.tsx`:`ElicitationCard` 组件(string/enum/boolean 三种渲染)+ props
  透传 + 挂载在尾部区(紧随 PermissionCard)。
- `frontend/src/App.tsx`:监听 `chat:elicitation` event + `elicitationBySession` state + derived +
  `respondElicitation`(JSON.stringify content)+ popout 快照/还原 + evictSessionCache 清理 + 透传 ChatView。
- `frontend/src/i18n/locales/{zh,en}.json`:`elicitationTitleFallback`/`elicitAccept`/`elicitDecline`/`elicitCancel`。
- `frontend/src/index.css`:`.elicit-*` 样式(复用 permission-card 容器)。
- `frontend/bindings/...`(regen:`wails3 generate bindings`)。

## 验证

- `go build . ./internal/...` 通过。
- `go test ./internal/...` 全绿(15 包 ok);elicitation 新增 7 测试全过。
- `bun run tsc --noEmit` 0 error。
- `bun run test`:7 fail 全是既有(ChatView 虚拟化 / NewSessionModal / msgmeta,均 McpChip.GetSessionMcpServers
  在测试环境的问题 + 预选逻辑,与本变更无关)。
- **ACP 探针协议链路实测(关键验证)**:`acp_elicit_verify.py` 起 omp acp,client 声明 `elicitation.form`,
  发 `/review`:
  1. omp 立即发 `elicitation/create`(mode=form, message="Review Mode", schema enum 4 选项)。
  2. accept 第一个选项后,omp **继续发第二个 elicitation**(选 base branch)——级联交互正常。
  3. 第二次 accept 后,omp **正常进入 review 流程**:`agent_thought_chunk` 流入("This is a code review
     request for a large PR (230 files, +25597/-1543 lines)..."),**不再是空 end_turn**。
  对比 A 之前(无 elicitation 能力):零输出 + end_turn。协议链路完全打通。

## 下一步 / OPEN

- [OPEN] server 模式浏览器驱动实测 ElicitationCard 真实渲染(select 下拉 / checkbox 交互)——协议层已
  验证,UI 层留作下次。ElicitationCard 逻辑与探针一致(accept 时 content = {字段:值})。
- [OPEN] omp 那个 bug 仍存在:client 无 elicitation 能力时它该降级到 headless prompt 而非静默空。
  可给 omp 提 issue / PR(根因在 `acp-agent.ts:392` select 返 undefined 时 review 未回退 headless)。
- elicitation 超时降级用 decline(不是 cancel):decline 更中性,让 harness 优雅降级;cancel 可能被
  harness 当作"用户中止 turn"。omp 实测 decline 后命令直接结束(无副作用)。

## Review 修正(同 commit 序列,design-verdict: approve-with-changes)

外部 review 三点全中(已全部实测验证后修):

1. **major · 卡片放错容器**:ElicitationCard 原挂在 `.cv-tail`(虚拟滚动 `.chat-content` 内,随消息滚),
   向上翻阅时阻塞交互卡片滚出视口、与普通消息气泡混排、无「agent 在等你」强提示。
   **修法(方案 A)**:移出 `.chat-body`,作为 `.chat-header` 与 `.chat-body` 之间的固定兄弟节点
   `.elicit-bar`(`.chat-view` 是 flex column,`chat-body` flex:1,插入 flex 子节点天然占内容高,
   空时零高)。独立 CSS(不再复用 `.permission-card` —— 语义不同:权限=二选一放行,elicitation=填表提交)。
   omp 单字段 value(select/confirm)走紧凑单行布局;多字段走竖排表单。
   Composer 内联(方案 B)留作 follow-up。

2. **minor · 图标/按钮语义混淆**:头部原用 `Sparkles`(与 agent 消息头像 line 727 同图标,无法一眼区分
   「agent 发言」vs「agent 请求输入」)→ 换 `ListChecks`(已 import,语义更近「待填项」)。
   decline/cancel 原都红色 `perm-deny` 但语义不同(decline=让 harness 优雅降级继续、cancel=中止本轮)
   → 精简为两按钮:提交(accept,主,accent)+ 跳过(decline,次,muted 描边)。cancel 等价 Stop 按钮
   (turn 进行中始终可用),不在此重复暴露。

3. **minor · 超时后卡片残留**:后端超时/ctx 取消分支只 removePendingElicit 返 decline,**不通知前端**
   → 卡片最多残留 permTTL=5min;期间点击后端报 no pending、前端 await 无 try/catch 静默吞掉。
   **修法**:后端加 `OnElicitationResolved` 回调 + `EventElicitationResolved`(`chat:elicitation-resolved`,
   payload `{sessionId,id}`),在「无用户操作」终结(超时/ctx 取消)时推;用户正常响应路径不触发(前端已
   乐观清卡)。前端 listen 后按 id 清对应卡片;`respondElicitation` 包 try/catch(与 resolved 竞态时撞
   no pending 不抛 unhandled)。

### Review 修正改了哪些文件

- 后端:`internal/acp/handler.go`(加 `OnElicitationResolved` 字段)、`internal/acp/elicitation.go`
  (timeout/cancel 分支调 `notifyElicitationResolved`)、`internal/chat/chat.go`(`EventElicitationResolved`
  常量 + startLive 注入回调)。
- 前端:`frontend/src/components/ChatView.tsx`(ElicitationCard 移到固定 `.elicit-bar` + 重写组件:
  ListChecks/紧凑单行/两按钮)、`frontend/src/App.tsx`(listen resolved + try/catch)、
  `frontend/src/index.css`(`.elicit-bar` 独立样式,删旧的复用 permission 上下文的 `.elicit-*`)、
  `frontend/src/i18n/locales/{zh,en}.json`(`elicitDecline`/`elicitCancel` → `elicitSkip`)。

### Review 修正验证

- `go build . ./internal/...` + `go test ./internal/...` 全绿(15 包);`bun run tsc --noEmit` 0 error。
- `bun run test`:7 fail 全是既有(ChatView 虚拟化/NewSessionModal/msgmeta),与本变更无关。
- [OPEN] server 模式浏览器实测新的固定栏布局 + 紧凑单行渲染留作下次。

## 方向再修正:移进 Composer(compose-card 内部,用户拍板)

上一版「固定 `.elicit-bar` 在 header/body 之间」用户仍不满意:位置偏离输入框、语义上 elicitation
是「输入」不是「消息」。用户明确:**放进聊天窗口(输入框 Composer)里面**。

修法(方案 B,最终版):
- `ElicitationCard` 组件从 ChatView.tsx **移到 Composer.tsx**(它现在只在 Composer 用,KISS)。
- 渲染点:`.compose-card` 内部最前面(att-chips 之前,textarea 之上)——即「输入框卡片里的第一个区块」。
  agent 在等用户输入时,表单就在用户即将操作的输入框里,不会被误读为消息流的一部分。
- ChatView 不再渲染,只透传 props(elicitation + onRespondElicitation)给 Composer。
- CSS:`.elicit-bar`(固定栏样式,border-bottom/bg)→ `.elicit-inline`(compose-card 内部表单,
  accent 描边突出「这是待办输入」,与 compose-card 融为一体)。单字段紧凑单行 / 多字段竖排表单不变。

### 改了哪些文件(方向再修正)

- `frontend/src/components/Composer.tsx`:加 `elicitation`/`onRespondElicitation` props + 解构 +
  compose-card 内部首位渲染 + `ElicitationCard` 组件定义(从 ChatView 搬来)+ `ListChecks` import。
- `frontend/src/components/ChatView.tsx`:删顶层 `.elicit-bar` 挂载 + 删 ElicitationCard 组件定义
  (已移走)+ Composer 调用处透传 elicitation/onRespondElicitation。
- `frontend/src/index.css`:`.elicit-bar` → `.elicit-inline`(compose-card 内部表单样式,accent 描边)。

## Skip(decline)导致空 turn 不报错(用户反馈修正)

实测确认:用户点 Skip(decline)→ omp 收到 decline → 命令直接 `end_turn` + **零输出**(omp 未降级
headless 的 bug 仍在)。这与「agent 自己挂了的空 turn」结构相同 → 命中 empty-turn 检测 → 报
「本轮无响应」错误。但用户主动跳过不是异常,不该报错。

修法:handler 加 `elicitDeclined atomic.Bool`,**只在用户主动 decline 分支**(`<-p.response` 且
`resp.Action == "decline"`)置位(超时降级虽也返 decline 给 harness,但那是兜底非用户意愿,不置位)。
runPrompt empty-turn 检测据此区分:
- `ElicitDeclined() == true` → 静默推 idle(用户主动跳过,不是异常)。
- 否则 → 报 empty-turn 错误(真异常,连接没坏但用户该知道)。
读后即清(`ResetElicitDeclined`),防上一轮的 decline 残留到下一轮判定;非空 turn 也清(用户 decline
后 agent 仍可能产出内容)。

### 改了哪些文件(Skip 修正)

- `internal/acp/handler.go`:`elicitDeclined atomic.Bool` 字段。
- `internal/acp/elicitation.go`:用户主动 decline 分支(`<-p.response` + `resp.Action=="decline"`)置位。
- `internal/acp/runner.go`:`ChatSession.ElicitDeclined()` / `ResetElicitDeclined()` 暴露方法。
- `internal/chat/chat.go`:`chatConn` 接口加两方法;empty-turn 检测加 decline 分支(静默 idle)+ 读后即清。
- `internal/chat/queue_test.go`:`fakeChat` 加 `declined atomic.Bool` + 两方法实现。
- `internal/chat/empty_turn_test.go`:`TestEmptyTurnAfterElicitDeclineIsSilentIdle`(decline 后空 turn → idle,无 error code);对照 `TestEmptyTurnDetectedAsError`(无 decline 的真异常空 turn → 仍 error)。
