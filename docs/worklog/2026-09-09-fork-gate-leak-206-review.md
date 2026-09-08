# 2026-09-09 review 记录:#206 fork 门控无漏结论独立复核(任务 #29051)

## 起因

独立复核 coder 结论「#206 门控链无漏,入口可见是 codex-acp 自声明 fork 的正确产物」
(源 worklog:`2026-09-09-fork-gate-leak-206.md`,main 5676d1d)。本卡零码改,按核查清单
①wire 复跑 ②前端消费点枚举 ③fail-closed 路径 逐项重验,不采信 coder 叙述。

## 结论:复核通过,APPROVE

coder 三项核心断言全部独立复现,门控链无漏点成立。发现两处**非漏点**的观察项
(见「观察项」),不推翻结论,是否补测试/上报上游留人裁决。

## 核查记录

### ① wire 实证(本机 `~/.bun/bin/codex-acp` 真实 stdio JSON-RPC,独立复跑)

- **Initialize 声明**:响应 `agentCapabilities.sessionCapabilities` 含
  `{"resume":{},"list":{},"close":{},"delete":{},"fork":{},"additionalDirectories":{},"subagents":{}}`
  —— fork 声明在场,与 coder 记录一致。
- **零回合 fork**:`session/new`(cwd=/tmp)得 `01a081d3-c23e-…` → `session/fork`
  → `{-32603 "Internal error","data":{"details":"no rollout found for thread id …"}}`
  —— 与 #172 先例一致(−32603 非 −32601),「错误码不作门控依据」铁律前提仍成立。
- **非空 fork**:`session/load` 既有 rollout `01a081c0-5ed9-…`(coder 探针产物,cwd=/tmp,
  回放 5 条通知)→ `session/fork` → **成功**,新 sessionId `01a081d3-c320-…` 且带
  configOptions —— codex-acp 对有历史会话 fork 真实可用。
- **新发现(补充,不改变结论)**:codex-acp 的 `session/fork` **要求 params 带 `cwd`**,
  缺失报 `-32602 Invalid params`。本仓客户端恒传 cwd(`internal/acp/runner.go:755`
  `Cwd: cs.WorkDir`,铁律②),生产路径不受影响;反向印证铁律②与探针⑥的必要性。
- **应用内 -32603 不可达(代码序验证,`internal/chat/chat.go` ForkSession)**:
  GetSession(:1173)→ busy 拒绝(:1180)→ `SessionHasMessages`(:1187)→
  `errForkSourceEmpty` 返回(:1192)→ ensureLive(:1197)→ `CanFork()`(:1206)→
  Fork RPC(:1231)。空会话拦截位于**任何 spawn/RPC 之前**(:1186 注释明示);
  `SetSessionForkedFrom` 全仓唯一生产写入点 = ForkSession(:1265),无旁路建行路径。
- 复跑副作用:探针新建 rollout `01a081d3-c23e-…`(空)与 `01a081d3-c320-…`(fork 产物),
  落 `~/.codex/sessions/`,与 coder 探针同类,无清理需求。

### ② 前端消费点枚举(反查验证,非顺叙述)

全 `frontend/src` grep(`canFork|sessionFork|onForkSession|forkSession|ForkSession` + `fork` 兜底):

- **`sessionFork` 全仓唯一读取点**:`App.tsx:1404` `!!harnessCaps[s.harness]?.sessionFork`
  —— 默认关,无 `?? true`,无第二处独立判断。
- **`forkSession` 全仓仅两个调用点**:`App.tsx:2569`(Sidebar 面)、`:2674`(ChatView 面)
  —— 无键盘快捷键、无第三入口。
- **Sidebar**:`Sidebar.tsx:1223` `props.canForkSession?.(ctx.session) && props.onForkSession &&`
  双门,undeclared 菜单项不渲染(`Sidebar.fork.mount.test.tsx` 钉死)。
- **ChatView**:`App.tsx:2673` 传 `canFork` → `ChatView.tsx:869`
  `(props.canFork ?? false) && row.kind === "agent" && row.first === lastAgentIdx`
  → `:1050` 仅 canFork 时给 `fork` prop → `MessageActions` `:1255/:1267` 仅 fork 对象
  非空才渲染(busy→disabled+tooltip)。声明位与、`?? false` 兜底齐全
  (`ChatView.fork.mount.test.tsx` 5 用例钉死:declared 渲染+点击、undeclared 隐藏、
  busy 置灰、user 行无、文案)。
- **GitFork 徽章** `Sidebar.tsx:1026`:`s.forkedFrom ?` 血缘标记,非入口。
- **NewSessionModal/Composer 的 "fork"**:git worktree 新建会话链路
  (`md/<id>` 分支 fork),与 #172 ACP fork 是两个特性,不受此门控(设计如此)——
  逐一读其注释/调用确认,非漏报。
- **popout**:独立 Wails 窗口(`desktop.go` `popout-<sid>`)加载同一前端,App 挂载相同,
  `popoutMode` 取自 URL hash(`App.tsx:160`);能力拉取 effect(`:1394-1398`)不
  以 popout 条件化 → popout 照常拿到 harnessCaps;popout 隐藏 Sidebar,ChatView 入口可用。

### ③ fail-closed 路径与 id 一致性

- **spawn 失败** → 零值矩阵(全 false)+ ProbeErr(`internal/acp/capability.go:163-167`)。
- **NewSession 失败** → 仅已得声明位 + ProbeErr(`:174-182`),无 all-true 占位。
- **位抽取**:`matrixFromInit` `SessionFork = SessionCapabilities.Fork != nil`(`:119`);
  JSON tag `sessionFork`(`:50`)→ 生成绑定字段名一致(前端类型自 `../bindings/...`
  生成物导入,`App.tsx:7`;bindings 为 gitignore 生成物,CI frontend job 已按 #209
  钉版生成后再 tsc,字段名错链会直接红);`capability_test.go` 三态
  (declared :53 / 空 :75 / 部分 :97)钉死。
- **live 路径声明位**:NewChatSession(`runner.go:152`)与 ResumeChatSession(`:242`)
  均自 initResp 取 `Fork != nil`;`ChatSession.Fork` 再自检(`:721`)→
  `ErrForkNotDeclared` 不发 RPC;chat 层三检(`chat.go:1206`)。
- **capabilityCache** 仅 `probeCapabilitiesAsync` 写入,合并保留旧项
  (`chat.go:3477-3488`);前端初载 `useState({})`(`App.tsx:221`)+ `m ?? {}`(`:1390`)
  → 未探测/事件未达 = 隐藏,fail-closed。
- **resolveHarnessID**(`chat.go:3315-3349`):内置 → catalog(harnessCache)→ 用户
  harness(store)三方查重,`-2/-3…` 有界消歧;session.harness 与 capabilityCache 同以
  `harness.ID` 为键,无别名撞键查错 caps 的路径。

## 观察项(非漏点,不阻塞 APPROVE)

1. **`errForkSourceEmpty` 无单测钉死**:`internal/chat` 既有测试覆盖了
   `errForkSourceBusy`(TestForkSessionSourceBusyRejected)与
   `ErrForkNotDeclared`(TestForkSessionUndeclaredTypedError),唯独空会话守卫
   只靠代码序保证。守卫本体本次已按代码序复核无误;若要补
   `TestForkSessionSourceEmpty`(mock 注入空 session → `errors.Is(errForkSourceEmpty)`
   + fakeChat 未被触达),另派 coder 卡,本卡零码改未动。
2. **codex-acp(上游 Zed adapter)对 fork 的声明语义**:零回合场景 `-32603` 属上游
   声明/实现不一致,按铁律①本仓不做行为级门控;维持 coder 的 OPEN 不变,是否上报
   上游留人。

## 改了哪些文件

无代码改动。本文档一条(review worklog)。

## 验证

1. **wire 复跑**(eval 内 Python stdio 探针,真实 `codex-acp`):三项断言全复现,见 ①。
2. **既有 fork 门控单测**:`go test ./internal/chat/ -run 'TestForkSession|TestNonForkSessions'`
   与 `go test ./internal/acp/ -run 'TestMatrixFromInit|TestCapabilityMatrix'` 均 ok。
3. 消费点枚举以 grep 反查为准(`sessionFork` 唯一读取、`forkSession` 唯二调用),
   非顺 coder 叙述;逐点肉眼核对渲染/传递条件(防「类型补丁」反模式)。

## 下一步 / OPEN

- issue #206 维持开,关单动作留人(任务规定)。
- 观察项 1(空会话守卫补测试)是否立卡,留人裁决。
