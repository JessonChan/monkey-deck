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

### 3.3 失败必须有兜底,不能裸跑
- 任何 agent 执行路径,**禁止「无超时、无崩溃检测、无清理」地裸跑**。
- 最小兜底:`Prompt` 设**静默超时**（从最后一次 `SessionUpdate` 活动算,不是总超时——agent 还在输出就不算超时,见 RAK `ChatSession.Prompt` 注释）+ `peer disconnected` 判崩溃 + 异常时杀进程组清理。
- **禁止**用固定 `sleep` 假装「等 agent 回复」。

### 3.4 权限裁决:有人在场,可交互（与 RAK 的关键差异）
- **我们是桌面应用,屏幕前有人**——这与 RAK 的无头 daemon 不同。
- harness 的 `RequestPermission`（「能否执行这个 bash / 写这个文件」）回调,**应作为 UI 提示弹给用户裁决**,而不是无脑自动放行（这是 wesight 那类工具的核心体验）。
- **但禁止阻塞**:ACP 调用挂起等待用户响应时,必须设**默认动作 + 超时兜底**（超时按默认级别放行/拒绝），不能让整个 ACP 连接因没人点按钮而永久卡死。用户可选「记住本次会话/该项目」减少打扰。
- 低危可配自动放行、高危必须人工,级别可配。**理由**:有人才是桌面客户端,但「人在但走开了」也要能自洽。

### 3.5 model/provider 注入:provider/model 格式（已知坑,先防）
- 给 agent 传 model 必须是 **`provider/model` 格式**（如 `volcengine-agent-plan/glm-5.1`），**裸名（如 `glm-5.1`）会被解析失败 → fallback 到占位无效 model → agent 创建 session 后 0 产出 → 静默 idle**（RAK §5.4 #13/#24）。
- 阶段 0 用 opencode 时,model 注入走「在 cwd 写 `opencode.json`」（规避协议层传 model 被忽略的 bug），与 RAK `WriteModelConfig` 一致。
- 改 model 后若 session 已创建,**注意 session 在创建时钉死 model,可能需新建 session 才生效**（RAK §5.4 #14）。

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

9. **opencode stdio ACP 空闲即断连**(本项目实证):会话 `NewSession` 后若不及时发 `Prompt`,opencode 会在约 1 秒内主动关闭 stdio 连接(`connection closed cause="peer connection closed"`),随后 `Prompt` 报 `broken pipe`。**根因**:opencode 的 stdio ACP server 对空闲连接有即时回收。**修法**:harness 懒启动(lazy spawn)——`CreateSession` 只建 DB 记录,`SendMessage` 首条消息时才 spawn harness + Init + NewSession + Prompt;turn 间保持 harness 活跃,`peer disconnected` 时拆掉、下条消息用 `LoadSession`(resume)重连。**验证**:server 模式驱动 GUI 连发两轮对话 + reload 后历史恢复均通过(2026-06-26)。
10. **多 session 并发:opencode 完全支持同目录多对话**(本项目实证,纠正早期误判):每个 ACP session 在 opencode 内有独立 git snapshot(`~/.local/share/opencode/snapshot/`),同 cwd 起多个 `opencode acp` 进程并发稳定。诊断证明:3 个全新并发 session 同 cwd + 文件读取题全部通过。**教训**:不要把 provider/model 的不稳当成 opencode/ACP 的限制。
11. **持续多轮 "peer disconnected before response" 常是 model/provider 不稳**(本项目实证):默认 `zai-coding-plan/glm-5.1` 在持续多轮(约 3 轮后)会 `peer disconnected before response`(opencode 侧静默退出,stderr 无错);换 `zai/glm-4.6` 后 5 轮全稳。**根因**:某些 provider/plan 档 model 在持续 ACP 调用下不稳(限流/异常致 opencode 退出)。**修法**:① 默认/项目 model 优先选已知稳定的(如 `zai/glm-4.6`);② SendMessage 失败(peer disconnected)自动重试 + LoadSession 重连;③ 提供 model 选择 UI 让用户切换。**验证**:/tmp/wesight-study 3 对话 ×10 题,glm-5.1 频繁断、glm-4.6 稳(2026-06-27)。
12. **用 encoding/json 持久化的 struct,字段必须导出**(本项目实证):`internal/chat/chat.go` 的 `toolAccum`(供 `persistTurn` 写库的 tool 累积器)字段全是非导出小写(`id/title/status/kind`),而 Go `encoding/json` **只序列化导出字段**,导致 `json.Marshal(t)` 产出 `"{}"`、写进 `messages.content`。前端 `messagesToItems` 再 `JSON.parse("{}")` 得空对象 → tool 卡片 `title/status` 全空(状态标签 fallback 成破折号「—」)、`rawInput/rawOutput` 缺失(展开空壳,「点不开」)。**只有历史恢复的 tool 受影响**,实时流式 tool 走 SessionEvent 不经此路径,故「有些能开、有些不能」。**修法**:① toolAccum 字段导出 + json tag,并补 `RawInput/RawOutput` 字段;`handleEvent` 在 `tool_call` 存 rawInput、`tool_call_update` 存 rawOutput;② 前端 `messagesToItems` 解析 rawInput/rawOutput;③ ToolCard 状态 fallback 空值显示「未知」而非破折号。**验证**:`TestToolAccumSerializesAllFields` 断言 marshal 不再是 `{}` 且含全部字段;before/after 对比证明旧 DB 记录破折号+不可展开、新记录正常。**教训**:**凡是用 json.Marshal 落盘 / 跨边界传输的 Go struct,字段必须导出(加 json tag);非导出字段被静默吞掉,不报错,只表现为数据丢失**——这类 bug 极隐蔽。
13. **ACP 协议无 queue;turn 中途发新消息用 cancel-then-reprompt;Stop/打断必须取消 turn ctx 而非 harness ctx**(本项目实证 + 协议调研):① 协议层 `session/prompt` 是**同步请求-响应**,baseline 只保证 `session/new`/`session/prompt`/`session/cancel`/`session/update`,**无排队语义**;turn 未结束不能发下一个 prompt。② turn 中途发新消息的唯一正确做法 = 发 `session/cancel` notification → agent 停 LLM/中止 tool → 回 `StopReason::cancelled` → 再发新 prompt。SDK 在 Prompt 的 ctx 取消时会自动补发 `session/cancel`(`client_gen.go` Prompt + 测试 `TestPromptCancellationSendsCancelAndAllowsNewSession`),且**连接保持可用**。③ **坑**:`StopSession` 原本取消 `ls.cancel`(startLive 的 harness ctx,`exec.CommandContext` 绑的)→ **直接杀 opencode 进程**,而非干净 `session/cancel`;Stop 按钮实为「干掉 agent」,下条消息得重 spawn。**修法**:`liveSession` 存 per-turn `turnCancel`,Stop/InterruptAndSend 取消它(干净 session/cancel,harness 存活);`runPrompt` 用 `turnCtx.Err()!=nil` 区分取消(干净 idle)/peer-disconnected(重连)/其它(error)。④ 排队缓冲做**前端**(FIFO,turn 结束自动续发);打断(`InterruptAndSend`)置 `suppressIdle` 防被取消的轮发 idle 误触发 auto-continue。**验证**:`internal/chat/queue_test.go`(mock chatConn)busy 守卫/打断/干净停止 ✅(2026-06-28)。
（本项目自己踩到的坑,持续往这里补,写清「现象 + 根因 + 修法 + 验证」。）
14. **opencode stdio ACP 不发 session_info_update 通知;标题经 session/list 读取(实证)**(本项目实证 + 协议调研):① ACP 协议**有**标题机制——SDK `SessionUpdate.SessionInfoUpdate`(`SessionSessionInfoUpdate.Title *string`,discriminator `session_info_update`,见 `types_gen.go` + schema.json),且 `session/list` 返回的 `SessionInfo.Title *string` 也是标题来源;`session/new` 的 `NewSessionResponse` **无** title 字段。② **opencode 1.17.10 实证不发 `session_info_update` 通知**:独立诊断程序抓取一轮完整 turn(+end_turn 后 70s)的全部 `SessionUpdate`,只有 `available_commands_update`/`agent_thought_chunk`/`tool_call`/`tool_call_update`/`agent_message_chunk`,**从不出现 `session_info_update`**。→ 原先 `handleEvent` 监听 `session_info` 想覆盖「首条消息截断标题」的分支**永不触发**,标题永远停在 `maybeAutoTitle` 的 24 字截断。**这是「标题一直用第一句话」的根因。** ③ **但 opencode 确实生成标题**——它写进自身库(`~/.local/share/opencode/opencode.db` 的 `session.title`,如 `ses_...` →「README 中文化及安装说明」),并通过 **ACP `session/list`** 的 `SessionInfo.Title` 暴露(诊断证明:turn 结束后 `conn.ListSessions` 第一轮 poll 立即返回该标题)。④ **修法**(协议级,读 opencode 权威标题,不自己再调 LLM):新增 `ChatSession.SessionTitle`(`runner.go`,调 `conn.ListSessions` 过滤本 session 取 `Title`),**受 `CanListSessions` 能力守卫**(见 ⑤);`chat.go` 新增 `syncSessionTitle`,在 `runPrompt` 成功后调用,标题不同则覆盖 DB + 推 `chat:session-meta`;`maybeAutoTitle` 改用 `titlegen.FallbackTitle`(纯本地归一化,移植自 wesight MIT)作**瞬时兜底**(opencode 标题到达前显示)。**关键**:opencode 已生成标题,客户端再调一次 LLM 是浪费、更慢 —— 直接 session/list 取最准最快。⑤ **协议事实核查**(对 `references/agent-client-protocol` 官方 repo 实证):① `session_info_update` 与 `session/list` 的 `SessionInfo.title` **均于 2026-03-09 稳定**(`docs/updates.mdx`)。② `session_info_update`(经 `session/update` 推送)是协议**首选的实时路径**——`session-list.mdx:8` "keeping session titles and metadata in sync without polling";`session-list.mdx:216-217` "Agents typically send this notification after the first meaningful exchange to auto-generate a title"。**opencode 不发此通知 = opencode 的实现缺口**(非协议无此能力)。③ `session/list` 是**能力门控的发现/轮询路径**——`session-list.mdx:37,54`:Clients **MUST** 先查 `initialize` 响应的 `capabilities.session.list`,未声明时 **MUST NOT** 调 `session/list`。④ **本项目据此加了能力守卫**:`ChatSession.CanListSessions`(`= initResp.AgentCapabilities.SessionCapabilities.List != nil`),`SessionTitle` 在 `!CanListSessions` 时早返 `("", nil)` 不调 `ListSessions`(SDK 字段:`AgentCapabilities.SessionCapabilities.List *SessionListCapabilities`)。**验证**:诊断程序 `ListSessions` 第一轮即得「README 中文化及安装说明」✅;`TestSyncSessionTitle{Overrides,EmptyNoClobber,SameNoRewrite}` ✅;`TestSessionTitleCapabilityGuard`(能力缺失不调 Conn)✅(2026-06-29)。
15. **IsPeerDisconnected 漏判 broken pipe;死 harness 不拆、session 卡死、裸 JSON 推前端(实证)**(本项目实证 + SDK 源码核查):① harness 退出(空闲断连 §5.4 #9 / model 不稳 #11 / 崩溃)后,下条消息 `Prompt` 往其已关闭的 stdin 管道写 → OS 错 `write |1: broken pipe`(`|1`=管道写端);SDK `toReqErr`(`acp-go-sdk/errors.go:71`)把**任何**非 `*RequestError` 错误统一包成 `NewInternalError({error: err.Error()})`,即用户看到的 `{"code":-32603,"message":"Internal error","data":{"error":"write |1: broken pipe"}}`;`RequestError.Error()`(`errors.go:17`)再把 Message+Data marshal 成那段 JSON 字符串。② **坑**:`IsPeerDisconnected` 旧实现只查 `re.Message`(="Internal error")与 `"peer disconnected"`,**不查 data 里的 broken pipe** → 返回 false → `runPrompt`/`SendAndWaitSync` 的拆连接分支(`delete s.active` + `Close` + `reapIfIdle`)全跳过 → (a) 死 harness 留在 `active`,下条 `ensureLive` 以为还活、再写又 broken pipe,**session 卡死、非 reload 不可恢复**,§5.4 #9 设计的 LoadSession 重连路径根本没被触发;(b) `detail := err.Error()` 把裸 JSON-RPC blob 推前端(§4.4 违规)。③ **修法**:`IsPeerDisconnected` 对 `err.Error()`(`RequestError.Error` 已含 data)做一次大小写不敏感子串匹配,把 `"broken pipe"` 与 `"peer disconnected"` 等同处理——二者根因相同(harness 没了,都该拆连接 + 下条 LoadSession 重连);cancelled 路径在 `runPrompt` 里先于本判定(turnCtx.Err()!=nil),无冲突。④ **验证**:`internal/acp/runner_test.go` 新增 `TestIsPeerDisconnectedBrokenPipe`(复现 `-32603 + broken pipe` 必识别为 peer disconnected)+ `TestIsPeerDisconnectedDoesNotOvermatch`(无关 Internal error 不误判、旧 peer disconnected 路径无回归、nil 安全);`go build .` + `go test ./internal/...` 全绿(2026-06-29)。
16. **in_progress tool 让静默超时永久豁免 → turn 永久挂死、死 harness 变僵尸(实证)**(本项目实证 + 代码核查):① **现象**:md/96d8364a、md/13e08a19 两个 session 在同一秒 01:31:38 同时停止落盘、再无进展,但 monkey-deck 进程一直活着、其它 session(12da5d86→01:49、5a7cc7ae→01:41)正常 —— 排除全局崩溃与 model(同进程别的 session 没事)。monkey-deck 的两个子 harness(62875、68784)双双变 `<defunct>` 僵尸,pgids 文件还登记着。② **根因(代码级,非 model)**:`internal/acp/runner.go` 的静默超时对「有 in_progress tool」**永久豁免**(`activityTracker.timedOut` 只要 `inProgress>0` 就返回 false)。当 harness 在某个 `tool_call` 处于 `in_progress` 时死亡(opencode 侧实证:13e08a19 最后一条 DB 记录就是一个没有后续 `tool_call_update` 终态的 `tool_call` —— 它在「轮询后台 ocr review 状态」的工具里挂了),那个 tool **永不到 completed/failed** → `inProgress` 卡死 >0 → 静默超时永不触发 → `promptCtx` 永不取消 → `Prompt` 永久阻塞 → `runPrompt` 的清理段(`delete(active)+Close()`)永不到 → **session 永久 busy=卡死 + 死 harness 永不拆→变僵尸**。③ **第二层 bug**:即便走另一条(无 in_progress tool、超时真触发),SDK `toReqErr`(`acp-go-sdk/errors.go:78`)把 `context.Canceled` 包成 `RequestError{code:-32800,"Request cancelled"}`,而 `IsPeerDisconnected` 只认 `"peer disconnected"/"broken pipe"` —— 匹配不上,`runPrompt` 旧逻辑就**不拆连接**,死 harness 同样留在 `active` 变僵尸。④ **诊断盲区**:monkey-deck 是 launchd 拉起的 GUI,stderr(fd2)→ `/dev/null`(lsof 实证),所有关键 slog(`chat idle timeout`/`prompt failed`/`session live`)全丢 —— 这是前几轮定位不到根因的主因。⑤ **修法**:① `runner.go` 加**绝对 turn 上限** `maxTurnAbsolute=15min`,抽纯函数 `shouldCancelTurn(start,now,silence,absolute)`:elapsed>absolute 一律取消(压过 in_progress 豁免),保证 turn 一定能返回;② `chat.go` 抽 `teardownLive(sessionID,ls)`(delete+Close+reapIfIdle),`runPrompt`/`SendAndWaitSync` 的 error 分支**任何非用户取消的失败都调它**(不再只认 IsPeerDisconnected);用户主动取消(StopSession/InterruptAndSend,`turnCtx.Err()!=nil`)仍走干净 idle 不拆(§5.4 #13);③ `main.go` 把 slog+标准 log 重定向到 `<DataDir>/monkey-deck.log`(append),告别 /dev/null。⑥ **僵尸澄清**:`killProcessGroup` 本就有 `cmd.Process.Wait()` 收尸(proc.go:62),僵尸是「Close() 没被调」的**症状**而非独立 bug —— 修①②后 Close 会被调,僵尸自愈。⑦ **验证**:`TestShouldCancelTurnAbsoluteBeatsInProgress`(in_progress + 超 absolute → "absolute")/`...ExemptWithinAbsolute`(in_progress + 未到 absolute → 不取消,回归保护长 tool)/`...IdleNoTool`/`...RecentActive`;`go build .`+`go build ./internal/...`+`go test ./internal/...`(8 packages)全绿;gofmt 干净(2026-06-30)。⑧ **未做实机验证**:`wails3 dev` 复现「harness 死于 in_progress tool 中途」→ 观察 15min 后自动恢复 + 落盘 `chat absolute turn timeout`;以及 `<DataDir>/monkey-deck.log` 是否如期落诊断。⑨ **后续可改进**:绝对上限 15min 对「真死的 harness」偏长,可加进程退出监听(`cmd.Wait()` goroutine → 立即 cancel turn)做到即时检测,而非等 15min。
17. **「立即发送」插队触发 runPrompt 收尾覆盖竞态 → session 假死报 busy(实证)**(本项目实证 + 代码核查):① **现象**:用了队列面板「立即发送」(`InterruptAndSend`)插队后,session 表面显示空闲(status=idle),但下次普通发送报 `session busy: 一轮对话进行中,请等待或打断`。② **根因(并发竞态,非协议)**:`runPrompt` 收尾段(`internal/chat/chat.go`)「先清 `ls.busy=false`、后 `emitStatus`」,且**不持 `sendMu`** —— 与 `startTurn` 无互斥。`InterruptAndSend` 用 `ls.busy` 判断「是否有在跑 turn」,若恰在「busy 已清、旧 emit 未发」窗口(=`persistTurn` 持续期)被调用,会读到 `busy=false` → 误判无 turn → 直接 `startTurn`(置 busy=true、emit 新 prompting);随后旧 turn 的延迟 emit(idle/error)把前端 status 从「新 prompting」覆盖成「idle」→ **后端 busy=true、前端显示空闲** → 下一次普通发送(前端见 status≠prompting 走直发)撞 busy 守卫。作者原注释「emit 前清 busy 防 drain 撞 stale busy」只防了反向竞态,引入了正向竞态。③ **修法**(锁互斥,非调 busy 时机):`runPrompt` 收尾段(清 busy→persist→emit)持 `sendMu`,`defer Unlock` 早于 `close(turnDone)`(LIFO)执行;`InterruptAndSend` 的 busy 分支改为**释放 sendMu 后再等 turnDone**(否则与收尾段持同一把锁死锁),落定后重拿 sendMu 发新消息(旧 turn 失败已 teardown 时 re-`ensureLive` 重连)。这样「拿到 sendMu 且 busy=false」⇒ 旧 emit 必已完成,杜绝覆盖。④ **验证**:`internal/chat/finalize_race_test.go`(`TestInterruptNoRaceWithRunPromptFinalize`)用 `persistHook` 卡住收尾窗口 + `emitHook` 捕获 status 序列,确定性复现:修复前序列 `[prompting, prompting, idle]`(覆盖,statuses[1]=="prompting",测试红),修复后 `[prompting, idle, prompting]`(绿);全量 `go test ./internal/chat/ -race` 17 例通过(2026-06-30)。⑤ **教训**:**前后端状态机靠事件异步同步时,busy(后端真相)与 status(前端投影)之间的「清零/发送」时序窗口必须用锁互斥,不能只靠调换清零顺序** —— 调换顺序只是把竞态从一边挪到另一边。
18. **权限记忆被 `external &&` 闸门挡住 → 命令执行类请求永不命中记忆、每次弹窗(实证)**(本项目实证 + 代码核查):① **现象**:omp harness 下「确认过可以执行命令」仍每次弹窗要确认;用户已选「本会话/本项目允许」也不生效。② **根因(代码级,非协议)**:`internal/acp/handler.go` 的 `RequestPermission` 命中记忆分支用 `external && (sessionAllowExternal || projectAllowExternal)` 作闸门,`external = isExternalAccess(cwd, locations)`。omp 对「命令执行」发的 request_permission,其 `ToolCall.Locations` 多在 cwd 内或为空 → `isExternalAccess=false` → 记忆分支**永不命中** → 即使记忆已写入(`applyDecision` 的 session/project 档已 `Store(true)`),下次命令执行仍走弹窗。project 级记忆本就按 `projects.allow_external_dir` 列存、按 project id 不分 harness(天然跨 harness),只是被这个闸门挡住。③ **修法**:去掉 `external &&` 闸门 → `if sessionAllowExternal || projectAllowExternal` 即放行**所有** RequestPermission(含命令执行、外部目录),不止外部目录。`isExternalAccess` 降级为仅 debug 日志标注(保留供将来按风险分级:高危仍人工)。④ **验证**:`internal/acp/handler_perm_test.go`(`TestRequestPermissionMemoryAutoAllowsAllRequestTypes` 含 session/project 两子场景 + `TestRequestPermissionNoMemoryStillPrompts` 回归);用带超时 ctx 确定性复现:修复前走弹窗分支阻塞→ctx 取消返回 Cancelled(断言失败),修复后立即返回 allow。`go build . ./internal/...` + `go test ./internal/...`(9 packages)全绿(2026-06-30)。⑤ **权衡**:记忆命中现放行所有请求类型(含潜在高危);当前无风险分级,用户仍可选「允许本次」单次控制;如需高危强制人工,将来按 ToolKind/risk 分级(`isExternalAccess` 已保留供此)。⑥ **字段/列名**:handler `sessionAllowExternal/projectAllowExternal` 与 DB 列 `allow_external_dir` 名字保留历史(曾仅管外部目录),语义已泛化为「session/project 已批准」,注释已更新说明。
20. **排序键被 agent 后台活动毒化 → 侧栏每次发完消息不上浮、后台 session 跑完乱抖（本项目实证 + 设计）**:① **现象**:用户发消息后,侧栏里 session 留在原位不动,要点一下项目行才刷新跳顶;同时开了多个 session 时,后台跑完的 session 反而在侧栏上游走。② **根因(架构 + 存储)**:侧栏排序 SQL `ORDER BY updated_at DESC`(store/sessions.go ListSessions);而 `updated_at` 的 bump 点,除了用户操作,还混了一个 **agent 侧**事件:`handleEvent` 收到 `usage_update` SessionEvent 时调 `UpdateSessionUsage`(`chat.go:1321`)顺带 `SET updated_at=now()`,`session_info` 标题同步也顺带(§5.4 #14)。于是排序键实际上由"agent 报用量"驱动,**用户发消息本身没有专属的 bump 点**(AppendMessage 写 messages 表,不动 sessions 表)。更糟的是:前端 `chat:status` event handler 没在任何 turn 事件点调 `refreshSessions`(只在新建/删除/初始加载时拉过列表),所以就算后端 bump 了,前端永远不知道——只有手动触发 `refreshSessions`(点项目行/新建/删除)才重排。两层都不对齐,就和 §5.4 #9/#16 等设计好的 resume/reap 路径被别的事件挡住一样。③ **设计取舍(三选一)**:A.JOIN messages 表按最后用户消息时间排 —— 反规范化没必要,且随着 messages 行增长变慢(**否决**);B.改 `updated_at` 语义(只让用户消息 bump,usage_update/title 不动它) —— `updated_at` 是 multipurpose 字段,顺手改语义要去掉多处现有 bump,易踩(**否决,§6.1**);C.新字段专门排序 —— 干净、可扩展(将来如果做置顶,大时间戳 hack 不好,独立 bool 更好,但本轮不加 pin)。④ **修法(C 方案)**:新增迁移 `0006_session_prompted_at.sql`(ALTER TABLE sessions ADD COLUMN prompted_at,backfill=updated_at);Session struct 加 `PromptedAt`;`CreateSession` INSERT 设 `prompted_at = now()`(新会话在视线内);新增 `TouchPrompted`(只有用户发消息 bounce);排序 SQL 改成 `ORDER BY prompted_at DESC, updated_at DESC`(prompted_at 用户意图主键,updated_at 兜底无消息但改 model/worktree 的变更仍能合理排位);`startTurn` 入口(用户消息落库后)调 `TouchPrompted`;前端 `chat:status` event handler 在 `status==="prompting"` 时按 session 查 projectId 调 `refreshSessions`(通过 sessionsByProjectRef 避进 effect 依赖);后台活动走 `usage_update`/标题同步不动 prompted_at、也不走 status 事件,侧栏纹丝不动。⑤ **验证**:`TestSessionPromptedAtSort` 断言 C(最近 prompted) > B(prompted_at 为 CreateSession 值但 updated_at 抬到极大) > A(prompted_at 压到 1000),证明后台活动(updated_at 极大)无法盖过用户 prompt(prompted_at 更大);`go test ./internal/...(9 packages ok)` + `bunx tsc --noEmit` 干净。⑥ **字段命名**:候选 `last_messaged_at`(messages 表 user/agent/tool 都是 message → 语义不清)、`last_user_at`(歧义)、`last_user_message_at`(太长);最终 **`prompted_at`**(过去式时间戳对齐 created_at/updated_at 命名族;ACP 语境里"prompt"天然指发起的用户输入,agent/tool 动作不叫 prompt,语义自解释且精准)。⑦ **未改**:本次不加 pin 功能——schema 预留 `prompted_at` 做排序主键,独立 pin bool 列留待将来需求明确后再加(AGENTS.md §7 显式推迟原则)。约 2026-06-30。
19. **新会话首条消息前无 model 下拉(configOptions 仅 NewSession 响应里有 + 懒启动)**(本项目实证 + 设计 + 源码研读):① **现象**:打开新对话时,输入框没有 model 选择工具,要等发一条消息后才出现。② **根因(架构,非 bug)**:model/mode/effort 下拉数据源是 agent 自报的 `configOptions`,只在 **NewSession 响应**里返回(§5.4 #14);懒启动(§5.4 #9)使 harness 仅在**首条消息**时才 spawn+NewSession → `startLive` 才 emit `config_option` → 前端 `configOptionsBySession` 空 → `ModelSelect` 的 `if(!modelOpt)return null` 不渲染。③ **源码研读(opencode)**:`references/opencode/.../cli/cmd/acp.ts` 的 `acp` 命令只 `process.stdin.on("end")` 等客户端关 stdin,**并不主动空闲断连**——故 §5.4 #9 的"~1s 断连"并非 opencode 自关 stdio(更可能其内部 HTTP server / `@agentclientprotocol/sdk` 层),**warm(keep alive)在 opencode 上安全**。④ **修法(2026-06-30 定稿:B 方案 —— OpenSession 异步 spawn + idle reaper 回收)**:放弃早期「冷缓存预热 + cfgCache + DB 兜底」方案(已删),改为**session 一打开就 spawn**:`OpenSession` 异步 `go ensureLive`(spawn + NewSession/LoadSession),立即返回不阻塞前端加载历史;`startLive` emit 完整 `config_option`(model/mode/effort 真值),下拉立即完整可见。`CreateSession` 不主动 spawn(用户切过去时 `OpenSession` 触发)。**idle reaper**(`idleReaper` goroutine,`ServiceStartup` 起、`ServiceShutdown` 优雅停):周期扫(interval = idleTimeout/5,生产 5min→1min),超 `idleTimeout`(默认 5min,**从最后 turn 结束算**)且非 busy 的 session 自动 `CloseSession`(杀进程组释放资源);`CloseSession` busy 双重检查(reaper 收集 + CloseSession 内)防误杀进行中 turn。用户切回/发消息时 `ensureLive` 探活,进程已死则 `teardownLive` + `LoadSession` resume 无感重连(§5.4 #9/#16 已验收)。⑤ **验证**:`internal/chat/idle_reaper_test.go`(mock chatConn,不启真 harness):`TestCloseIdle{ExpiresIdleSession,SkipsBusySession,SkipsRecentSession,ActivityResetsTimer}` + `TestIdleReaperGoroutineRecyclesAndStops` + `TestCloseIdleConcurrentSafe`;`go test ./internal/... -race`(9 packages)全绿(2026-06-30)。⑥ **取舍**:B 方案下用户切走 session 不立即关(切回即时响应),idle 5min 才回收;同时开多 session 时内存可控(空闲自动释放)。删掉:`buildSessionConfig`/`emitSessionConfig`/`maybeWarmSession`/`emitCachedConfigForProject`/`configCacheKey`/`cfgCache`/`cfgProbing` + 前端 `ModelSelect` 静态兜底分支 + `config_select_test.go`。

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
- [ ] agent 执行有静默超时 + peer-disconnected 崩溃检测 + 清理?(§3.3)
- [ ] `RequestPermission` 走「UI 提示 + 默认动作 + 超时兜底」,没裸跑也没死等?(§3.4)
- [ ] model 是 `provider/model` 格式?(§3.5)
- [ ] 没把结构化/技术格式(JSON、原始 cwd / 工具 I/O 对象)裸露给用户?(§4.4)
- [ ] 没碰 `references/` 下任何文件?(§0.2)
- [ ] 代码若借用自 wesight / openwork(避开 ee/),已按 MIT 协议署名(版权声明 + 许可文本 + THIRD_PARTY_LICENSES 登记)?(§0.4)
- [ ] ACP 相关单测用 mock,没启真 harness?(§5.1)
- [ ] 没踩 §5.4 列出的已知坑?
- [ ] `go test ./...` 通过?

**任一项不满足,不要提交。**
