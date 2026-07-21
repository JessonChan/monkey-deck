# 2026-07-22 Review #39 plan 按 turn 保留历史端到端验收结论(PASS)

## 起因

Task #21296(Review):验收 Task #21295「plan 按 turn 保留历史」的 4 个 commit
(`72f5edd` 后端 / `04d715b` 前端 / `8cebfe4` 测试 / `4e790f7` worklog)。

重点不是「能否编译」,而是「代码是否真的实现了所需行为变更」——拒收「改了签名/类型
但函数体行为不变、构建绿但 bug 仍在」的常见失败模式。

## 验收方法

1. 通读 worklog(`2026-07-22-plan-history-by-turn.md`)+ 4 个 commit diff。
2. 逐处核对控制流(不是只看 diff 表面):
   - `handleEvent` case plan 设 `e.TurnID = ls.currentTurnID` 后,确认 `s.emit(EventUpdate, e)`
     (`chat.go:1550`)确实发出被改过的 `e`(修改在 emit 之前,同一局部变量)。✓
   - `runPrompt` 的 `persistTurnPlan` 调用(`chat.go:1351`)位于所有早返回分支
     (suppressed / cancelled / error / empty turn)之前 → 取消/失败也持久化部分 plan。✓
   - `SendAndWaitSync` 同样在 `if err != nil` 返回前调 `persistTurnPlan`。✓
   - `AppendMessage` 实参顺序核对:`(ctx, sid, role="plan", kind="plan", content=JSON, toolCallID=turnID)`,
     与 store 签名 `(ctx, sid, role, kind, content, toolCallID)` 一致。✓
3. 跑命令(§8 自检):
   - `go test ./internal/...`:全绿(含 3 个新测试)。
   - `go test ./internal/chat/... -run Plan -v`:`TestPlanEventTaggedWithTurnID` /
     `TestPersistTurnPlanWritesRolePlanMessage` / `TestRunPromptPersistsPlanOnFinalize` 均 PASS。
   - 前端:本 worktree 初始 `node_modules` 为空 + 未生成 bindings → tsc/test/build 全报环境错。
     `bun install` + `wails3 generate bindings` 补齐后:`tsc --noEmit` 0 错、`bun test` 60 pass / 0 fail、
     `bun run build` 成功(仅 chunk 体积告警,既有无关项)。与 worklog 宣称一致。

## 关键判断(行为是否真的改变)

- **后端**:`currentTurnID`(startTurn/SendAndWaitSync 在 AppendMessage 后设)+ `currentPlan`
  (handleEvent 整表覆盖)+ `persistTurnPlan`(turn 收尾落库 role='plan' message,
  tool_call_id 列存 turnID,空 entries 不写)。逻辑真实落地,非空壳。
- **前端**:`livePlanBySession`(当前 turn 实时,带 spinner)+ turn 结束 eager-append 为
  `type:'plan'` ChatItem(用 ref 镜像避开 StrictMode 嵌套 setState + 同 turnId 去重)+
  `messagesToItems` role='plan' 分支(重开会话从 DB 回看)。三态数据流自洽,无类型错。
- **测试质量**:3 个测试断言真实行为(role='plan' 落库 / tool_call_id=turnID / JSON 可解析 /
  空 entries 不写 / e2e tool_call_id == user message ID),旧实现(plan 不持久化)下会
  「want 1, got 0」直接失败 → 非自洽空测试,具备回归价值。

## 规约合规

- §4.4:plan content 虽是 JSON,但从不裸露给用户——经 PlanTimeline 渲染。✓
- §5.3:turnId 取「不变量」(user message ID,协议稳定主键)做 plan-by-turn 归并,
  非启发式分段;turnId 来源(协议无 turnId)已探针验证后动手。✓
- §5.4 #5:plan 作为 turn 级快照在收尾一次性落库,位置(createdAt 晚于本 turn 消息)
  与 live 的 turn 末尾展示一致,不违反「交错写库」原则(该原则针对 thought/tool/agent
  交错,plan 是 turn 级汇总)。✓
- §0.3 / §6.2:worklog 已写、4 commit 原子(后端/前端/测试/文档各一)。✓

## 次要观察(不阻塞)

- `ls.currentPlan = e.PlanEntries` 共享切片底层数组;SDK 每次 callback 构造新事件,实际安全。
- 历史 plan 的展示位置依赖 ListMessages 排序;live 正确性由 eager-append 保证,DB 回看为
  turn 末尾(best-effort,与 live 一致)。worklog「下一步」已记真 harness 实测待办。

## 结论

**PASS**。后端 turnID 透传 + plan 快照 + 收尾落库(全路径)逻辑真实落地,前端三态
(实时 / eager-append / DB 回看)自洽,测试断言真实行为且全绿,规约合规。无需改动。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-plan-history-by-turn.md`(本文件)。

## 验证

- `go test ./internal/...`:全绿。
- `go test ./internal/chat/... -run Plan`:3 PASS。
- `bun x tsc --noEmit`(bindings 已生成):0 错。
- `bun test`:60 pass / 0 fail。
- `bun run build`:成功。
