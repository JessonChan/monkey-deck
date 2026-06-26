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

- **当前阶段**:阶段 0(地基)—— 待启动
- **当前焦点**:(待定,阶段 0 启动后填)
- **最后更新**:2026-06-26(初始化本文件)
- **可运行状态**:❌ 尚未脚手架(只有治理文档);git 仓库已初始化(`main`),`.gitignore` 已排除 `references/`

> 每次收工时刷新这一节,让人一眼看到「现在能跑吗、卡在哪、下一步是什么」。

---

## C. 阶段看板(镜像 AGENTS.md §3.1,细化到任务)

### 阶段 0(地基)—— 当前阶段

| # | 任务 | 状态 | 备注 |
|---|---|---|---|
| 0.1 | Wails3 脚手架(React+TS 模板 + go module,确认 module 路径) | todo | 路径见 AGENTS.md §0.5 |
| 0.2 | 引入 `acp-go-sdk`,搭 `internal/acp/`(Handler 回调 + Runner 生命周期,照搬 RAK) | todo | 参考 `references/.../acp/runner.go` |
| 0.3 | 单 harness(opencode)接入:Init→NewSession→Prompt→StopReason | todo | |
| 0.4 | 进程组回收(Setpgid + kill -PGID + 活跃集合,reap 只在结束后) | todo | AGENTS.md §3.2 |
| 0.5 | SQLite schema v1 + `internal/store/`(projects/sessions/messages/usage) | todo | |
| 0.6 | 前端对话视图:binding + event 流式渲染 SessionUpdate | todo | |
| 0.7 | model 注入(cwd 写 opencode.json,provider/model 格式) | todo | AGENTS.md §3.5 |
| 0.8 | 端到端验证:单项目单 session 一轮对话跑通 | todo | **阶段 0 验收线** |

**阶段 0 验收**:能新建一个「项目(目录)」,在 UI 里发一句话,看到 opencode 通过 ACP 回复并流式展示,进程干净退出不泄漏。

### 阶段 1(待阶段 0 验收后细化)
- [ ] 多项目 / 目录管理
- [ ] session 列表 + `LoadSession` 恢复
- [ ] 用量统计展示
- [ ] 重启后状态恢复

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

---

## F. OPEN 问题 / 阻塞

> 未决问题、已知缺陷、卡住的事。解决的标 ✅ 并注明。

- (暂无)

---

## G. 工作日志(追加,最新在上)

### 2026-06-26
- 初始化项目:写 `AGENTS.md`(工程约束)+ `PROCESS.md`(本文件)。
- 调研参考:`references/real-agent-kanban` 的 ACP 实现(`internal/acp`)、`references/wesight` 的产品形态。
- 确认两项决策(§D→§E):module = `github.com/jessonchan/monkey-deck`;SQLite 驱动 = `modernc.org/sqlite`。
- 加固治理:AGENTS.md 增 §0.4(wesight MIT 署名)、§6.2(Git 多提交/原子提交纪律);`.gitignore` 排除 `references/` 与构建产物;git 仓库初始化(`main`)。
- **下一步**:启动阶段 0.1(Wails3 脚手架)。
