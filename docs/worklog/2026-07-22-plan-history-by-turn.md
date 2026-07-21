# 2026-07-22 按 turn 保留历史 plan(turnId 探针 + plan 改按 turn 列表 + 当前 turn 实时/历史 turn 静态展示)

## 起因

Task #21295。前序 #15090(2026-07-14)把 plan 做成了 session 级实时状态:不入消息流、
不持久化,turn 结束即丢。当时 worklog 显式留了 OPEN:

> 若需要跨 turn 保留计划历史(回看每轮的计划),再考虑把 plan 快照持久化到 DB(当前 KISS:不持久化)。

本任务闭合这个 OPEN:把 plan **按 turn 保留**,重开会话能回看每轮的执行计划;当前 turn
仍是实时刷新,历史 turn 是定格快照。

## 探针确认 turnId 来源(协议侧无,client 生成)

动手前先验证协议是否提供 turn 级标识(§5.3「外部事实是设计前提时先验证」):

- `SessionUpdate.Plan`(stable):只有 `Entries []PlanEntry`,无任何 id / turn 引用。
- `SessionUpdate.PlanUpdate`(UNSTABLE):`Plan.Items.Id` 是 `PlanId`(plan 级 id,标识
  「同一个 plan」便于整表替换 / removal 引用),**不是 turn 级 id**。一个 turn 可能发多个
  plan_update(同一个 PlanId),多个 turn 也可能复用同一 PlanId(harness 决定)。
- `SessionUpdateUserMessageChunk` / `AgentMessageChunk`:有 `MessageId`(消息级),不是 turn 级。

**结论**:ACP 协议**没有 turnId 概念**。turn 是 client 侧的概念(一次 Prompt 同步调用 =
一个 turn,§1.3)。我们用「开启该 turn 的 user message ID」作 turnID —— `AppendMessage`
已生成 uuid,直接复用。优点:唯一、稳定、与 DB 已有主键对齐、无需额外字段。

## 改法

### 后端(internal/acp + internal/chat)

1. **`SessionEvent` 加 `TurnID` 字段**(`internal/acp/handler.go`):`json:"turnId,omitempty"`。
   目前仅 plan 事件携带(plan 按 turn 索引);其他 kind 协议无 turn 概念,留空。

2. **`liveSession` 加 `currentTurnID` / `currentPlan`**(`internal/chat/chat.go`):
   - `currentTurnID`:开启该 turn 的 user message ID。`startTurn` / `SendAndWaitSync` 在
     `AppendMessage` 返回后设置。
   - `currentPlan`:本轮 plan 最新全量快照(ACP plan 整表替换模型,每次 plan 事件覆盖)。
   - `resetBuffers`(turn 开始)清空两者。

3. **`handleEvent` 给 plan 事件打 turnID + 快照存档**:`case "plan"` 分支设
   `e.TurnID = ls.currentTurnID`、`ls.currentPlan = e.PlanEntries`(持 ls.mu)。

4. **`persistTurnPlan`(新)** 在 turn 收尾(`runPrompt` / `SendAndWaitSync` 的 finalize 段)
   把 `ls.currentPlan` 落库为 `role='plan'` message:
   - content = JSON 序列化的 `[]PlanEntry`(与实时事件的 `planEntries` 同形,前端解析路径复用)。
   - `tool_call_id` 列复用存 `turnID`(plan 行没有 toolCallId,这列对 plan 语义就是 turnID)。
   - 空 entries 不写(无 plan 的 turn 不留痕)。
   - 放在 `emitStatus(idle/error)` 之前:前端收到 idle 时持久化已落库,翻页 / 重开能拿到。

### 前端(types + App.tsx + ChatView.tsx)

5. **`ChatItem` 加 `type: "plan"`**(`types.ts`):`{ id, turnId, entries, ts? }`。
   `LivePlan` 类型 = `{ turnId, entries }`(进行中 turn 的实时 plan)。

6. **`App.tsx` state 重构**:
   - `planBySession: Record<sid, PlanEntry[]>` → `livePlanBySession: Record<sid, LivePlan | null>`。
   - `applyEvent` 收到 `kind === "plan"`:整表刷新 `livePlanBySession[sid]`(空 entries → null)。
   - status handler 收到 `prompting`(新 turn):清掉 `livePlanBySession[sid]`(避免旧 plan 残留)。
   - status handler 收到 `idle/error/closed`(turn 结束):**eager-append** —— 把 `livePlan` 转
     为 `type:'plan'` ChatItem append 到 `itemsBySession[sid]` 末尾(= turn 末尾时序位置),
     然后清掉 `livePlan`。这避免「plan 闪退」(livePlan 清掉到下次重载之间的空窗)。
     - 用 `livePlanBySessionRef`(ref 镜像)读 livePlan,不在 setLivePlanBySession updater 内
       套 setItemsBySession(StrictMode 下 updater 可能多次执行致重复 append)。
     - 兜底:已有同 turnId 的 plan item 不重复 append(防重放 / 双触发)。
   - `messagesToItems`:加 `role === "plan"` 分支 → `{ type: "plan", id: m.id, turnId: m.toolCallId, entries: JSON.parse(m.content) }`。
   - 传 `livePlan` 给 ChatView(替换原 `plan`)。

7. **`ChatView.tsx` 渲染**:
   - `items.map` 加 `item.type === "plan"` 分支 → `<PlanTimeline entries prompting=false />`
     包在 `.cv-item` 里(内联渲染在 turn 末尾的时序位置,静态无 spinner,参与滚动锚点)。
   - 原 items 之后的 `<PlanTimeline plan />` 改为 `<PlanTimeline livePlan.entries prompting=status==="prompting" />`
     —— 当前 turn 的实时 plan,带 spinner。
   - `ChatRow` 加防御性 `item.type === "plan"` return null(plan 由 items.map 顶层处理,
     ChatRow 不应收到;仅为 TS union 收窄)。
   - prop `plan: PlanEntry[]` → `livePlan: LivePlan | null`。

### 数据流总结(对照新模型)

| 阶段 | 数据位置 | 渲染 |
|---|---|---|
| turn 进行中 | `livePlanBySession[sid]`(内存) | ChatView 底部 `PlanTimeline`(带 spinner) |
| turn 结束瞬间 | ① 后端 `role='plan'` message 落库 ② 前端 eager-append 进 `itemsBySession[sid]` ③ 清 `livePlanBySession[sid]` | items 末尾 `PlanTimeline`(无 spinner) |
| 重开会话 / 翻页 | DB `role='plan'` message → `messagesToItems` → `itemsBySession[sid]` | items 中内联 `PlanTimeline`(无 spinner) |

eager-append 与 DB 落库的内容一致(同一份 plan 快照),故重开后 id 切换(live-plan-<turnId> → DB uuid)
只是 React key 变化、组件重挂,无内容差异。

## 改了哪些文件

- `internal/acp/handler.go`:`SessionEvent` 加 `TurnID` 字段。
- `internal/chat/chat.go`:`liveSession` 加 `currentTurnID` / `currentPlan`;`startTurn` /
  `SendAndWaitSync` 设 turnID;`handleEvent` 给 plan 事件打 turnID + 快照;`runPrompt` /
  `SendAndWaitSync` 收尾调 `persistTurnPlan`;新增 `persistTurnPlan`;`resetBuffers` 清空。
- `internal/chat/plan_by_turn_test.go`(新):三个回归测试(turnID 透传 / persistTurnPlan 落库 /
  runPrompt e2e 持久化)。
- `frontend/src/types.ts`:`SessionEvent` 加 `turnId?`;`LivePlan` 类型;`ChatItem` 加 `type:"plan"`。
- `frontend/src/App.tsx`:`planBySession` → `livePlanBySession`;applyEvent / status handler
  / messagesToItems 改写;`livePlanBySessionRef` 防 StrictMode 嵌套 setState。
- `frontend/src/components/ChatView.tsx`:prop `plan` → `livePlan`;items.map 加 plan 分支;
  ChatRow 防御性 plan 分支(TS 收窄)。

## 验证

- `go build ./...` / `go vet ./...`:clean(只剩 macOS SDK 链接器版本警告,非错误)。
- `go test ./...`:全绿,含 3 个新测试:
  - `TestPlanEventTaggedWithTurnID`:plan 事件 TurnID 透传 + ls.currentPlan 快照。
  - `TestPersistTurnPlanWritesRolePlanMessage`:persistTurnPlan 落库 + tool_call_id=turnID + 空 entries 不写。
  - `TestRunPromptPersistsPlanOnFinalize`:end-to-end(SendMessage → plan 事件 → runPrompt 收尾落库)。
- `cd frontend && bun run build`:tsc + vite 通过(无类型 / 编译错误)。
- `cd frontend && bun test`:60 pass / 0 fail(streamMerge / ModelSelect / MermaidRenderer 等未受影响)。

## 下一步

- 实测:接真 opencode / omp harness 验证整轮 plan 事件流 → 落库 → 重开会话回看(本任务用
  fakeChat + mock 事件覆盖,真 harness 行为需 §5.5 server 模式或桌面 app 实操)。
- 若历史 plan 太多占屏,考虑默认折叠历史 plan(只展开当前 turn 的实时 plan)。当前所有 plan
  共用 PlanTimeline 组件,长 plan 已自带 >8 项默认折叠逻辑,短期不急。
