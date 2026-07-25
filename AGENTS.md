# AGENTS.md

> 本文件是**所有参与本项目的 agent（包括 AI 编码助手）在动手写代码之前的硬约束**。
> 它收敛「工程实施层面的不可妥协项」，防止实现偏离已定方向。
>
> 优先级:**用户当次指令 > 本文件的工程约束 > 个人判断**。
> 任何与本文件冲突的实现,必须先改本文件（说明理由）,不能直接违反。
> 本文件随项目演进持续更新,每条约束都要能回答「为什么有这条」。

---

## 0. 我们在做什么 / 不做什么（任何 agent 动手前必读）

**monkey-deck 是一个纯粹的 ACP（Agent Client Protocol）桌面客户端。**

- **一句话定位**:一个 Wails3 桌面应用,通过 ACP 协议驱动「实现了 ACP 的编码型 agent」（如 opencode / claude-code / kiro / hermes）,核心价值是**以「项目 / 目录」为单位管理 agent 的对话 session**。SQLite 本地落盘,UI 参考自 wesight。
- **工作原理是纯 ACP**:我们就是 ACP 协议里的 **client**（调用 `acp.NewClientSideConnection`），agent（harness）是 **server/peer**,双方在 stdio 上跑 JSON-RPC。**一切 agent 交互只走 ACP,不走 CLI 子进程 + stdout 解析。** 这是本项目的核心赌注。
- **不是多 agent 编排器**:不做 server/daemon 分离、看板协调、issue→task 分解、多 agent 编排、多租户。我们是单用户、单进程桌面客户端。

### 0.1 阅读顺序

1. **本文件** —— 搞清楚规矩。
2. **`docs/worklog/`** —— 搞清楚最近做到哪、下一步干什么(`ls docs/worklog/ | sort -r | head` 看最新几条)。**PROCESS.md 已停维**(历史归档,只读,见 §0.3)。
3. **ACP 协议怎么用**:查阅 ACP 协议规范与 `coder/acp-go-sdk`——我们是 client(调 `acp.NewClientSideConnection`,实现 `Handler` 回调),完整生命周期与回调见 §1.2/§1.3。
4. **UI / 产品形态参考(首选)**:`references/openwork`([github.com/different-ai/openwork](https://github.com/different-ai/openwork))——**与本项目最接近的同类产品**:opencode-first 的桌面 agent 客户端(Electron/Tauri + React),覆盖工作区/项目管理、session 管理、SSE 流式对话、执行计划(todos 时间线)、权限审批弹窗、model-select、各类 tool 卡片(apply-patch / bash / edit / file / glob / grep / lsp …)、markdown 渲染等**全套前端形态**。**这是最值得借鉴的 UI / 交互蓝本**。⚠️ **仅参考形态**——openwork 走 HTTP+SSE(`opencode serve` + `@opencode-ai/sdk`),**不是 ACP**;我们是纯 ACP,工作原理 / 数据通道一律不照搬。
5. **UI / 产品形态参考(补充)**:`references/wesight`([github.com/freestylefly/wesight](https://github.com/freestylefly/wesight))——统一 agent 管理、model 路由、运行时监控、菜单栏 HUD 等概念可作 UI 灵感。**仅参考形态,不照搬其工作原理**(wesight 多为 CLI 子进程管理,我们是纯 ACP)。

**禁止跳过阅读直接写代码。** ACP 生命周期搞错（比如把 client 当 server、漏掉 SessionUpdate 回调、Prompt 当成纯异步）是一切偏离的源头。

### 0.2 外部参考库是只读参考,放在机器级共享目录,严禁改动

- 外部参考项目集(`openwork`、`emdash`、`wesight`、`orca`、`opencode`、`agent-client-protocol` 等)是**只读**参考,**永不入库**,存放在**仓库外的机器级共享目录** `$MD_REF_DIR`(默认 `/tmp/monkey-deck-reference`,可用环境变量 `MONKEY_DECK_REFERENCE_DIR` 覆盖)。下文(含历史 worklog)出现 `references/<name>` 均指 `$MD_REF_DIR/<name>`。
- **为什么放仓库外共享目录、而不是仓库内 `references/`**:本项目 session 走 git worktree 模型(§1.4),`references/` 是 `.gitignore` 的,**不会被 checkout 进 linked worktree**——agent 在 worktree 里读不到仓库内的 `references/`。放机器级共享绝对路径,主检出 + 所有 worktree 共用同一份,既避免 `5GB × N` 重复,又让任意 worktree 都能读到。
- **严禁创建、修改、删除参考库下的任何文件**,严禁往里面写测试 / 构建产物 / 临时文件。要验证想法就在本项目自己的代码里验证。
- 只允许 `read` / `search` / `find` 获取知识。
- **获取参考(参考库不入库,克隆者 / AI 工具需自行拉取)**:清单(URL / 协议 / 用途)与一键同步都在**入库的** `scripts/references.sh`(单一事实来源,见其顶部 `REFERENCES` 表)。`bash scripts/references.sh` 浅克隆全部缺失项到 `$MD_REF_DIR`,`--status` 预览,`--pull` 更新,或 `task references -- --status`。这样无需把 ~5GB 内容入库:别人克隆后一条命令补齐;AI 编码工具读脚本即可"看见"参考目录。⚠ 默认 `/tmp` 在 macOS 会被 periodic(daily)回收(默认 3 天未访问即清理),需要持久化请用 `MONKEY_DECK_REFERENCE_DIR` 指向稳定目录。

### 0.3 开发追踪:docs/worklog/(PROCESS.md 已停维)

**开发过程只记在 `docs/worklog/`**:`docs/worklog/YYYY-MM-DD-<slug>.md`,一条一文件(约定见 `docs/worklog/README.md`)。每条自包含:**起因 / 根因(或协议调研、设计)/ 改法 / 改了哪些文件 / 验证 / 下一步**。

**PROCESS.md 已停维(2026-06-30 起)**:作为历史归档**只读保留**(进度快照 / 看板 / 决策 / OPEN / §G 旧日志全部冻结,不再更新)。**禁止往 PROCESS.md 写新内容**;它也不再是「开工前必读」——对齐进度只看 `docs/worklog/`。

**任何 agent 参与本项目,走这个 3 步循环:**

1. **开工前对齐**:读 AGENTS.md(规矩)+ `docs/worklog/` 最近几条工作日志(`ls docs/worklog/ | sort -r | head`,搞清上次做到哪、有什么坑 / OPEN)。
2. **执行守规**:严格遵守本文件硬约束;踩到坑先记(§5.4 + 新建 `docs/worklog/` 条目)再修。
3. **收工前记录(必做)**:在 `docs/worklog/` 新增一条工作日志(`YYYY-MM-DD-<slug>.md`),记清「做了什么 / 为什么 / 改了哪些文件 / 怎么验证的 / 下一步」。决策(为什么这么选)、OPEN / 阻塞、踩坑都写进这条即可,不再分散到别处。

**硬纪律**:
- **开工前不读 `docs/worklog/` 最近日志 = 盲干**(不知道上次做到哪、有什么 OPEN / 阻塞)。
- **收工前不写 `docs/worklog/` 条目 = 不算完成**(下一个接手的 agent 会断片)。代码 commit 与 worklog 新增应同步。

### 0.4 借用代码的协议署名(覆盖 references/ 下全部参考项目)

- **凡从 `references/` 下任何项目借用 / 改写代码,必须按其原始开源协议保留版权署名。**各参考项目的协议见 `scripts/references.sh` 顶部 `REFERENCES` 表(单一事实来源);**借用前以各项目根目录的 `LICENSE` / `NOTICE` 原文为准**(表格仅作索引,不替代核对)。
- **文件级**:被借用代码的文件顶部保留原版权声明与许可文本(copyright 行 + 协议要求的全文——MIT 须保留 "Permission is hereby granted..." 全文;Apache-2.0 须保留 LICENSE 全文 + NOTICE + 标注修改)。
- **项目级**:在 `THIRD_PARTY_LICENSES.md`(或 `NOTICE.md`)登记一条「来源项目 / 协议 / 借用了哪些文件 / 原版权声明」。
- **协议特殊点(已知)**:openwork 整体 MIT,但 **`ee/` 目录是 Fair Source License、非 MIT**——**借用时避开 `ee/`,只从 MIT 部分(`apps/`、`packages/` 等)取**。其他项目若仓库内多协议混排,同理以所借文件实际适用的协议为准。
- **禁止**把借用代码当成原创、抹掉版权声明。借一行也算;只参考思路(不抄代码)不受此约束。

---

## 0.5 技术栈与命令（实际落地）

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面框架 | **Wails3**（v3,跟最新 alpha）| 单一 Go 进程:后端逻辑 + 前端 webview + 子进程管理全在这里,**没有 daemon/server 分离** |
| 后端 | Go 1.26+,单一 module `github.com/jessonchan/monkey-deck` | Go 进程 spawn harness 子进程并独占 ACP 连接 |
| ACP | `github.com/coder/acp-go-sdk`(跟进最新稳定版)| 唯一的 agent 通道 |
| 持久化 | **SQLite** + `modernc.org/sqlite`(纯 Go 驱动,免 CGO)+ `golang-migrate/v4` | 本地单文件是真相来源,无中央数据库 |
| 前端 | React 19 + TypeScript + Vite（Wails3 官方 React 模板）,Bun 管理依赖 | 通过 Wails3 **binding（Go 方法暴露给前端）+ event（后端推前端）** 与 Go 交互 |
| 配置 | 应用配置 SQLite 表 + 少量 YAML/JSON（`gopkg.in/yaml.v3`）| harness 命令、model、provider 等 |

**Wails 版本纪律(硬约束)**:Wails3 跟进**最新 alpha**(**wails3 CLI、go module、生成的 bindings 三者版本必须同步**,升级时一起升,**禁止锁旧版**)。改 Go 导出方法签名后必须 `wails3 gen bindings`(dev 起的进程前端 binding 走运行时注入,不重新生成则前端用旧签名)。

**典型命令（脚手架后补全 Makefile）:**
```bash
wails3 gen bindings      # Go 方法 → 前端 TS 类型
wails3 dev               # 热重载开发（Go + 前端一起）
wails3 build             # 产出桌面应用
go test ./...            # 后端单测
bun run dev              # 仅前端 dev（Wails3 dev 通常已含）
```

---

## 1. 不可妥协的架构约束（违反 = 推翻重来）

### 1.1 纯 ACP（硬约束）
- 本应用与 agent 之间**只走 ACP**。**禁止为某个 agent 写「CLI 子进程 + stdout 文本解析」的后端。**
- 第一阶段只支持「实现了 ACP 的 harness」（先做 opencode）。harness 适配层只抹平 ACP 实现差异,不引入非 ACP 通道。
- **理由**:协议一致性是核心赌注,收窄换深度。

### 1.2 我们是 ACP client,不是 server
- 调用 `acp.NewClientSideConnection(handler, harnessStdin, harnessStdout)`。**agent（harness）是 peer,我们实现回调接口（`Handler`）。**
- 回调接口是「agent 反过来请求我们做的事」,必须实现至少:`SessionUpdate`（现实面入口,必选）、`RequestPermission`（权限裁决,见 §3.4）、`WriteTextFile`/`ReadTextFile`（fs 拦截,可先返空实现/透传）。
- **禁止把方向搞反**:不要去 `NewServerSideConnection`,不要等待别人来 `Initialize` 我们。

### 1.3 ACP 生命周期必须完整且顺序正确
一次对话的最小生命周期:

```
spawn harness 子进程（独立进程组,见 §3.2）
  → acp.NewClientSideConnection(handler, stdin, stdout)
  → conn.Initialize(ProtocolVersion + ClientCapabilities{fs})
  → conn.NewSession(cwd = 项目目录, McpServers)
  → conn.Prompt(SessionId, prompt)   // 同步返回;期间 SessionUpdate 回调并发流入
  → 判定:resp.StopReason == StopReasonEndTurn 视为成功
  → 结束:杀进程组 + reap 逃逸子进程
```

- **Prompt 是同步返回的**,期间 `SessionUpdate` 在**并发回调**里流入。不要把 Prompt 当成「发了就完事」,也不要在回调里阻塞 Prompt 所在的调用栈。
- **harness 崩溃**表现为 `err.(*acp.RequestError)` 含 `"peer disconnected"`（见 §3.3）。

### 1.4 session = ACP session,目录是锚点
- **每个 session 的 `cwd` = 一个项目目录**（磁盘上的真实路径）。项目 = 目录,session 钉在目录上。
- session 要能**恢复**:`LoadSession(sessionID)` resume 已有对话上下文（支撑「关掉再打开,对话还在」）。这是核心产品体验,不是可选项。
- **禁止**把 session 和目录脱钩（比如弄一个无 cwd 的「全局 session」）。无目录上下文的降级路径要显式标注,不作为正常路径。
- **每个 session 独占一个 git worktree**(参考 orca parallel worktree 模型):git 项目建 session 时自动 `git worktree add` 建独立分支(`md/<session-id>`)与工作目录(在 `<dataDir>/worktrees/<session-id>`),session 的 cwd 指向该 worktree;非 git 项目降级为项目目录本身。并行 session 互不污染,可对比、可合并(`MergeSession` = `git merge` 进主仓库)。这不违反 §1.1 纯 ACP——opencode 仍走 ACP,只是 cwd 换成 worktree。

### 1.5 数据本地是真相（SQLite）
- **本地 SQLite 是唯一真相来源**。没有中央 server、没有云端、没有「server 侧镜像」。message / session / usage / 配置全在本地一个 `.db` 文件里。
- **禁止**引入「需要联网才能读自己历史」的设计。数据目录可配（默认 `~/Library/Application Support/monkey-deck/` 之类）。

### 1.6 现实面 = SessionUpdate 流
- agent 的**全部产出**——tool call、model trace、artifact、token/cost 用量——都从 `SessionUpdate` 回调流入。
- **UI 的对话视图、用量统计、工具调用展示,数据源都是 SessionUpdate**,不是自己去抓 agent 的输出文件。
- 用量:`PromptResponse.Usage` 多数为 nil,靠流式 `SessionUsageUpdate`（累积 context 量 + harness 自报 cost）兜底。**别假设 `resp.Usage` 一定有值。**

---

## 2. 代码组织约束

### 2.1 目录结构（Wails3 单应用）

```
monkey-deck/
├── AGENTS.md                  # 本文件(规矩)
├── assets/                    # 图标设计源 PNG(换图标流程输入,见 docs/icon.md)
├── go.mod                     # 单一 Go module
├── main.go                    # Wails3 application.New() 入口
├── internal/
│   ├── acp/                   # ACP client 封装(Handler 回调 + Runner 生命周期)
│   ├── harness/               # harness 适配层(抹平 ACP 实现差异,只接 ACP)
│   ├── store/                 # SQLite 持久化(迁移 + CRUD)
│   ├── project/               # 项目/目录管理
│   ├── session/               # session 生命周期(新建/恢复/持久化)
│   └── config/                # 应用配置加载
├── frontend/                  # React 19 + TS + Vite(Wails3 前端)
│   └── src/
├── migrations/                # SQLite 迁移 SQL(纯 SQL,按序号)
├── docs/                      # 文档:RELEASE/UPDATE_SOURCES/icon + worklog(开发追踪) + PROCESS(历史归档)
│   └── worklog/               # 工作日志(一条一文件,开发追踪唯一活载体,见 §0.3)
└── Makefile                   # gen/dev/build/test/migrate
```

**关键边界:**
- `internal/acp/` 是 ACP 协议的唯一封装层,`Handler` 实现 client 回调接口;`Runner` 管子进程 + 连接生命周期。**agent 适配只准在这一层做。**
- `internal/store/` 是 SQLite 的唯一入口,**禁止业务包直接写裸 SQL**。
- Go 后端通过 Wails3 binding 暴露方法给前端、通过 event 把 `SessionUpdate` 推给前端。**前端永远不直接碰 ACP 连接。**

### 2.2 一个进程 = 一切（没有 daemon/server）
- Go 主进程同时承担:webview 宿主、harness 子进程父进程、ACP 连接持有者、SQLite 读写者。
- **禁止**拆 server/daemon。桌面单进程是我们的简化优势,别引入分布式复杂度。

---

## 3. 实现纪律（写代码时）

### 3.1 阶段化推进,禁止提前实现
本项目「不急着一下做完」,按阶段推进,**当前阶段没做完不偷跑下阶段**:

| 阶段 | 目标 | 状态 |
|---|---|---|
| **阶段 0（地基）** | Wails3 脚手架 + 单 harness（opencode）+ 单项目 + 单 session + 一轮对话端到端跑通（Init→NewSession→Prompt→SessionUpdate→UI 展示）+ SQLite schema v1 + 进程组回收 | 待启动 |
| **阶段 1** | 多项目/目录管理 + session 列表/恢复（LoadSession）+ 用量统计 + 重启后状态恢复 | — |
| **阶段 2** | model/provider 路由 + 多 harness 适配层 + 设置 UI | — |
| **阶段 3+** | wesight 形态扩展（运行时监控、菜单栏 HUD、IM/agent-team 等）——**显式推迟,见 §7** | — |

**遇到非当前阶段的需求,记成 TODO/OPEN,不写代码。**

### 3.2 子进程生命周期与回收（防泄漏,硬约束）
- spawn harness 时**必须建独立进程组**（`Setpgid=true`），结束时 `kill -PGID` 整组回收,**不只杀主 PID**。agent 内部 fork 的子进程会自己 setpgid 逃逸。
- **reap 逃逸子进程的时机关键:只能在 harness 已结束（unregister）后 reap,禁止周期性 reap**——运行中时逃逸 worker 与孤儿无法区分,周期 reap 会误杀活跃 worker 打断任务(实测血泪)。
- 每个活跃 harness 要注册到活跃集合,reaper 据此区分。
- **回收必须 harness 无关:以 pgidFile 登记的 pgid 为唯一真相**(启动清残留 / reap 逃逸都基于它),**禁止写死某个 harness 命令字符串做 grep**——harness 启动命令会变(如 omp 以 `bun …/omp acp` 启动),写死会漏掉主力 harness 致孤儿永不回收。

### 3.3 不能裸跑:崩溃检测 + 用户可停 + 自动重连(无静默超时)
- **Prompt 不设静默超时或绝对超时**——对齐 omp TUI 的设计:turn 跑到自然结束(`end_turn` / error),内部空停止重试(最多 3 次)、auto-retry(429/503/timeout)对 ACP client 不可见,设超时会打断这些机制。
- 兜底靠两条:
  1. **崩溃检测**:harness 进程死 → ACP 连接断 → `IsPeerDisconnected`(含 "peer disconnected" / "broken pipe")→ teardown + 下条消息走 `ensureLive` 重连(§5.4 #2)。
  2. **用户可停**:桌面应用有人在场,用户点 Stop → `turnCancel()` 取消 `ctx` → Prompt 返回(等价 TUI 的 Ctrl+C)。
- **断连自动重连**(disconnect 后主动 spawn 新 harness,使 session 自愈、下条消息零延迟):
  - **两条触发分支**:busy(turn 中 peer-disconnected → `runPrompt` teardown + `startReconnect`)、idle(turn 间 harness 自杀 → health watcher 周期检测 `!IsAlive()` + `startReconnect`)。
  - **指数退避 + 重试上限**:`reconnectLoop` 每次 backoff 翻倍(上限 `reconnMaxBackoff`),超 `reconnMaxAttempt` 次 → `reconnectGiveUp` + 推 `ErrCodeHarnessReconnectFailed`,停摆直到用户主动操作。
  - **稳定观察期**:spawn 成功后等 `reconnStability` 确认仍存活才算成功——覆盖「spawn 成功但立刻崩溃」的崩溃循环。
  - **userStopped 抑制**:StopSession 干净 cancel 不 teardown(harness 仍存活,天然不触发);CloseSession/DeleteSession `stopReconnect` + `reconnectGiveUp`。用户主动操作(发消息/继续/切配置)经 `ensureLive` 清 `reconnectGiveUp`,重新给重连预算。
- **禁止**用固定 `sleep` 假装「等 agent 回复」;**禁止**恢复静默超时/绝对超时(已删除,见 `docs/worklog/2026-07-01-remove-silent-timeout.md`)。

### 3.4 权限裁决:有人在场,可交互
- **我们是桌面应用,屏幕前有人**——这与无头 daemon 不同。
- harness 的 `RequestPermission`（「能否执行这个 bash / 写这个文件」）回调,**应作为 UI 提示弹给用户裁决**,而不是无脑自动放行（这是 wesight 那类工具的核心体验）。
- **但禁止阻塞**:ACP 调用挂起等待用户响应时,必须设**默认动作 + 超时兜底**（超时按默认级别放行/拒绝），不能让整个 ACP 连接因没人点按钮而永久卡死。用户可选「记住本次会话/该项目」减少打扰。
- 低危可配自动放行、高危必须人工,级别可配。**理由**:有人才是桌面客户端,但「人在但走开了」也要能自洽。

### 3.5 model/provider 注入基本原则（已知坑,先防）
- 给 agent 传 model 必须是 **`provider/model` 格式**（如 `volcengine-agent-plan/glm-5.1`），**裸名（如 `glm-5.1`）会被解析失败 → fallback 到占位无效 model → agent 创建 session 后 0 产出 → 静默 idle**。
- harness 在 session 创建时钉死 model,修改 model 后可能需新建 session 才能生效。

---

## 4. 前端与 UI 纪律

### 4.1 UI 参考 openwork(首选)/ wesight(补充),但数据源是纯 ACP
- 视觉/交互形态（工作区/项目管理、对话流、执行计划时间线、工具调用卡片、权限审批弹窗、model 选择、用量面板）**优先参考 openwork**（形态最完整、opencode-first、与本项目同类），wesight 作补充灵感。
- **但前端永远只通过 Wails3 binding/event 拿数据,数据源是 ACP 的 `SessionUpdate`,不准去抓 agent 的输出文件或跑额外 CLI。**

### 4.2 测试友好
- 需要被自动化点击/读取的元素,**组件里必须加 `data-testid`**。文本选择器会因 tab toggle / 同名元素冲突失效。
- 弹窗必须支持 Esc 关闭,否则遮罩挡住后续交互。

### 4.3 streaming 体验
- `SessionUpdate` 经 Wails3 event 推前端,前端做流式渲染。**别等整轮 Prompt 返回才更新 UI**——工具调用、model trace 要边到边显。

### 4.4 禁止裸露结构化/技术格式(硬约束)
- **绝不把结构化/技术格式(JSON、协议字段、原始 cwd/path/config、工具 I/O 的原始对象)直接展示给用户。**
- 工具调用的 input/output 等结构化数据,必须先提取「主文本」(如 output/command/content);提取不到时转成可读的 `键: 值` 行,而不是吐 `{...}` JSON。
- 会话/项目元信息(如 cwd)用人话呈现(「工作目录:/tmp」),不展示原始字段名 + 引号。
- **理由**:用户是人不是协议解析器;`{"cwd":"/tmp"}` 这种技术格式直接抛给用户 = 没做 UI。

### 4.5 统一 hover tooltip:用 react-tooltip,禁用原生 title(硬约束)
- **所有可交互 / 需解释的元素(图标按钮、状态指示、被截断的文本等)必须有 hover tooltip**,用人话说明它的作用/含义,不靠用户猜。
- **统一用 `react-tooltip`**(成熟库,React 19 兼容),**禁用浏览器原生 `title`**(样式不可控、与深色主题不协调)。具体 API 用法见前端代码,不在此规定。
### 4.6 UI 库 / 组件选型三约束(贴近原生 / 轻量 / 跨平台一致)

> Wails3 WebView 因平台而异(Win=WebView2、macOS=WebKit、Linux=WebKitGTK),同一库在不同 webview 下渲染/字体/滚动/输入可能不一致——这是我们与 Electron(全 Chromium) 最大的体验差异。选型须同时满足:

1. **贴近平台 native 样式**:首选各平台看起来像原生控件的库或可平台适配的方案;**禁止**只在某平台惊艳、在另一平台突兀的重度拟物库(如纯 macOS 糖霜风在 Win/WebKitGTK 格格不入)。
2. **轻量、低 GPU/CPU 开销(硬约束)**:**禁止**重度 canvas/WebGL、粒子背景、滚动视差、大面积 backdrop-filter 重绘、重型可视化等耗资源库(桌面长期驻留,资源占用决定发热/风扇/续航);倾向 CSS 驱动、纯 DOM、可 tree-shake 的轻量方案。
3. **跨平台一致性强制验证(硬约束)**:新引入的库/复杂组件,**引入前**须在 macOS WebKit + Win WebView2 实测(布局/字体/滚动/输入/快捷键/tooltip/暗色主题,Linux WebKitGTK 抽检);存在不可接受差异则**禁止引入**,回退纯 CSS/轻量原语自研。

**决策链路**:有现成轻量跨平台成熟库 → 用;没有 → React + 原语 CSS 自研;仅当自研成本远高于不一致风险时选平台适配型库,并在 README/THIRD_PARTY_LICENSES 记录理由与已验证平台。

---

## 5. 测试与质量

### 5.1 ACP 行为靠接口注入 mock,单测不启真 harness
- ACP 连接抽象成接口,单测注入 mock,**禁止单测里启动真 opencode**(慢、要 key、不稳定)。
- 真 harness 集成测试用 build tag（如 `integration`），CI 默认跳过,本地手动跑。

### 5.2 SQLite 测试用临时文件,不污染用户数据
- store 测试用 `t.TempDir()` 下的临时 db,跑完即弃。**禁止**测试读写用户的真实应用数据目录。

### 5.3 KISS + 成熟库优先 + references 优先参考 + Less is More
- **references/ 优先参考(硬约束)**:任何功能(无论 UI 还是逻辑)**先看 `references/` 下项目(orca/wesight/openwork)有没有对应实现**,参考其做法再动手。能用 read/search/find 学到方案就不凭空设计。**先参考后动手。**
- **成熟库优先(硬约束)**:任何功能**先搜有没有成熟库能满足**,能用就不自己造轮子;自研仅在「无成熟方案/方案太重/有特殊定制」时考虑,且 commit 里说明理由。**先搜后写,不搜不写。**
- **KISS / Less is More**:用最简单直白的方式实现,重复 3 次再抽象;相同功能越少代码越好(更少 bug、更低维护成本),**删掉后功能不变的代码就该删**。
- **每个 bug 修复必须配一个能复现该 bug 的测试**,先复现再修。测试比修复更重要。
- **找不变量,不堆 if(硬约束)**:处理外部事件流时**按协议稳定标识(`messageId`/`toolCallId` 等主键)归并**——同主键 patch 同一对象,不同主键新建;**禁用"上一个事件是什么类型"的启发式分段**(它对事件形状做假设,而形状无限,长潜伏期后必爆;发现自己在为 edge case 加 if 时,缺的不是另一个 if,是不变量)。修 bug 先问"背后的不变量是什么"——若修法依赖脆弱假设(如"事件按某顺序到达")只是推迟下一个 bug;最好的修复常是减代码(把多套表示收敛成一套),不是加代码对抗自己制造的复杂性。
- **尊重数据源,转换层不丢弃标识(硬约束)**:做"推断/猜测"(如消息边界)前,先检查数据源是否已给出答案(协议字段);**转换层(flatten/marshal)不得丢弃当前或未来可能用到的信息**。"重新发明协议已给的东西"是最常见的返工来源。
- **外部事实是设计前提时,先验证再动手(硬约束)**:依赖某外部事实(协议字段是否填充、上游行为)的设计,动手前**先用最小成本验证**(读参考实现/打日志/跑探针)——不是为"确认你对",是为"前提错了早 10 分钟知道";同时想清楚主干失败的降级路径。

### 5.4 已知/可预见的 ACP 坑（预先防范）

> 这些是 ACP 实战中易踩的坑,在我们的栈里大概率遇到。先记录先防,踩到了就在这里补本项目实证。

1. **harness 崩溃 = `peer disconnected`**:不要当普通 error 静默吞,要触发清理 + 用户可见提示(错误含 "peer disconnected" / "broken pipe")。**根因日志**:崩溃的真因(panic 栈 / OOM / 空闲自杀)在 harness 自身 stderr,由 `harnessProcess`(`internal/acp/proc.go`)统一捕获进 stderr ring(`internal/acp/stderr.go`)+ 结构化 exit 日志(pid/pgid/exitCode/signal/kind + stderrTail);排障先在日志里搜 `harness exited unexpectedly`。
2. **`PromptResponse.Usage` 常为 nil**:用量靠流式 `SessionUsageUpdate` 兜底,别假设一定有值(见 §1.6)。
3. **安全切片**:`id[:8]` 当 id 不足 8 字符会 panic,用 safe slice。
4. **tool 状态必须单调推进,禁止回退**:tool 一旦到终态(`completed`/`failed`),后续 `tool_call_update` 只更新 `rawOutput` 等非状态字段,**不接受 `status` 回退到 `in_progress`/`pending`**(omp async task 的 `tool_execution_update` 会硬编码打回 in_progress)。`handleEvent`(`internal/chat`)与 `activityTracker.observe`(`internal/acp`)两处都做。
5. **持久化按真实时序交错写库**:思考/回复/工具是交错的(thought→tool→agent→tool→agent),`persistTurn` 必须按真实发生顺序逐条写 `seq`,不能先写完所有 segment 再写所有 tool(否则重开会话历史时工具卡片全聚到 turn 末尾)。
6. **自动重连的崩溃循环防护**:`reconnectLoop` 的「spawn 成功」判定必须有**稳定观察期**(`reconnStability`)——只判 ensureLive 返回 nil 就算成功,会导致「spawn OK 但立刻崩溃」的 harness 被判为重连成功,reconnect goroutine 退出,health watcher 又检测到死、再触发重连,形成无上限的紧密循环。稳定观察期 + 重试上限 + `reconnectGiveUp`(耗尽后停摆直到用户主动操作)三道一起才能把循环收敛到有限次。

> 具体项目踩坑与修复记录(根因/修法/验证)统一落在 `docs/worklog/YYYY-MM-DD-<slug>.md`,本文只保留原则性规则。流式合并按主键归并的原则见 §5.3。

### 5.5 浏览器驱动集成测试:Wails3 server 模式(真后端 + 真数据,无 GUI)

> 场景:单测(mock)覆盖不了「真实 React UI × 真实 SQLite 数据 × 真实 binding/event 流」的集成行为(session 切换的内存累积、流式渲染、权限弹窗交互等)。Wails3 的 **server 模式** 专门解这个问题。

**关键架构事实(先搞清楚,否则白费劲)**:
- `@wailsio/runtime` 的 binding 调用走 `fetch(origin + "/wails/runtime")`(`node_modules/@wailsio/runtime/dist/runtime.js`)。
- **桌面 / dev 模式下**,`/wails/runtime` 由 webview 内部的 URL scheme handler 拦截处理(WKWebView 的 WKURLSchemeHandler / WebView2 的 WebResourceRequested),**不是 TCP 端口**。所以把 `wails3 dev` 的 Vite URL(`localhost:<WAILS_VITE_PORT>`)直接开到普通浏览器里:**只渲染 app 外壳,binding 全部失败**(空态:"No projects yet")。这条路只能做纯视觉 / 布局冒烟,做不了功能 / 集成测试。
- **server 模式(`-tags server`)下**,`app.Run()` 起一个**真 HTTP server**(默认 `:8080`,env `WAILS_SERVER_PORT` 可配),同时 serve 前端 embed 资源 + `/wails/runtime` binding 端点 + WebSocket(后端 → 前端事件广播)。浏览器直连即得**真后端 + 真数据**。

**用法**:
```bash
go build -tags server -o bin/monkey-deck-server .   # 或 wails3 task build:server
WAILS_SERVER_PORT=9246 ./bin/monkey-deck-server      # 或 wails3 task run:server(默认 8080)
# 浏览器开 http://localhost:9246 —— 真项目 / session / 对话,可点、可测、可拍堆快照
```

**适合测什么**:
- session 切换的内存行为(`performance.memory.usedJSHeapSize` 量 V8 heap delta;Chromium DevTools 拍堆快照看对象分布)。
- 真实事件流的 UI 反应(流式渲染、权限弹窗、用量面板)。
- 任何"mock 测不了、要真数据"的端到端路径。

**约束 / 已知坑**:
- **共享数据目录**:server 模式用同一个 SQLite(`~/Library/Application Support/monkey-deck/`)。WAL 模式允许并发读,但避免与桌面实例并发写(尤其别同时跑 agent turn)。测试期最好停掉桌面 app,或接受只读测试。
- **无 GUI**:server 模式不起菜单 / 窗口 / 应用更新(`runDesktop` 在 `-tags server` 下是 no-op,见 `server.go`)。测不了原生菜单 / 窗口行为。
- **引擎差异**:浏览器是 Chromium / V8,数字 ≠ macOS WebKit / JSC 的绝对值;但**相对趋势**(累积 vs 平台期)可信,足够判断内存优化是否生效。绝对 WebKit 数字仍需在桌面 app 上量(`vmmap` / `top`)。
- **`main.go` 必须做 server 拆分**:GUI 代码(菜单 `application.DefaultApplicationMenu`、窗口 `app.Window.NewWithOptions`、窗口事件)在 `-tags server` 下符号不存在,必须隔离到 `//go:build !server` 文件。本项目已拆:`main.go`(共享:config / log / services / `app.New` / `runDesktop` / `app.Run`)+ `desktop.go`(`!server`,GUI)+ `server.go`(`server`,`runDesktop` no-op)。**新增 GUI 启动代码务必进 `desktop.go`,别塞回 `main.go`**(否则 `-tags server` 又编不过)。

**优先级**:能在单测(mock)里覆盖的逻辑,不上升到 server 模式(慢、要起进程)。server 模式留给"必须真数据 / 真 UI"的集成与内存测试。

---

## 6. 文档与 Git 纪律

### 6.1 文档先于代码
- 任何偏离本文件的实现,**必须先改本文件(说明理由),再写代码**。文档是契约,不是事后记录。
- 新增约束、阶段推进、踩到新坑,都要回写本文件对应章节。

### 6.2 Git 管理(多提交、原子提交,硬约束)
- **每个逻辑改动一个 commit(原子提交)**:一个 commit 只干一件事(一个功能点 / 一个修复 / 一处重构)。不攒一大堆改动一次性提交,也不一个 commit 塞多件无关的事。**宁可多提交。**
- **commit message 说清「改了什么 + 为什么」**:推荐 Conventional Commits 前缀(`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`)+ 简述,body 补原因。例:`feat(acp): 封装 NewClientSideConnection 生命周期`。
- **文档与代码分开 commit**:便于 review 与回溯。
- **每个 commit 必须能编译、测试过**:禁止提交半成品 / 编译不过 / `go test` 不过的代码(呼应 §8)。功能做一半先存本地,别 push 进 main。
- **不夹带**:一个 commit 只含与该改动直接相关的文件,不趁机顺手改无关代码。
- **不提交不该进库的东西**:`references/`(外部只读)、构建产物(`*.app`/`bin/`)、`node_modules/`、`frontend/dist/`、`.DS_Store`、本地 `.db` 等,由 `.gitignore` 排除(见 §6.3)。
- **分支策略**:日常可直接在 `main` 原子推进;较大功能 / 不确定改动开 `feat/xxx` 或 `fix/xxx` 分支,验证通过再合并,保持 `main` 始终可运行。
- **收工即提交**:做完一个功能点 → 跑测试 → 立刻 commit,并在 `docs/worklog/` 新增一条工作日志(§0.3)。不要留一堆未提交改动过夜。

### 6.3 .gitignore 与外部参考库
- 仓库初始化即配 `.gitignore`(排除构建产物;并保留 `references/` 一条作**防御性安全网**——参考库现已迁至仓库外的共享目录,见 §0.2,仓库内本不该出现 `references/`,但若有人误建则该规则拦下)。
- 外部参考库**永不入库**:它是本机外部参考(含软链 / 外部仓库,~5GB),进库会污染历史且体积失控;入库的发现通道是 `scripts/references.sh` 顶部的 `REFERENCES` 清单(§0.2)。

---

## 7. 当前不做（显式推迟,遇到就拒绝）

| 项 | 何时做 | 备注 |
|---|---|---|
| 多 agent 编排 / 看板协调 / issue→task 分解 | **不做**(那不是我们的定位) | 见 §0 |
| server / daemon 分离、多租户 | **不做** | 单进程桌面是简化优势 |
| 非 ACP 通道（CLI 子进程 + stdout 解析）| **永不** | §1.1 核心赌注 |
| IM / agent-team / 多 agent 协作流 | 阶段 3+ | wesight 有,我们晚做 |
| 云端同步 / 账号系统 | 视情况 | 本地优先 |
| 运行时监控仪表盘 / 菜单栏 HUD | 阶段 3+ | wesight 有,我们晚做 |
| 导入 opencode/OMP 历史聊天记录 | **不做** | ACP `session/list`+`session/load` 技术上可批量重放导入,但太重(每个 session 都要 spawn harness 重放)+ 协议字段贫瘠(`SessionInfo` 无 usage/cost/model,load 重放只带协议标准字段)。用户判定永不。详见 `docs/worklog/2026-07-01-decline-import-historical-chats.md` |

---

## 8. 自检清单（提交代码前自检）

- [ ] 读过 §0(做什么/不做什么)和 §7(当前不做),本次改动没越界?
- [ ] 开工前读过 `docs/worklog/` 最近几条?(§0.3)
- [ ] 收工前已在 `docs/worklog/` 新增工作日志?(§0.3)
- [ ] 原子提交、commit message 清楚、没夹带无关改动、没提交构建产物?(§6.2)
- [ ] 没碰外部参考库(`/tmp/monkey-deck-reference`,见 §0.2)下任何文件?
- [ ] 借用参考库下任何项目的代码已按其原始协议署名(版权声明 + 许可文本 + THIRD_PARTY_LICENSES 登记;openwork 避开 `ee/`)?(§0.4)
- [ ] ACP 单测用 mock,没启真 harness?(§5.1)
- [ ] `go test ./...` 通过?

**任一项不满足,不要提交。** 架构硬约束(§1/§3)是违反=推翻重来的底线,不在此重复——直接遵守。
