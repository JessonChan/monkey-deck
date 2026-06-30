# 2026-06-30 侧栏排序键解耦：prompted_at

## 起因 / 根因

两个用户问题叠加：

1. **发完消息不上浮**：用户发送消息后，session 留在侧栏原位，要点一下项目行才跳顶。
2. **后台 session 乱抖**（潜在症状）：前端的 `chat:status` handler 只在新建/删除/初始加载时调 `refreshSessions`，turn 事件全不触发刷新。若哪天真把刷新加上，排序键 `updated_at` 又由 agent 后台的 `usage_update` 驱动，侧栏会被后台 session 的 token 进度不断抖动。

## 根因（代码级）

- 排序 SQL：`ListSessions`（`internal/store/sessions.go`）用 `ORDER BY updated_at DESC`。
- `updated_at` 的多处写点中，有 **agent 侧**事件：
  - `handleEvent`（`internal/chat/chat.go:1321`）收到 `usage_update` → `UpdateSessionUsage` 顺带 `SET updated_at=now()`；
  - `session_info` 标题同步（§5.4 #14）。
- **用户发消息本身不 bump `updated_at`**：`AppendMessage` 只写 messages 表。
- 前端 `chat:status` handler 不调 `refreshSessions`。

两层都不对齐。存储结构上 `messages` 表存对话、`sessions` 表存会话元信息，排序应在 sessions 表上做（JOIN messages 表得不偿失）。

## 设计取舍

三选一：A.JOIN messages 否决；B.改 updated_at 语义否决；C.新字段专门排序 ✅。选 `prompted_at`——过去式时间戳对齐 created_at/updated_at 命名族；ACP 语境里"prompt"指发起的用户输入，agent/tool 动作不叫 prompt，语义自解释。

## 改动

- **迁移** `internal/store/migrations/0006_session_prompted_at.sql`：ALTER TABLE sessions ADD COLUMN prompted_at，backfill=updated_at。
- **Session struct**（`internal/store/store.go`）加 `PromptedAt int64 json:"promptedAt"`。
- **store/sessions.go**：
  - `sessionColumns` 补 `prompted_at`，`scanSession` 多扫一列。
  - `CreateSession` INSERT 设 `prompted_at=now()`（新会话在视线内）。
  - 新增 `TouchPrompted`（只为用户消息 bounce）。
  - `ListSessions` 排序改 `ORDER BY prompted_at DESC, updated_at DESC`。
- **内部/chat/chat.go**：`startTurn` 入口（用户消息落库后）调 `TouchPrompted`。
- **前端/src/App.tsx**：
  - 加 `sessionsByProjectRef`（供 status handler 查 projectId，不进 effect 依赖）。
  - `chat:status` handler 在 `status === "prompting"` 时查 projectId 调 `refreshSessions`。

## 验证

- `TestSessionPromptedAtSort`（store 层）：构造三个 session，A 把 prompted_at 压到 1000，B 只动 updated_at 到极大，C 调 TouchPrompted → 断言顺序 C > B > A，证明后台活动（updated_at 极大）无法盖过用户 prompt。
- `go build . && ... ./internal/... && go test ./internal/...`：9 包绿（含 chat、store、acp）。
- `bunx tsc --noEmit`：前端干净。

## 顶层 / 下一步

不引入 pin（本轮不加）—— schema 预留 `prompted_at` 做主键、pin bool 列留待将来需求明确后再加（§7 显式推迟原则）。已写入 AGENTS.md §5.4 #20 记录决策。无已知 open。
