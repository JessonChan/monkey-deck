# PROCESS.md

> 本文件是 monkey-deck 的**活文档 / 开发追踪单**。它和 AGENTS.md 的分工:
> - **AGENTS.md = 规矩**(稳定契约,改它要走流程,见其 §6)。
> - **PROCESS.md = 进度**(随每次工作在变,记录「现在做到哪、决策为什么、下一步干什么」)。
>
> **任何 agent 动手前必读 AGENTS.md + 本文件;收工前必更新本文件。** 详见 AGENTS.md §0.3。

---

## A. 使用方法(每次工作的标准循环)

每次(每个 agent / 每个会话)参与本项目,严格走这个 4 步循环:

1. **开工前 —— 对齐状态**
   - 读 AGENTS.md(规矩)+ 本文件(当前进度)。
   - 找到「当前阶段」(§B)和「当前焦点」,确认要做的事在 §C 看板的哪一项、状态是什么。
   - 有 OPEN / 阻塞(§F)先看清楚,别踩。

2. **规划 —— 写进看板**
   - 把要做的事拆成具体任务,写进 §C 当前阶段任务清单,状态置 `in-progress`。
   - 涉及架构 / 技术选型决策的,先在 §E 决策记录里记一笔(为什么这么选),再写代码。

3. **执行 —— 边做边记**
   - 严格遵守 AGENTS.md 硬约束(纯 ACP、进程组回收、SQLite 本地真相 等)。
   - 踩到坑 → 先记进 AGENTS.md §5.4 + 本文件 §G 工作日志,再修。

4. **收工前 —— 更新本文件(必做)**
   - §B 进度快照刷新(现在能跑吗 / 卡在哪 / 下一步)。
   - §C 看板:完成的任务 → `done`,未完成的留 `in-progress` 并注明卡在哪。
   - §G 工作日志:追加一条「日期 / 做了什么 / 改了哪些文件 / 验证方式 / 下一步」。
   - §F:新出现的 OPEN / 阻塞写进去;解决的标 ✅。
   - **没更新本文件就提交代码 = 不算完成。**

**状态标记约定**:`todo`(待做)/ `in-progress`(进行中)/ `done`(完成)/ `blocked`(阻塞,注明卡因)/ `skip`(暂跳)。

---

## B. 当前进度快照

- **当前阶段**:阶段 0(地基)—— ✅ **完成,已过验收线**
- **当前焦点**:阶段 0 全部任务完成,已用 server 模式驱动 GUI 完成真实 opencode ACP 多轮对话 + 历史恢复
- **最后更新**:2026-06-26(阶段 0 收官)
- **可运行状态**:✅ 完整可运行。`make dev`(桌面)/ `make server`(HTTP 验证)。已验证:Init→NewSession→Prompt→end_turn、两轮对话、reload 历史恢复、进程组回收

> 每次收工时刷新这一节,让人一眼看到「现在能跑吗、卡在哪、下一步是什么」。
- **当前阶段**:阶段 1(多项目/多 session/历史恢复/用量)—— 基本完成,迭代打磨中
- **当前焦点**:布局可调(三栏可拖拽分隔线)+ 源码管理面板 SCM 化 + 会话标题修复已完成;源码管理逻辑审查 5 项修复完成;继续对话体验打磨
- **最后更新**:2026-06-29
- **可运行状态**:✅ 端到端可跑 —— Wails3 单进程 + opencode ACP 多 session 对话、历史恢复(LoadSession)、权限 UI、SQLite 本地落盘、token 用量统计、会话标题(opencode 经 session/list 权威标题 + 瞬时 fallback)、源码管理 SCM(提交/暂存/丢弃/单文件 diff/并发守卫)、三栏可拖拽分隔线。`go test ./internal/...` 通过、前端 `tsc` + `vite build` 通过。
- **近期改动汇总**:
  - **源码管理逻辑审查 5 项修复**(2026-06-29):① merge 不再 AutoCommit(只合并已提交内容,SCM 面板成提交唯一真相)② StatusFiles 修重命名 `->`/空格引号 ③ 单文件 diff(FileDiff+点击展开)④ turn 进行中禁用 SCM 写操作(前后端 busy 守卫)。详见 §G。
  - **会话标题修复**(2026-06-29):经 session/list 取 opencode 权威标题(三层:本地 fallback + session/list 轮询 + session_info_update 预留)+ 能力守卫 `CanListSessions`(协议 MUST);撤销 LLM 自生成方案。详见 §G。
  - **三栏可拖拽分隔线**(2026-06-29):react-resizable-panels v4(Group/Panel/Separator),尺寸持久化 localStorage。详见 §G。
  - **源码管理面板 SCM 化**(2026-06-28):后端 worktree `FileChange.Staged` + `Stage/Unstage/Discard/Commit` 原语 + `StatusFiles` 拆暂存/工作区;chat 加 4 个 SCM 绑定;前端 GitPanel 重建成 VSCode SCM(提交框 + 暂存/工作区两组 + 逐文件操作);修 WKWebView confirm 静默失效(discard 改显式点击)。
  - **代码审查 5 项修复**(2026-06-28):persistTurn 顺序、startTurn 写失败感知、KillAll 限定本应用 pgid、ChatView 贴底滚屏、Composer keyCode。详见 §G。
  - 审查中判定非 bug / 不改:#3/#4/#6/#9/#10/#12/#13/#14/#17/#18/#19/#20;#7/#8 误报。

---

## C. 阶段看板(镜像 AGENTS.md §3.1,细化到任务)

### 阶段 0(地基)—— 当前阶段

| # | 任务 | 状态 | 备注 |
|---|---|---|---|
| 0.1 | Wails3 脚手架(React19+TS+Vite + go module + main.go + Makefile) | done | go.mod/build/frontend/Taskfile/main.go 齐全,可编译 |
| 0.2 | `internal/acp/`(Handler 回调 + Runner + ChatSession 生命周期,照搬 RAK) | done | handler.go/runner.go/proc.go,ACP client 完整 |
| 0.3 | 单 harness(opencode)接入:Init→NewSession→Prompt→StopReason | done | 集成测试验证 end_turn + agent 回复 |
| 0.4 | 进程组回收(Setpgid + kill -PGID + 活跃集合 + 精确 reap) | done | proc.go,启动时清 3 个残留 opencode 已验证 |
| 0.5 | SQLite schema v1 + `internal/store/`(projects/sessions/messages/settings) | done | modernc.org/sqlite 纯 Go,CRUD 测试通过 |
| 0.6 | 前端对话视图:binding + event 流式渲染 SessionUpdate | done | React19,流式 chunk/工具卡/思考块/用量条 |
| 0.7 | model 注入(cwd 写 opencode.json,provider/model 格式) | done | runner.WriteModelConfig;实测 zai/glm-4.6 |
| 0.8 | 端到端验证:单项目单 session 一轮对话跑通 | done | server 模式驱动 GUI 两轮对话 + reload 恢复 |

**阶段 0 验收**:能新建一个「项目(目录)」,在 UI 里发一句话,看到 opencode 通过 ACP 回复并流式展示,进程干净退出不泄漏。

### 阶段 1(待阶段 0 验收后细化)
- [x] 多项目 / 目录管理
- [x] session 列表 + `LoadSession` 恢复
- [x] 用量统计展示
- [x] 重启后状态恢复
- [x] 会话状态隔离(切会话不丢进行中输出)— 2026-06-28
- [x] token 用量持久化(重开恢复占比)— 2026-06-28

### 阶段 2 / 3+:见 AGENTS.md §3.1、§7(推迟)

---

## D. 待定 / 待确认

- [x] ✅ Go module 路径 = `github.com/jessonchan/monkey-deck`(已确认,2026-06-26)
- [x] ✅ SQLite 驱动 = `modernc.org/sqlite`(纯 Go,免 CGO;已确认,2026-06-26)
- [ ] 数据目录默认路径(macOS `~/Library/Application Support/monkey-deck/`)
- [ ] opencode 是否本机已装 / 如何探测版本

---

## E. 决策记录(ADR-lite)

> 只记「为什么这么选」,不记实现细节。格式:日期 — 决策 — 理由。

- **2026-06-26** — 用纯 ACP 而非 CLI 子进程管理 agent。理由:协议一致性是核心赌注,见 AGENTS.md §1.1。
- **2026-06-26** — 桌面单进程(Wails3),不拆 server/daemon。理由:单用户场景,简化是优势,见 AGENTS.md §2.2。
- **2026-06-26** — `RequestPermission` 走 UI 交互而非无头自动裁决。理由:桌面有人在场,见 AGENTS.md §3.4。
- **2026-06-26** — module 路径定为 `github.com/jessonchan/monkey-deck`。理由:用户确认。
- **2026-06-26** — SQLite 驱动用 `modernc.org/sqlite`(纯 Go)。理由:免 CGO,Wails 跨平台打包更省心。
- **2026-06-26** — 借用 wesight 代码必须保留 MIT 署名。理由:wesight 为 MIT 协议,见 AGENTS.md §0.4。
- **2026-06-26** — Git 多提交、原子提交纪律。理由:用户要求,见 AGENTS.md §6.2。
- **2026-06-26** — harness 懒启动(lazy spawn):CreateSession 只建 DB 记录,首条消息时才 spawn opencode。理由:opencode stdio ACP 空闲即断连(AGENTS.md §5.4 #9),懒启动避免 idle disconnect + 省资源。
- **2026-06-28** — ACP 协议无 queue,「turn 中途发新消息」用 **cancel-then-reprompt**(`session/cancel` → 等 cancelled → 新 prompt),不造协议层 queue。理由:`session/prompt` 同步请求-响应,baseline 只保证 new/prompt/cancel/update,无排队语义(见 SDK schema + prompt-turn 文档)。排队缓冲做在前端(FIFO,turn 结束自动续发),打断走干净 `session/cancel`(InterruptAndSend 原子化)。见 AGENTS.md §5.4 #13。
- **2026-06-29** — 三栏可拖拽分隔线用 `react-resizable-panels`(v4)而非手写。理由:§5.3 成熟库优先;v4 是重写版(Group/Panel/Separator,非旧 PanelGroup/PanelResizeHandle),尺寸用字符串百分比、`orientation`、`useDefaultLayout` 持久化。wesight 的 col-resize 是手写,仅作形态参考不照搬。
- **2026-06-29** — 会话标题取 opencode 经 `session/list` 的权威标题,不在客户端调 LLM 自生成。理由:opencode 已生成标题并存自身库,客户端再调 LLM 是重复且更慢(第一版 LLM 方案已撤销,-320 行)。opencode 实证不发 `session_info_update`(协议首选实时路径,属 opencode 实现缺口),故退化到 `session/list` 轮询(turn 结束后取),并加 `CanListSessions` 能力守卫(协议 MUST:未声明 `sessionCapabilities.list` 不调用)。三层策略:本地 `FallbackTitle` 瞬时兜底 + `session/list` 轮询 + `session_info_update` 分支预留。见 AGENTS.md §5.4 #14。

---

## F. OPEN 问题 / 阻塞

> 未决问题、已知缺陷、卡住的事。解决的标 ✅ 并注明。

- ✅ **脚手架无 `main.go`**:已补 main.go(Wails3 入口 + ChatService 注册),完整可编译可运行。
- 🚧 **身份占位待改**:`Taskfile.yml` APP_NAME 仍为 `testapp`、`build/config.yml` productName 等占位值,需统一改 monkey-deck(功能不受影响)。
- ✅ 数据目录默认路径已定:`~/Library/Application Support/monkey-deck/`(xdg);opencode 探测用 `opencode acp` + `exec.LookPath`。
- [ ] 数据目录默认路径、opencode 探测(§D 遗留)

---

## G. 工作日志(追加,最新在上)

### 2026-06-29(fix:源码管理逻辑审查 5 项修复 —— merge 语义 / 路径解析 / diff 预览 / 并发守卫)
- **起因**:对源码管理(worktree + GitPanel + chat SCM 绑定)做一轮逻辑审查,找到 5 处不合理:
  - **A(设计冲突)**:`MergeSession` 用 `AutoCommit`(git add . + commit)在合并前一把抓所有改动,无视 SCM 面板里用户的精细暂存 —— 用户刻意没暂存的文件也被合并进主仓库,且 message 被覆盖成 session 标题。
  - **B(bug)**:`StatusFiles` 不解析 porcelain 重命名 `R old -> new` 的 `->`,path 变成整串,后续 add/checkout 全失效。
  - **C(bug)**:含空格/特殊字符路径被双引号包裹,`TrimSpace` 不去引号 → git 命令命中不了。
  - **D(缺失)**:无 diff 预览,点击文件看不到改动。
  - **E(竞争)**:turn 进行中 opencode 写文件时,用户可同时在面板 stage/commit/discard,git index 与 opencode 写入竞争。
- **修法**:
  1. **A**:`chat.go` `MergeSession` 删掉 `AutoCommit` 调用,改为只 `MergeBranch`(git merge 本就只合并 commit);若有未提交改动,结果里给出提示(计数 + 「请去源代码管理面板提交」)。删除 `worktree.AutoCommit`(成死代码,§5.3 Less is More)。SCM 面板成为提交的唯一真相来源。
  2. **B+C**:`worktree.go` `StatusFiles` 解析 path 后:① 检测 ` -> ` 取重命名新名;② `strings.Trim(path, "\"")` 去外层引号。新增 `gitDiff`(diff 退出码 1=有差异属正常,不报错)。
  3. **D**:新增 `worktree.FileDiff(path, staged)`(staged→`diff --cached`;未跟踪→`--no-index /dev/null` 展示纯新增)+ `chat.SessionFileDiff` 绑定;`GitPanel` 文件名改可点击按钮,点击展开 inline `<pre>` diff(同一时刻只展开一个,staged 决定上下文)。`App.tsx` 加 `fileDiff` callback。
  4. **E**:`chat.go` 加 `isBusy`(读 `liveSession.busy`)+ `errSCMBusy`;`SessionStage/Unstage/Discard/Commit/MergeSession` 头部加 busy 守卫(读操作 `SessionChanges`/`SessionFileDiff` 不拦,可随时刷新)。前端 GitPanel 加 `busy` prop,turn 进行中禁用所有写按钮/提交框/合并 + 顶部「对话中」标记。
- **改了哪些文件**:
  - `internal/worktree/{worktree.go(删 AutoCommit;加 gitDiff/FileDiff;StatusFiles 路径解析), worktree_test.go(TestStatusRenameSpacesAndDiff 新增)}`
  - `internal/chat/{chat.go(errors 导入;MergeSession 重写;SessionStage/Unstage/Discard/Commit 加 busy 守卫;SessionFileDiff 新增;isBusy+errSCMBusy 新增), scm_test.go(strings 导入;TestMergeSessionNoAutoCommit+TestSCMBusyGuard 新增)}`
  - `frontend/src/{components/GitPanel.tsx(重写:onDiff/busy prop、文件名点击展开 diff、busy 禁用), App.tsx(fileDiff callback、GitPanel 传 onDiff/busy), index.css(.git-file-diff/.git-file-name-btn/.git-panel-busy 等)}`
  - `frontend/bindings/*(regen,新增 SessionFileDiff)`
- **验证**:`go test ./internal/...` 全过(含 `TestStatusRenameSpacesAndDiff` rename/空格/FileDiff 三场景、`TestMergeSessionNoAutoCommit` 已提交合并+未提交不合并+提示、`TestSCMBusyGuard` 5 写操作 busy 拒绝+读操作放行);`go vet ./internal/...` 干净;`go build ./...` 通过;前端 `bunx tsc --noEmit` + `bun run build:dev`(321 modules)通过。
- **未提交**:改动跨多文件、属同一逻辑主题(源码管理审查),建议按 A/B+C/D/E 拆原子 commit 或作为一组「源码管理审查修复」提交。

### 2026-06-29(fix:会话标题取 opencode 权威标题(session/list)—— 能力守卫 + 撤销 LLM 自生成)
- **背景**:上一版(2026-06-28)用「自己调 LLM 生成标题」修「标题一直是第一句话」。用户指出 opencode 每个 session 本就有标题,应直接取。复核发现上一版是「错路的正确实现」。
- **深入诊断(实证)**:
  - opencode 1.17.10 **生成**标题并存自身库 `~/.local/share/opencode/opencode.db` 的 `session.title`(如 `ses_...` →「README 中文化及安装说明」)。
  - 它**不发** ACP `session_info_update` 通知(上一版已证实),但**经 ACP `session/list` 的 `SessionInfo.Title` 暴露**:诊断程序 turn 结束后 `conn.ListSessions` 第一轮 poll(0 延迟)即返回该标题。
  - → 真正的修法是协议级读 opencode 标题,不是自己再调一次 LLM(重复、更慢)。
- **协议事实核查**(对 `references/agent-client-protocol` 官方 repo):`session_info_update`(经 session/update 推送)与 `session/list` 的 `SessionInfo.title` 均于 2026-03-09 稳定。前者是首选实时路径("without polling"),opencode 不发 = opencode 实现缺口(非协议无能力);后者是能力门控发现路径——`session-list.mdx`:Clients **MUST** 先查 `initialize` 响应的 `sessionCapabilities.list`,未声明 **MUST NOT** 调。
- **修法**(三层):
  1. `internal/acp/runner.go`:新增 `ChatSession.SessionTitle(ctx)`(调 `conn.ListSessions` 过滤本 session 取 `Title`),**加 `CanListSessions` 能力守卫**(协议 MUST:agent 未声明 `sessionCapabilities.list` 不调用;`NewChatSession`/`LoadChatSession` 从 `initResp.AgentCapabilities.SessionCapabilities.List` 捕获)。
  2. `internal/chat/chat.go`:`chatConn` 接口加 `SessionTitle`;新增 `syncSessionTitle`(runPrompt/SendAndWaitSync 成功后调,标题不同则覆盖 DB + 推 `chat:session-meta`);`maybeAutoTitle` 用 `titlegen.FallbackTitle`(纯本地)作瞬时兜底;`handleEvent` 保留 `session_info_update` 分支(opencode 补发时自动生效)。**删除** `refineTitleAsync` 与 LLM 自生成路径。
  3. `internal/titlegen`:精简为只保留 `FallbackTitle/Normalize/BuildContext`(瞬时兜底),删除 `Generate`/provider 解析/HTTP/thinking 重试等 ~150 行(冗余)。保留 wesight MIT 署名。
- **改了哪些文件**:`internal/acp/{runner.go(SessionTitle+CanListSessions), runner_test.go(能力守卫回归,新)}`、`internal/chat/{chat.go(chatConn/syncSessionTitle/handleEvent/runPrompt/SendAndWaitSync/startTurn/maybeAutoTitle,删 refineTitleAsync), queue_test.go(fakeChat.SessionTitle+title 字段), title_test.go(新增 3 回归测试)}`、`internal/titlegen/{titlegen.go(精简),titlegen_test.go(精简),删 live_test.go}`、`AGENTS.md`(§5.4 #14 重写 + 协议核查⑤)、`PROCESS.md`(本节 + §B/§E)。
- **验证**:`go test ./internal/...` 通过;`TestSyncSessionTitle{Overrides,EmptyNoClobber,SameNoRewrite}` ✅;`TestSessionTitleCapabilityGuard`(能力缺失不调 Conn)✅;诊断程序(listdiag,已删)证实 `session/list` 第一轮 poll 得 opencode 标题「README 中文化及安装说明」✅。

### 2026-06-29(feat:三栏布局可拖拽分隔线 — react-resizable-panels v4)
- **起因**:用户要求左中右三栏分隔线可拖拽改变区域大小(原固定 256px / flex:1 / 240px,纯静态 border 发丝线)。
- **选型(§5.3 成熟库优先)**:`react-resizable-panels@4.12.0`(业界标准)。⚠️ **v4 是重写版,API 与 v2 完全不同**——用 `Group`/`Panel`/`Separator`(非 `PanelGroup`/`PanelResizeHandle`);尺寸用字符串百分比(`"18%"`,纯数字=像素);`orientation`(非 `direction`);持久化用 `useDefaultLayout` hook。wesight 的 col-resize 是手写,不照搬(库优先)。
- **实现**:
  1. `App.tsx`:外层 `<div class=app>` → `<Group orientation=horizontal>`;Sidebar/`<main>`/GitPanel 各包一层 `<Panel>`(id + min/max/defaultSize 百分比);栏间插 `<Separator class=resize-handle>`;git 栏条件渲染用 `<>...</>` Fragment(**Separator/Panel 必须是 Group 的直接 DOM 子元素**,Fragment 不产生 DOM 故可用);`useDefaultLayout({id:"monkey-deck-layout", onlySaveAfterUserInteractions:true})` 把拖拽位置存 localStorage,重开恢复(且只存用户主动拖拽,不被 git 栏出现/消失的自动重排污染)。
  2. `index.css`:`.sidebar`/`.git-panel` 去固定 `width`+`flex-shrink:0`,改 `width/height:100%` 填满各自 Panel;去掉 `border-right`/`border-left`(Separator 接管分隔视觉);`.main` `flex:1`→`width/height:100%`(保留 `min-width:0`);新增 `.resize-handle`(6px 命中区、col-resize、hover + 拖拽态高亮 accent)。**v4 拖拽态属性 = `data-separator="active"`**(实证:grep 源码 `"data-separator": G`,G 取 active/inactive),非旧版 `data-resize-handle-state`。
- **改了哪些文件**:`frontend/package.json`(+react-resizable-panels)、`frontend/src/App.tsx`、`frontend/src/index.css`、PROCESS.md(本节 + §B/§E)。
- **验证**:`bunx tsc --noEmit` ✅;`bun run build:dev` ✅(315 modules transformed,含新库);DOM 约束(Separator/Panel 直接子元素)已对照 v4 d.ts 确认。
- **下一步**:实机拖拽体验验证(`wails3 dev`);可选——左栏 collapsible + 折叠按钮。

### 2026-06-28(feat:源码管理面板 SCM 化 —— 参考 references/vscode,提交工作流 + 暂存/工作区两组)
- **起因**:用户反馈「源码管理面板还是不对,想想 VSCode 怎么处理的」,并在 references/ 放入 vscode 源码。诊断旧 GitPanel 缺失 SCM 的核心:无提交信息框、无提交按钮(只有「合并进主仓库」且用 session 标题自动提交)、无暂存/工作区两组分离、无逐文件 stage/unstage/discard、`expanded` toggle 是死交互(无 diff)、`commitCount` 永远 0。对照 `references/vscode/src/vs/workbench/contrib/scm/browser/scmViewPane.ts` + `scmInput.ts`:SCM = 提交信息框(InputRenderer)+ 提交按钮(ActionButtonRenderer)+ Changes/Staged Changes 两组(ResourceGroupRenderer)+ 逐文件操作(ResourceRenderer)。
- **后端 `internal/worktree/worktree.go`**:
  - `FileChange` 加 `Staged bool` 字段(一个文件可能同时进两组,如 MM)。
  - **修一个 latent bug**:新增 `gitRaw`(不 TrimSpace)。`git()` 对整体输出 TrimSpace 会吞掉 porcelain **首行**前导空格(` M a.txt`→`M a.txt`),导致 XY 列错位(首文件被误判 staged + path 被切掉首字母)。旧代码用 `TrimSpace(line[:2])` 掩盖了无法区分暂存/工作区;拆分版暴露后用 `gitRaw` 修。
  - `StatusFiles` 重写:解析 XY 两列,X→暂存组、Y→工作区组,MM 等双态产出两条。
  - 新增 `Stage`(add -A / add -- paths)、`Unstage`(restore --staged)、`Discard`(已跟踪 checkout / 未跟踪 clean,用 ls-files 区分)、`Commit`(commit index,区别于 AutoCommit 的 add-all)。
- **后端 `internal/chat/chat.go`**:加 `worktreeOf(sessionID)` helper + `SessionStage/SessionUnstage/SessionDiscard/SessionCommit` 绑定。SCM 操作只碰 store+worktree,不碰 ACP/opencode,故单测无需启 harness。
- **绑定 regen**:`make bindings`(wails3 alpha2.106)。CLI 现生成 `.js`(JSDoc + class)而非旧 `.ts`;tsconfig 无 allowJs 但 `noImplicitAny:false`,tsc 通过、运行时字段正确。
- **前端 `GitPanel.tsx`** 重写成 VSCode SCM:提交信息 textarea(Cmd/Ctrl+Enter 提交)+ 提交按钮(显示暂存计数、无暂存或空消息禁用)+「暂存的更改」/「更改」两个可折叠组 + 逐文件 stage/unstage/discard + 组级「全部暂存」「全部取消暂存」+ 原合并按钮。去掉死的 expanded toggle 与 commitCount prop。
- **前端 `App.tsx`**:加 `stageFiles/unstageFiles/discardFiles/commitSession` 4 callback(每次操作后 `SessionChanges` 刷新;commit 失败 rethrow 让面板保留信息+内联报错),接入 GitPanel。
- **实测坑**:`window.confirm` 在 WKWebView 不保证桥接(不桥接则 no-op 返回 false → discard 永不执行,静默坏)。去掉 confirm,discard 改显式点击 + tooltip「丢弃改动 · 不可撤销」。
- **改了哪些文件**:`internal/worktree/{worktree.go, worktree_test.go}`、`internal/chat/{chat.go, scm_test.go(新)}`、`frontend/src/{App.tsx, components/GitPanel.tsx, index.css}`、`frontend/bindings/*(regen)`、`PROCESS.md`(本节+§B)。
- **验证**:`go test ./internal/worktree/ ./internal/chat/` 通过(含 `TestStageUnstageCommitDiscard` + `TestSCMBindings` + `TestSCMNoWorktree`,真实 git worktree,不启 opencode);`go build .`、`go vet ./internal/...`、`go test ./internal/...`(4 packages ok);前端 `tsc --noEmit` + `vite build` 通过。
### 2026-06-28(fix:代码审查 5 项确认修复 —— 持久化顺序 / 写失败感知 / KillAll 误杀 / 滚底打扰 / keyCode)
- **起因**:对 chat/acp/前端做一轮代码审查,列 21 条疑似问题。逐条核实代码事实后,**确认 5 条真 bug、2 条误报、其余非 bug/过度优化/阶段外**。
- **确认修复**:
  1. `#2`(`chat.go` persistTurn):写库顺序原为 thought→tools→agent,历史恢复时 tool 卡片排在 agent 回复之前,与实时流式不一致。改 thought→agent→tools。
  2. `#1`(`chat.go` startTurn):用户消息持久化只 `slog.Warn`,但已推 user_message_chunk,DB 失败则重开丢失。改为失败时回滚 busy + 推 error status + 返回 error;startTurn 签名 void→error,SendMessage/InterruptAndSend 传播。
  3. `#21`(`acp/proc.go` KillAllOpencode):启动时无差别杀所有 `opencode acp`,会误杀用户在其它终端跑的 opencode。引入 pgidFile(`dataDir/opencode-pgids.json`)持久化本应用 spawn 过的 pgid:register/unregisterHarness 落盘;`SetPgidFile` 在 ServiceStartup 配置;KillAllOpencode 只杀 pgid 命中文件者,杀完清空。新增 `proc_pgidfile_test.go`(3 用例:round-trip / 缺失&损坏容错 / 禁用态)。
  4. `#15`(`ChatView.tsx`):每条新消息强制 `scrollTop=scrollHeight`,用户向上翻阅历史被打断。加 `stickToBottomRef` + `onScroll`(距底 ≤80px 视为贴底),新消息只在贴底时滚。
  5. `#16`(`Composer.tsx`):移除已废弃的 `e.keyCode === 229`,`isComposing` 已覆盖 IME。
- **核实为误报(非 bug)**:#7 `handler.pending` —— 超时分支(151-162)与 ctx 取消分支(163-169)均 `delete(h.pending, id)`,无泄漏;#8 `runner.Prompt` watchdog goroutine —— `defer cancel()` 在 Prompt 返回时必然触发 `promptCtx.Done()`,goroutine 必退。
- **判定非 bug / 不改(理由)**:#3 `ls.chat` 不会在 Prompt 期间变 nil(interface 值,Close 不置 nil);#4 作者自承正确;#5/#9/#13 过度优化(每轮一次 map / 每消息一次 by-id SELECT / 每次 O(n) find,均可忽略,§5.3 KISS);#6 macOS `ps` 格式稳定且 grep 已窄;#10 空 DefaultModel 是设计(用 opencode global config);#11 drainQueue 在 await 前已置 prompting(#11 自相矛盾);#12 ref 模式正确(#12 自承对);#14 useCallback 稳定引用;#17 命名/行为均符合预期;#18 goroutine 追踪属阶段 3+;#19 `SetMaxOpenConns(1)` 是 modernc sqlite 串行化必需(设计选择);#20 HarnessCmd 无 UI 入口故无需持久化。
- **改了哪些文件**:`internal/chat/chat.go`、`internal/acp/proc.go`、`internal/acp/proc_pgidfile_test.go`(新)、`frontend/src/components/ChatView.tsx`、`frontend/src/components/Composer.tsx`、`PROCESS.md`(本节 + §B)。
- **验证**:`go build ./...` ✅;`go test ./internal/...` ✅(4 packages ok,含新增 3 用例);前端 `bunx tsc --noEmit` ✅。
- **下一步**:可拆 3 个原子 commit(① chat #2#1 ② acp #21+test ③ 前端 #15#16)提交。

### 2026-06-28(fix:会话标题自动生成 —— 修「标题一直是第一句话」)【已被 2026-06-29 方案取代,保留记录】
- 上一版用「自己调 LLM 生成标题」修。后续发现 opencode 本就生成标题、经 session/list 暴露,遂改为直接读(见上条 2026-06-29)。LLM 自生成代码已删除。
- (原始根因诊断仍有效:opencode 实证不发 `session_info_update`;只是标题来源从「自生成 LLM」更正为「opencode 经 session/list 暴露」。)

### 2026-06-28(fix:侧栏标题与 macOS 红绿灯重叠 + references 改绝对路径)
- **fix(ui)**:侧栏标题「Monkey Deck」与 macOS 红绿灯重叠。窗口用 `MacTitleBarHiddenInset`(main.go),红绿灯 overlay 在 webview 上,原 `padding-left:76px` 间隙不足。改 `frontend/src/index.css` 的 `.sidebar-header` `padding-left` 76→84px。
- **docs**:`references/` 不在 worktree 里(主源码树外部、不入库),worktree 读不到。AGENTS.md 的具体读取路径(§0.1/§0.2/§0.4/§2.1/§5.4)与 PROCESS.md 改用绝对路径 `/Users/jessonchan/temp/monkey-deck/references`;§0.2 增「绝对路径(给 git worktree 用)」说明块,声明下文 `references/xxx` 均指该绝对路径。
- 改动文件:`frontend/src/index.css`、`AGENTS.md`、`PROCESS.md`。
- 验证:CSS 热重载肉眼确认;路径绝对化 `grep` 复核。

### 2026-06-28(feat:对话排队 + 打断;修 StopSession 杀进程 bug)
- **起因**:问「ACP 是否有对话 queue」。调研结论(写进 §E + AGENTS.md §5.4 #13):**ACP 协议无 queue**——`session/prompt` 是同步请求-响应,turn 未结束不能发下一个;协议对「turn 中途发新消息」的唯一答案是 `session/cancel`(notification)→ agent 回 `StopReason::cancelled` → 再发新 prompt。即 **cancel-then-reprompt,非 queue**。RAK 的 queue 全是任务级看板派发(我们不做);wesight 非 ACP 无参考。
- **发现的 bug**:`StopSession` 原本 `ls.cancel()` 取消的是 **startLive 的 harness ctx**(`exec.CommandContext` 绑的)→ 直接**杀 opencode 进程**,而非干净 `session/cancel`。Stop 按钮实际是「干掉 agent」,下条消息得重新 spawn。修法:存 per-turn `turnCancel`,Stop/打断取消它(干净 session/cancel,harness 存活,连接可用)。
- **用户定的设计**:前端 FIFO 多条排队(队列面板,每条「立即发送」+「撤回编辑」),turn 结束自动续发;「立即发送」= interrupt(cancel 当前 + 这条插队先发,其余保留)。
- **后端**(`internal/chat/chat.go`):① `chatConn` 接口(供 mock 单测,§5.1);② `liveSession` 加 `busy/turnCancel/turnDone/suppressIdle/sendMu`;③ `runPrompt` 重写——turn 生命周期 + `turnCtx.Err()` 区分取消(干净 idle)/peer-disconnected(重连)/其它(error);emit 前清 busy;④ `startTurn` 同步置 busy(串行化);⑤ `SendMessage` busy 守卫;⑥ `InterruptAndSend`(cancel+等落定+发新,suppressIdle 防误触发 auto-continue);⑦ `StopSession` 改干净取消。`internal/acp/runner.go` 导出 `StopReason` 别名。
- **前端**(`frontend/src/`):App 加 `queue`/`composerValue` state + `userStoppedRef` + auto-continue effect(idle 时 FIFO 续发,用户 stop 抑制一次);`QueuePanel.tsx`(新,立即发送/撤回编辑);`Composer.tsx` 改受控文本 + 始终可发送(prompting 时排队)+ 进行中显停止键。
- **改了哪些文件**:internal/acp/runner.go、internal/chat/{chat.go, queue_test.go(新)}、frontend/src/{App.tsx, types.ts, components/{ChatView,Composer,QueuePanel(新)}.tsx, index.css}、frontend/bindings/...(regen)、PROCESS.md(本节 + §E)、AGENTS.md(§5.4 #13)。
- **验证**:`go build .` ✅;`go test ./internal/chat/` 5/5 ✅(TestBusyGuard/TestInterruptAndSend×2/TestStopSession + 旧 TestToolAccum);`bun run build:dev`(tsc+vite)✅。
- **未提交**:仓库有大量先于本会话的未提交改动(GitPanel/Sidebar/store/.js→.ts bindings 迁移等),我的前端改动依赖其中部分(如 GitPanel.tsx 未 tracked);单独提交我的文件会违反 §6.2「commit 必须能编译」,故留待用户整体提交。

### 2026-06-28(修:历史恢复 tool 卡片「显示 -、点不开」)
- **现象**:reload/恢复历史后,工具调用卡片状态显示破折号「—」、展开是空壳点不开;但实时对话里的 tool 能正常展开。
- **根因**:`internal/chat/chat.go` 的 `toolAccum` 字段全非导出小写,Go `encoding/json` 只序列化导出字段 → `persistTurn` 的 `json.Marshal` 产出 `"{}"` 写库;前端 `messagesToItems` 解析空对象 → title/status 空(破折号)+ rawInput/rawOutput 缺失(空壳)。实时路径走 SessionEvent 不经此 bug,故「有些能开、有些不能」。见 AGENTS.md §5.4 #12。
- **修法**:① toolAccum 字段导出+json tag,补 RawInput/RawOutput;handleEvent 填充 rawInput(tool_call)/rawOutput(tool_call_update);② 前端 messagesToItems 解析 rawInput/rawOutput;③ ToolCard 状态 fallback 空值显示「未知」而非破折号(新增 `.tc-unknown`)。
- **改了哪些文件**:internal/chat/{chat.go(6 处), toolaccum_test.go(新增回归测试)}、frontend/src/{App.tsx(messagesToItems), components/ChatView.tsx(fallback), index.css(.tc-unknown)}、AGENTS.md(§5.4 #12)、PROCESS.md(本节)。
- **验证**:go build ./... ✅;`TestToolAccumSerializesAllFields` ✅(marshal 含全部字段,非 `{}`);store 测试 ✅;`tsc --noEmit` ✅;before/after node 对比(旧 DB 破折号+不可展开,新 DB 正常)✅。


### 2026-06-28(参考 orca:每 session 独立 git worktree + 并行隔离/合并)
- **参考调研**:orca 用 PTY + per-agent hooks/plugins 集成任意 CLI agent(不强制 ACP);其"并行 worktree"= git worktree 隔离 + 标准 git merge/rebase + diff 对比选赢家,无自研合并算法。
- **新功能:每 session 一个 git worktree**:`internal/worktree/`(git worktree create/remove/merge/isRepo);DB migration 0002 加 worktree_path+branch;CreateSession 自动建 worktree+分支,session cwd 指向 worktree;DeleteSession/RemoveProject 清理;新增 MergeSession 绑定(git merge 进主仓库);UI 加分支标签+合并按钮。
- **验证**:测试 repo 上建 2 个 session → 各自独立 worktree+分支(md/<id>)→ 隔离确认(branch 改动不进 main)→ 点合并按钮 → feature.txt 进 main ✅。
- **约束更新**:AGENTS.md §1.4 补 worktree 说明(不违反 §1.1 纯 ACP,opencode 仍走 ACP,只换 cwd)。

### 2026-06-27(输出框增强 + wesight 多对话研究 + 关键发现)
- **输出框增强**(用户要求):ChatView 加代码块头(语言标签+复制)、agent 消息复制按钮、流式光标 ▋、工具卡输入复制;Composer 加工具栏(快捷指令 chips:解释代码/总结/找bug/重构 + model 指示 + 字数行数)。
- **wesight 研究**:复制 wesight 到 /tmp/wesight-study,经 ChatService 开 3 个对话(架构/功能/实现)各 10 题。
- **关键发现 1(用户纠正确认)**:opencode **完全支持同目录多对话**(每 session 独立 git snapshot),之前"同 cwd 不能并发"的判断错误。诊断证明:3 个全新并发 session 同 cwd + 文件读取题 全部通过。
- **关键发现 2(根因)**:多轮后 "peer disconnected before response" 的真因是 **model 不稳**——默认 `zai-coding-plan/glm-5.1` 持续多轮会断连;换 `zai/glm-4.6` 后 5 轮全稳。**不是 opencode/ACP 的问题,是 provider/model 的问题。** 见 AGENTS.md §5.4 #10。
- **多 session reaper 修复**:原 reapStrayOpencode 在单 session 假设下设计,多 session 并发时一个 session 失败清理会误杀其他活跃 session 的逃逸 worker。改为 reapIfIdle(仅当无活跃 session 时 reap)。
- **研究结论(监督者评判)**:3 对话共出 30 题,~22 题得到高质量代码级回答(带文件引用、具体表结构/IPC 通道/平台配置)。会话1【架构】9/10(A)、会话2【功能】10/10(A)、会话3【实现】~3/10 有实质内容(重文件读取题易空答/超时)。重试机制恢复了多数断连。
- **改了哪些文件**:internal/chat/{chat(增强输出+reapIfIdle+SendAndWaitSync+懒启动),composer/chatview}、internal/acp/proc(导出 ReapStrayOpencode+ActiveHarnessCount)、AGENTS.md(§5.4 #10)、本节。
- **下一步**:model/provider 路由 UI(让用户选稳定 model);空答问题(重读取题)待查是否 silent timeout 过早或 model 输出空。

### 2026-06-26(阶段 0 完整实现 + 验收)
- 从 wails3 react 模板接入 build/ + frontend/,落 go.mod(`github.com/jessonchan/monkey-deck`)+ main.go(Wails3 应用入口,注册 ChatService)。
- **ACP 层** `internal/acp/`:handler.go(SessionUpdate→SessionEvent 扁平化、RequestPermission 走 UI + 超时兜底、fs 透传、terminal 不支持)、runner.go(Runner + ChatSession 完整生命周期:spawn→Init→NewSession→Prompt→kill 进程组,静默超时,peer-disconnect 重连)、proc.go(Setpgid + kill -PGID + 活跃集合 + 精确 reap)。照搬 RAK 生命周期与回调模式。
- **Store** `internal/store/`:modernc.org/sqlite,嵌入式迁移,schema v1(projects/sessions/messages/settings),CRUD + 级联删除测试通过。
- **Service** `internal/chat/`:ChatService 组合 acp + store,Wails3 binding(15 方法)+ event(chat:event/permission/status)流式推前端;harness 懒启动(lazy spawn)解决 opencode 空闲断连。
- **前端** `frontend/src/`:React19 + react-markdown,项目侧栏 + 流式对话(消息/工具卡/思考块/用量条)+ 权限弹窗 + 手动路径输入(server 模式可用)。data-testid 齐全(§4.2)。
- **关键坑** opencode stdio ACP 空闲即断连 → 懒启动修法(见 AGENTS.md §5.4 #9)。
- **验证**:① `go test ./internal/acp` 集成测试(NewChatSession+Prompt→end_turn,agent 回复"你好！");② `go test ./internal/chat` 集成测试(ChatService 全路径对话);③ server 模式(`-tags server`)起 HTTP,用浏览器驱动 GUI:加项目→建 session→发消息→opencode 流式回复"🤖我是 opencode…"→第二轮"2"→reload 历史恢复(2 user + 2 agent)。
- **改了哪些文件**:main.go、go.mod/go.sum、Makefile、internal/{acp,store,chat,config}/**、frontend/src/**、AGENTS.md(§5.4 #9)、PROCESS.md(本节)。
- **下一步**:阶段 0 已过验收线。阶段 1(多项目/session 列表/用量/恢复)部分已顺带完成,剩余:多 harness 适配层、model/provider 路由 UI、设置页。
### 2026-06-28(对话体验打磨:会话隔离 / token 持久化 / 历史展示)
**问题与根因**
- 「切走再切回丢失正在输出的历史」:`App.tsx` 只有一个 `items` state + 事件处理按 `selectedSessionId` 过滤;切走后流式事件被丢弃,切回只重读 DB,而进行中的 turn 在 `runPrompt` 返回前未落库 → 进行中内容丢失。
- 「token 占比不好」:usage 完全不持久化(session 表无字段),重开会话清零;且进度条 3px、无百分比、配色单一。
- 历史可读性:无时间戳、多轮边界不清晰。

**改动(原子分组,待分别提交)**
1. `frontend/src/App.tsx`:`items/usage/status/permission` 改为按 session 的 map(`itemsBySession` 等);事件处理器去掉 `selectedSessionId` 过滤(总是写「事件所属 session」的缓存);`openSession` 有缓存则不重读 DB(保留进行中的流式);新增 `loadedSessionsRef` 标记已加载 session。`selectedSessionIdRef` 仅用于 status 事件的错误过滤,不进 effect 依赖(避免每次切换重订阅)。
2. `internal/store/migrations/0003_session_usage.sql`:`sessions` 加 `used_tokens/size_tokens/cost`。
3. `internal/store/store.go` + `sessions.go`:`Session` 加 `UsedTokens/SizeTokens int64`、`Cost float64`;`sessionColumns`/`scanSession` 统一列与扫描;新增 `UpdateSessionUsage`。
4. `internal/chat/chat.go`:`handleEvent` 收到 `usage_update` 回写 `UpdateSessionUsage`(cost nil 兜底)。
5. `frontend/src/components/ChatView.tsx` + `index.css` + `types.ts`:用量条加高/百分比/分级配色(`usage-low/mid/high/crit`)/`formatTokens` 支持 M;`ChatItem` 加 `ts`;回合分隔(`TurnDivider`)+ agent 消息时间戳(`formatTime`)。`App.tsx` `openSession` 从持久化恢复 token 占比。
6. `wails3 generate bindings` 重生(加 usage 字段;清掉 stale 的 DeleteSession/MergeSession/worktree)。

**验证**:`go test ./internal/...` 通过(含新增 `TestSessionUsagePersist`);前端 `bunx tsc --noEmit` 通过;`go build ./internal/...` + `go vet` 干净。
**改了哪些文件**:`frontend/src/{App.tsx,components/ChatView.tsx,index.css,types.ts}`、`frontend/bindings/.../{chatservice.js,models.js}`、`internal/{chat/chat.go,store/{store.go,sessions.go,store_test.go}}`、`internal/store/migrations/0003_session_usage.sql`。
**下一步**:可提交(建议拆 4 个原子 commit:① 切会话隔离 fix ② token 持久化 backend+test ③ 重生 bindings ④ 用量条+历史展示 UI)。
### 2026-06-26(续:脚手架接入、图标、版本核对)
- 发现用户并行搭建了 Wails3 脚手架(`go.mod` / `build/` / `frontend/` / `internal/{acp,store}` / `Taskfile.yml`),全部 untracked。
- 核对:wails CLI 与 go module 同为 `v3.0.0-alpha2.106`(= 最新);module 路径 + `modernc.org/sqlite` 已在 go.mod 落实。
- 按指令设图标:`monkey-deck-icon.png`(2048²)→ `build/appicon.png`,并 `wails3 generate icons` 重新生成 `darwin/icons.icns` / `windows/icon.ico` / `darwin/Assets.car`。
- 修 `.gitignore`:移除误加的 `/build/`(那是 Wails3 源码脚手架,须入库)。
- AGENTS.md §0.5 增「Wails 版本纪律」(CLI + module + bindings 三者同步、禁锁旧版)。
- **阻塞见 §F**:脚手架无 `main.go`(不编译)、APP_NAME=testapp、config.yml 占位值。首次脚手架 commit 待补 main.go + 改身份后再做。

### 2026-06-26
- 初始化项目:写 `AGENTS.md`(工程约束)+ `PROCESS.md`(本文件)。
- 调研参考:`/Users/jessonchan/temp/monkey-deck/references/real-agent-kanban` 的 ACP 实现(`internal/acp`)、`/Users/jessonchan/temp/monkey-deck/references/wesight` 的产品形态。
- 确认两项决策(§D→§E):module = `github.com/jessonchan/monkey-deck`;SQLite 驱动 = `modernc.org/sqlite`。
- 加固治理:AGENTS.md 增 §0.4(wesight MIT 署名)、§6.2(Git 多提交/原子提交纪律);`.gitignore` 排除 `references/` 与构建产物;git 仓库初始化(`main`)。
- **下一步**:启动阶段 0.1(Wails3 脚手架)。
