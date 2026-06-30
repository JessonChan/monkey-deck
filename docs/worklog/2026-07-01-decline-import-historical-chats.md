# 2026-07-01 决策:永不提供「导入 opencode/OMP 历史聊天记录」功能

## 起因

用户先问:opencode/OMP 在 ACP 模式下是否自己往磁盘写数据?不自己存能不能复原历史?
→ 澄清后(见下「根因」),用户进一步提出:**能不能做一个「导入之前在 opencode/OMP 里的聊天记录」的功能,让从 opencode 迁过来的用户更友好?**

讨论完技术可行性与取舍后,用户判定:**不做,而且是「肯定不做」级别**。本文记这个决策,并把它落进 AGENTS.md §7「当前不做」。

## 根因(ACP 协议调研 —— 两条恢复/导入路径的事实)

### 路径 A:opencode 自己的磁盘(`~/Library/Application Support/opencode/opencode.db`)

opencode 在 ACP 模式下**确实**自己往磁盘写(`references/opencode/packages/core/src/`):
- `global.ts`:`xdgData/opencode/` 作数据根
- `database/database.ts` + `sqlite.bun.ts`/`sqlite.node.ts`:SQLite(WAL 模式),存 `session` / `message` / `part` / `session_message` / `session_input` / `event` / `todo` / `permission` 等表
- `snapshot/`:每 session 的 git 快照(§5.4 #10 实证)

**但这是 harness 私有 schema**(`part.data` 是 opencode 自己的 `Part` JSON 编码),直接读 = 死耦合 opencode 内部实现,opencode 升级随时改,跨 harness 不通用,违反 §1.1 纯 ACP 精神。

### 路径 B:ACP 协议层标准方法(`references/agent-client-protocol`)

ACP 协议**确实有**这两个标准方法,能拿到「聊天列表」和「某个聊天的完整历史」(对 `schema/v1/schema.json` + `docs/protocol/v1/` 实证):

| 能力 | 协议方法 | 能力门控 | 字段范围 |
|---|---|---|---|
| 聊天列表 | `session/list` | `sessionCapabilities.list`(可选) | `SessionInfo` 仅 `sessionId / cwd / title / updatedAt` —— **无消息、无 model、无 usage/cost**(schema.json:2327-2369) |
| 某聊天全部历史 | `session/load` | `loadSession`(可选,默认 false) | agent **MUST** 把整段历史作为 `session/update` 通知**重放**给客户端(`session-setup.mdx:134`),响应体本身不含历史 |

证据:schema.json:3779(LoadSessionRequest)/ 3824(ListSessionsRequest)/ 2263(LoadSessionResponse 只带 configOptions)/ 2327(SessionInfo);`session-list.mdx:221` 原话「`session/list` is a discovery mechanism only — it does **not** restore or modify sessions」;`session-setup.mdx:243` 原话 `session/resume`「MUST NOT replay the conversation history」(反向证明协议刻意区分 list/load/resume)。

→ **理论上**:批量 `session/list` → 逐个 `session/load` 重放 → `Handler.SessionUpdate` 回调落库 = 能把 opencode 历史导入我们自己的 SQLite。技术上积木齐全(§5.4 #9 lazy spawn + #14 list 能力守卫 + #28 LoadSession resume)。

### 为什么仍然不做(取舍)

| 维度 | 走 ACP load 导入 | 我们自己存(现状) |
|---|---|---|
| 查询 | O(N),每个 session spawn 一次 opencode 重放,慢 | O(1) 离线查 SQLite |
| 字段完整度 | 协议标准字段,**缺 usage/cost/model 富数据**(SessionInfo 不带,load 重放也不带) | 全 |
| harness 依赖 | agent 必须在线 + 必须实现 load 能力(可选) | 无 |
| 跨 harness | 仅协议标准部分通用 | 全通用 |

**关键缺陷**:导入后的历史是**残缺**的 —— 用量面板为 0、model 信息要靠 configOptions 推断、tool 卡片 rawInput/rawOutput 走 load 重放虽有但状态可能停在中间态。一次性迁移功能换来一份「半残」的历史,体验反而更差。

用户综合判断:**不值。永不做。**

## 改法

**不改代码,只记决策**:
- AGENTS.md §7「当前不做」表新增一行,标注「**不做**」+ 理由 + 指回本 worklog
- 本 worklog 记完整协议调研证据与取舍,供后续任何 agent 再被问起时直接引用,不重复调研

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `AGENTS.md` | §7 表新增「导入 opencode/OMP 历史聊天记录 | **不做** | ...」一行 |
| `docs/worklog/2026-07-01-decline-import-historical-chats.md` | 本条(新建) |

## 验证

纯决策记录,无代码改动,无需编译/测试验证。
协议事实已对 `references/agent-client-protocol` 的 schema.json + 官方 mdx 文档逐条核对(行号见「根因」)。

## 下一步

无(永不)。若将来用户改变主意,**首选路径是 ACP `session/load` 批量重放**(符合 §1.1 纯 ACP);直读 opencode.db 只能作「某 harness 不支持 load 能力」的降级,且必须明确标注是 opencode 专用、非通用导入。
