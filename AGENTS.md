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
- **不是多 agent 编排器**:不做 RAK 那种 server/daemon 分离、看板协调、issue→task 分解、review 收敛、多租户。我们是单用户、单进程桌面客户端。

### 0.1 阅读顺序

1. **本文件** —— 搞清楚规矩。
2. **`docs/worklog/`** —— 搞清楚最近做到哪、下一步干什么(`ls docs/worklog/ | sort -r | head` 看最新几条)。**PROCESS.md 已停维**(历史归档,只读,见 §0.3)。
3. **ACP 协议怎么用**:看 `/Users/jessonchan/temp/monkey-deck/references/real-agent-kanban/internal/acp/`（`runner.go` 的完整生命周期、`handler.go` 的回调实现）——这是 ACP client 用法的权威范例,**直接照搬其生命周期与回调模式**。
4. **UI / 产品形态参考(首选)**:`/Users/jessonchan/temp/monkey-deck/references/openwork`([github.com/different-ai/openwork](https://github.com/different-ai/openwork))——**与本项目最接近的同类产品**:opencode-first 的桌面 agent 客户端(Electron/Tauri + React),覆盖工作区/项目管理、session 管理、SSE 流式对话、执行计划(todos 时间线)、权限审批弹窗、model-select、各类 tool 卡片(apply-patch / bash / edit / file / glob / grep / lsp …)、markdown 渲染等**全套前端形态**。**这是最值得借鉴的 UI / 交互蓝本**。⚠️ **仅参考形态**——openwork 走 HTTP+SSE(`opencode serve` + `@opencode-ai/sdk`),**不是 ACP**;我们是纯 ACP,工作原理 / 数据通道一律不照搬。
5. **UI / 产品形态参考(补充)**:`/Users/jessonchan/temp/monkey-deck/references/wesight`([github.com/freestylefly/wesight](https://github.com/freestylefly/wesight))——统一 agent 管理、model 路由、运行时监控、菜单栏 HUD 等概念可作 UI 灵感。**仅参考形态,不照搬其工作原理**(wesight 多为 CLI 子进程管理,我们是纯 ACP)。
6. 按需查阅 ACP 协议规范本身与 `coder/acp-go-sdk`。

**禁止跳过阅读直接写代码。** ACP 生命周期搞错（比如把 client 当 server、漏掉 SessionUpdate 回调、Prompt 当成纯异步）是一切偏离的源头。

### 0.2 references/ 是只读参考,严禁改动

> **绝对路径(给 git worktree 用)**:`references/` 不入库、不在各 worktree 里。它的真实位置在**主源码树**:
> `/Users/jessonchan/temp/monkey-deck/references`
> （含 `real-agent-kanban/`、`wesight/`、`orca/`、`openwork/`、`DeepSeek-Reasonix/`）。下文凡写 `references/xxx` 的,均指此绝对路径下的对应子目录——在任意 worktree 里直接按这个绝对路径读即可。

- `references/` 下所有子项目(`real-agent-kanban/`、`wesight/`、`orca/`、`openwork/`、`DeepSeek-Reasonix/` 等)都是**参考资料,只读**。
- **严禁创建、修改、删除 `references/` 下的任何文件或内容**,严禁往里面写测试产物 / 构建产物 / 临时文件。要验证想法就在本项目自己的代码里验证。
- 只允许 `read` / `search` / `find` 它们来获取知识。

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

### 0.4 借用代码的协议署名(wesight / openwork 为 MIT)

- `/Users/jessonchan/temp/monkey-deck/references/wesight` 是 **MIT 协议**。**凡是从 wesight 借用 / 改写的代码,必须保留 MIT 协议署名:**
  - **文件级**:被借用代码的文件顶部保留 MIT 版权声明与许可文本(原作者 copyright 行 + "Permission is hereby granted..." 全文)。
  - **项目级**:在 `THIRD_PARTY_LICENSES.md`(或 `NOTICE.md`)登记一条「来源 = wesight (MIT) / 借用了哪些文件 / 原版权声明」。
- 从 `/Users/jessonchan/temp/monkey-deck/references/real-agent-kanban` 借用代码同理,**先确认其 LICENSE 文件,按对应协议署名**。
- `/Users/jessonchan/temp/monkey-deck/references/openwork` 整体是 **MIT 协议**(`LICENSE`),但 **`ee/` 目录是 Fair Source License,非 MIT**——**借用代码时避开 `ee/`,只从 MIT 部分(`apps/`、`packages/` 等)借**;同样须保留版权声明 + 登记到 `THIRD_PARTY_LICENSES.md`(来源 = openwork (MIT),原版权 `Copyright (c) 2026 Different AI`)。
- **禁止**把借用代码当成原创、抹掉版权声明。借一行也算;只参考思路(不抄代码)不受此约束。

---

## 0.5 技术栈与命令（实际落地）

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面框架 | **Wails3**（v3,`/Users/jessonchan/go/bin/wails3`）| 单一 Go 进程:后端逻辑 + 前端 webview + 子进程管理全在这里,**没有 daemon/server 分离** |
| 后端 | Go 1.26+,单一 module `github.com/jessonchan/monkey-deck` | Go 进程 spawn harness 子进程并独占 ACP 连接 |
| ACP | `github.com/coder/acp-go-sdk`（RAK 用 v0.13.5,我们跟进最新稳定版）| 唯一的 agent 通道 |
| 持久化 | **SQLite** + `modernc.org/sqlite`(纯 Go 驱动,免 CGO)+ `golang-migrate/v4` | 本地单文件是真相来源,无中央数据库 |
| 前端 | React 19 + TypeScript + Vite（Wails3 官方 React 模板）,Bun 管理依赖 | 通过 Wails3 **binding（Go 方法暴露给前端）+ event（后端推前端）** 与 Go 交互 |
| 配置 | 应用配置 SQLite 表 + 少量 YAML/JSON（`gopkg.in/yaml.v3`）| harness 命令、model、provider 等 |

**Wails 版本纪律(硬约束)**:Wails3 始终跟进**最新版**(当前 `v3.0.0-alpha2.106`;wails3 目前仅以 alpha 发布,该 alpha 即最新)。**wails3 CLI、go module(`github.com/wailsapp/wails/v3`)、生成的 bindings 三者版本必须同步**——脚手架/绑定按 CLI 版本生成。升级时三者一起升,**禁止锁旧版**;改 Go 导出方法签名后必须 `wails3 gen bindings`。

**典型命令（脚手架后补全 Makefile）:**
```bash
wails3 gen bindings      # Go 方法 → 前端 TS 类型
wails3 dev               # 热重载开发（Go + 前端一起）
wails3 build             # 产出桌面应用
go test ./...            # 后端单测
bun run dev              # 仅前端 dev（Wails3 dev 通常已含）
```

**开发期注意**:Wails3 `dev` 起的进程,前端调 binding 走的是运行时注入。改了 Go 导出方法的签名**必须重新 `wails3 gen bindings`** 再用,否则前端拿到旧签名。

---

## 1. 不可妥协的架构约束（违反 = 推翻重来）

### 1.1 纯 ACP（硬约束）
- 本应用与 agent 之间**只走 ACP**。**禁止为某个 agent 写「CLI 子进程 + stdout 文本解析」的后端。**
- 第一阶段只支持「实现了 ACP 的 harness」（先做 opencode）。harness 适配层只抹平 ACP 实现差异,不引入非 ACP 通道。
- **理由**:协议一致性是核心赌注,收窄换深度。参考 RAK §1.2。

### 1.2 我们是 ACP client,不是 server
- 调用 `acp.NewClientSideConnection(handler, harnessStdin, harnessStdout)`。**agent（harness）是 peer,我们实现回调接口（`Handler`）。**
- 回调接口是「agent 反过来请求我们做的事」,必须实现至少:`SessionUpdate`（现实面入口,必选）、`RequestPermission`（权限裁决,见 §3.4）、`WriteTextFile`/`ReadTextFile`（fs 拦截,可先返空实现/透传）。
- **禁止把方向搞反**:不要去 `NewServerSideConnection`,不要等待别人来 `Initialize` 我们。

### 1.3 ACP 生命周期必须完整且顺序正确
一次对话的最小生命周期（照搬 RAK `runner.go`）:

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
- agent 的**全部产出**——tool call、model trace、artifact、token/cost 用量——都从 `SessionUpdate` 回调流入（RAK handler.go 的现实面入口）。
- **UI 的对话视图、用量统计、工具调用展示,数据源都是 SessionUpdate**,不是自己去抓 agent 的输出文件。
- 用量:`PromptResponse.Usage` 多数为 nil,靠流式 `SessionUsageUpdate`（累积 context 量 + harness 自报 cost）兜底。**别假设 `resp.Usage` 一定有值。**

---

## 2. 代码组织约束

### 2.1 目录结构（Wails3 单应用）

```
monkey-deck/
├── AGENTS.md                  # 本文件(规矩)
├── PROCESS.md                 # 历史归档(只读;2026-06-30 起停维,见 §0.3)
├── references/                # 只读参考(real-agent-kanban / wesight / openwork / orca 等),严禁改动;不入库,实际在主源码树 /Users/jessonchan/temp/monkey-deck/references(见 §0.2)
├── go.mod                     # 单一 Go module
├── main.go                    # Wails3 application.New() 入口
├── internal/
│   ├── acp/                   # ACP client 封装(Handler 回调 + Runner 生命周期)← 照搬 RAK internal/acp 思路
│   ├── harness/               # harness 适配层(抹平 ACP 实现差异,只接 ACP)
│   ├── store/                 # SQLite 持久化(迁移 + CRUD)
│   ├── project/               # 项目/目录管理
│   ├── session/               # session 生命周期(新建/恢复/持久化)
│   └── config/                # 应用配置加载
├── frontend/                  # React 19 + TS + Vite(Wails3 前端)
│   └── src/
├── migrations/                # SQLite 迁移 SQL(纯 SQL,按序号)
├── docs/worklog/              # 工作日志(一条一文件,开发追踪的唯一活载体,见 §0.3)
└── Makefile                   # gen/dev/build/test/migrate
```

**关键边界:**
- `internal/acp/` 是 ACP 协议的唯一封装层,`Handler` 实现 client 回调接口;`Runner` 管子进程 + 连接生命周期。**agent 适配只准在这一层做。**
- `internal/store/` 是 SQLite 的唯一入口,**禁止业务包直接写裸 SQL**。
- Go 后端通过 Wails3 binding 暴露方法给前端、通过 event 把 `SessionUpdate` 推给前端。**前端永远不直接碰 ACP 连接。**

### 2.2 一个进程 = 一切（没有 daemon/server）
- Go 主进程同时承担:webview 宿主、harness 子进程父进程、ACP 连接持有者、SQLite 读写者。
- **禁止**模仿 RAK 拆 server/daemon。桌面单进程是我们的简化优势,别引入分布式复杂度。

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
- **reap 逃逸子进程的时机关键:只能在 harness 已结束（unregister）后 reap,禁止周期性 reap**——运行中时逃逸 worker 与孤儿无法区分,周期 reap 会误杀活跃 worker 打断任务（RAK §5.4 #23 实测血泪）。
- 每个活跃 harness 要注册到活跃集合,reaper 据此区分。这条直接从 RAK 迁移,**先照做再理解**。

### 3.3 不能裸跑:崩溃检测 + 用户可停(无静默超时)
- **Prompt 不设静默超时或绝对超时**——对齐 omp TUI 的设计:turn 跑到自然结束(`end_turn` / error),内部空停止重试(最多 3 次)、auto-retry(429/503/timeout)对 ACP client 不可见,设超时会打断这些机制。
- 兜底靠两条:
  1. **崩溃检测**:harness 进程死 → ACP 连接断 → `IsPeerDisconnected`(含 "peer disconnected" / "broken pipe")→ teardown + 下条消息走 `ensureLive` 重连(§5.4 #2)。
  2. **用户可停**:桌面应用有人在场,用户点 Stop → `turnCancel()` 取消 `ctx` → Prompt 返回(等价 TUI 的 Ctrl+C)。
- **禁止**用固定 `sleep` 假装「等 agent 回复」;**禁止**恢复静默超时/绝对超时(已删除,见 `docs/worklog/2026-07-01-remove-silent-timeout.md`)。

### 3.4 权限裁决:有人在场,可交互（与 RAK 的关键差异）
- **我们是桌面应用,屏幕前有人**——这与 RAK 的无头 daemon 不同。
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
- **工具实现统一用 `react-tooltip`**(成熟库,React 19 兼容,属性驱动)。**禁止用浏览器原生 `title="..."`**——样式不可控(系统样式、出现延迟长、不可定制)、与深色主题不协调。
- **用法**:全局只挂一个 `<Tooltip id="md-tip" />`(在 `App.tsx` 根级),元素上加 `data-tooltip-id="md-tip" data-tooltip-content="说明文字"` 即可;窗口顶部元素加 `data-tooltip-place="bottom"` 防裁切。主题对齐走 `index.css` 的 `--rt-*` 变量。
- **理由**:原生 title 太丑、不可定制,违反 §4.4「面向人而非机器」的总则;用成熟库而非自研(§5.3)。
### 4.6 UI 库 / 组件选型三约束(贴近原生 / 轻量 / 跨平台一致)

> Wails3 的 WebView 因平台而异:**Windows = WebView2(Edge/Chromium)**、**macOS = WebKit**、**Linux = WebKitGTK**。同一库 / 自定义组件在不同 webview 下的渲染、字体、滚动行为、输入表现可能不一致——这是我们与 Electron(全 Chromium) 最大的体验差异。选型时必须同时满足三条:

1. **贴近不同平台的 native 样式(优先)**
   - **首选**:各平台「看起来像原生控件」的库,或能按平台适配 native 观感的方案(如 mac 上拟 macOS 风格、Win 上拟 WinUI/Fluent 风格)。
   - **次选**:中性、简约、不标榜「某平台拟物」但能在各平台都协调的通用设计(如 shadcn/ui 风)。
   - **禁止**:只在某一平台惊艳、在另一平台突兀的「重度拟物」库(例如纯 macOS 糖霜风在 Win/WebKitGTK 会格格不入)。桌面客户端的第一印象是「它属于这个平台」,不是「它想成为另一个平台」。

2. **轻量、低 GPU / CPU 开销(硬约束)**
   - **禁止**引入重度 canvas / WebGL 动画、复杂粒子背景、滚动视差、实时模糊(backdrop-filter 大面积重绘)、重型图表/可视化(如 three.js 首页特效)等耗资源的库作为 UI 基础——桌面应用长期驻留前台,资源占用直接决定发热、风扇、续航。
   - **禁止**仅为视觉华丽而引入的 UI 库(含大量预置动画、spring physics)。动效只是锦上添花,交互反馈够用即可。
   - **倾向**:CSS 驱动、纯 DOM 的轻量方案,首屏 JS / CSS 体积在合理范围(单包不过百 KB 级),能被 tree-shaken。

3. **跨平台一致性强制验证(硬约束)**
   - 任何新引入的 UI 库 / 自定义复杂组件,**必须在引入前**同时在 macOS WebView 与 Win WebView2 实测基础表现(布局、字体渲染、滚动、输入框行为、快捷键、tooltip 避让、暗色主题)。Linux WebKitGTK 做抽检。
   - 若某库在三个平台上存在**不可接受的差异**(如滚动条样式不可控、input 聚焦 ring 不一致、字体 fallback 乱码、菜单定位错位),**禁止引入**,回退到更底层的方案或自己用纯 CSS / 轻量原语实现。
   - **理由**:我们不是 Electron——没有单一 Chromium 兜底。一致性不是可选项,是桌面体验底线;不一致的 UI 比粗糙但一致的 UI 更毁信任。

**决策链路**:有现成轻量跨平台成熟库 → 用;没有 → 自己用 React + 原语 CSS 实现;只在「自研成本远高于容忍不一致的风险」时选平台适配型库,并在 README / THIRD_PARTY_LICENSES 记录选择理由与已验证平台。

---

## 5. 测试与质量

### 5.1 ACP 行为靠接口注入 mock,单测不启真 harness
- ACP 连接抽象成接口（参考 RAK `RunnerInterface` + `MockRunner`），单测注入 mock,**禁止单测里启动真 opencode**（慢、要 key、不稳定）。
- 真 harness 集成测试用 build tag（如 `integration`），CI 默认跳过,本地手动跑。

### 5.2 SQLite 测试用临时文件,不污染用户数据
- store 测试用 `t.TempDir()` 下的临时 db,跑完即弃。**禁止**测试读写用户的真实应用数据目录。

### 5.3 KISS + 成熟库优先 + references 优先参考 + Less is More
- **references/ 优先参考(硬约束)**:任何功能的实现——无论 UI 还是功能设计——**先看 `references/` 下的项目(orca / wesight / real-agent-kanban / openwork)有没有对应实现**,参考其做法再动手。能用 read/search/find 从参考项目里学到方案就不凭空设计。**先参考后动手。**
- **成熟库优先(硬约束)**:任何功能,**先搜索有没有成熟的代码库 / 库可以满足需要**,而不是自己动手写。能用成熟库解决的就不自己造轮子。自研只在「没有成熟方案 / 方案太重 / 有特殊定制」时考虑,且在 commit 里说明理由。**先搜后写,不搜不写。**
- **KISS**:用最简单直白的方式实现,重复 3 次再抽象。
- **Less is More**:相同的功能,**越少的代码越是好代码**——更少 bug、更低维护成本。能用 10 行解决的不用 50 行。**删掉后功能不变的代码就该删。**
- **每个 bug 修复必须配一个能复现该 bug 的测试**,先复现再修。测试比修复更重要。

### 5.4 已知/可预见的 ACP 坑（从 RAK 参考迁移,预先防范）

> 这些是 RAK 实测揪出的 ACP 实战问题（详见 `/Users/jessonchan/temp/monkey-deck/references/real-agent-kanban/AGENTS.md` §5.4）,在我们的栈里**大概率会复发**。先记录、先防,踩到了就在这里补本项目实证。

1. **model 必须是 `provider/model` 格式**,裸名 → 占位 model → 0 产出静默 idle（见 §3.5）。
2. **harness 崩溃 = `peer disconnected`**,不要当成普通 error 静默吞,要触发清理 + 用户可见提示。
3. **session 创建时钉死 model**,改 model 可能需新建 session（见 §3.5）。
4. **子进程泄漏**:不建进程组 / 不 reap 逃逸 worker → agent 子进程爆炸（见 §3.2）。
5. **reap 不能周期性跑**:运行中误杀活跃 worker（见 §3.2）。
6. **`PromptResponse.Usage` 常为 nil**:用量靠流式 `SessionUsageUpdate` 兜底,别假设一定有值（见 §1.6）。
7. **安全切片**:`id[:8]` 当 id 不足 8 字符会 panic,用 safe slice。
8. **改 Go 导出方法签名后必须重新 `wails3 gen bindings`**,否则前端用旧签名。
9. **进程回收必须 harness 无关**:启动清残留(`KillAllHarnesses`)/ reap 逃逸(`reapStrayHarnesses`)以 pgidFile 登记的 **pgid** 为唯一真相,**禁止写死某个 harness 命令**做 grep——曾写死 `"opencode acp"`,默认 harness omp 实以 `bun …/omp acp` 启动,命令行不含该串 → omp 孤儿**永不回收**(漏掉主力 harness)。受支持命令经 `harness.Commands()` → `acp.SetHarnessCommands` 注入,仅作「pgid 被复用」的安全过滤(见 §3.2)。
10. **tool 状态必须单调推进(禁止回退)**:ACP `tool_call_update` 的字段是可选的("only changed fields need to be included")。但 omp 的 async task(`async.enabled`)在 `execute()` 返回(触发 `tool_execution_end` → `status=completed`)后,后台 job 完成时仍调 `onUpdate`(触发 `tool_execution_update` → omp mapper 硬编码 `status=in_progress`),**把已到终态的 tool 状态打回 `in_progress`**。表现:tool 有 rawOutput(甚至内容里带 `state:completed`)但 status 卡在 `in_progress`,永不收口。**我们必须做单调状态保护**:tool 一旦到终态(`completed`/`failed`),后续 `tool_call_update` 只更新 `rawOutput` 等非状态字段,**不接受 `status` 回退到 `in_progress`/`pending`**。这条在 `handleEvent`(`internal/chat`)和 `activityTracker.observe`(`internal/acp`)两处都要做。

> **具体项目踩坑与修复记录**(含根因 / 修法 / 验证)统一落在 `docs/worklog/YYYY-MM-DD-<slug>.md`,本文只保留原则性规则。

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

### 6.3 .gitignore 与 references/
- 仓库初始化即配 `.gitignore`(排除 `references/` 与构建产物)。
- `references/` **永远不入库**:它是本机外部参考(含软链 / 外部仓库),进库会污染历史且体积失控。

---

## 7. 当前不做（显式推迟,遇到就拒绝）

| 项 | 何时做 | 备注 |
|---|---|---|
| 多 agent 编排 / 看板协调 / issue→task 分解 | **不做**（那是 RAK,不是我们） | 见 §0 |
| server / daemon 分离、多租户 | **不做** | 单进程桌面是简化优势 |
| 非 ACP 通道（CLI 子进程 + stdout 解析）| **永不** | §1.1 核心赌注 |
| IM / agent-team / 多 agent 协作流 | 阶段 3+ | wesight 有,我们晚做 |
| 云端同步 / 账号系统 | 视情况 | 本地优先 |
| 运行时监控仪表盘 / 菜单栏 HUD | 阶段 3+ | wesight 有,我们晚做 |
| 导入 opencode/OMP 历史聊天记录 | **不做** | ACP `session/list`+`session/load` 技术上可批量重放导入,但太重(每个 session 都要 spawn harness 重放)+ 协议字段贫瘠(`SessionInfo` 无 usage/cost/model,load 重放只带协议标准字段)。用户判定永不。详见 `docs/worklog/2026-07-01-decline-import-historical-chats.md` |

---

## 8. 自检清单（提交代码前自检）

- [ ] 读过 §0（做什么/不做什么）和 §7（当前不做）,本次改动没越界?
- [ ] 开工前读过 `docs/worklog/` 最近几条,知道当前做到哪、下一步干什么?(§0.3)
- [ ] 收工前已在 `docs/worklog/` 新增一条工作日志(做了什么 / 为什么 / 改了哪些文件 / 怎么验证)?(§0.3)
- [ ] 本次改动是原子提交、commit message 清楚(改了什么/为什么)、没夹带无关改动、没提交 references/ 与构建产物?(§6.2)
- [ ] 是纯 ACP,没偷偷加 CLI 后端?(§1.1)
- [ ] 没把 client/server 方向搞反,ACP 生命周期顺序正确?(§1.2、§1.3)
- [ ] session 的 `cwd` 钉在项目目录,且支持 LoadSession 恢复?(§1.4)
- [ ] 数据只在本地 SQLite,没引入「需联网读自己历史」?(§1.5)
- [ ] 子进程建了独立进程组、结束整组回收、reap 只在结束后?(§3.2)
- [ ] agent 执行有 peer-disconnected 崩溃检测 + 用户 Stop,没设静默/绝对超时?(§3.3)
- [ ] `RequestPermission` 走「UI 提示 + 默认动作 + 超时兜底」,没裸跑也没死等?(§3.4)
- [ ] model 是 `provider/model` 格式?(§3.5)
- [ ] 没把结构化/技术格式(JSON、原始 cwd / 工具 I/O 对象)裸露给用户?(§4.4)
- [ ] 没碰 `references/` 下任何文件?(§0.2)
- [ ] 代码若借用自 wesight / openwork(避开 ee/),已按 MIT 协议署名(版权声明 + 许可文本 + THIRD_PARTY_LICENSES 登记)?(§0.4)
- [ ] ACP 相关单测用 mock,没启真 harness?(§5.1)
- [ ] 没踩 §5.4 列出的已知坑?
- [ ] `go test ./...` 通过?

**任一项不满足,不要提交。**
