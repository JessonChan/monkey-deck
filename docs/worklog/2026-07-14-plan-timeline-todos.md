# 2026-07-14 agent 执行计划时间线(plan todos 可视化)

## 起因

Task #15090:把 agent 的 todos / 执行计划做成可视化时间线 / 进度条。ACP 协议有 `SessionUpdate.Plan`
(stable)与 `PlanUpdate`(unstable)两种 plan 事件,每项 entry 带 `content + priority + status`
(pending/in_progress/completed),整表替换模型。后端 handler 之前只发了 `kind:"plan"` 空壳、没把
entries 透传给前端,故前端无数据可渲染。

## 根因 / 协议调研

- ACP `SessionUpdatePlan.Entries []PlanEntry`(stable):整表替换,每次发全量。
- `SessionPlanUpdate.Plan` 是 `PlanUpdateContent` union(UNSTABLE),其中 `Items` 变体带结构化 entries,
  `File`/`Markdown` 是文件 URI / 原始 markdown(无结构化项)。
- plan 是 **session 级实时状态**,不是消息项:不入消息流 timeline、不持久化为 message(类比 usage_update /
  config_option)。重开会话不恢复 plan(plan 是当轮工作的实时快照,turn 结束即过时)。
- 整表替换 = 前端无需做增量归并,直接替换 planBySession[id] 即可(§5.3 找不变量:不变量就是「全量替换」,
  harness 已保证)。

## 改法

1. **后端透传(最小数据管道)**:`internal/acp/handler.go`
   - `SessionEvent` 加 `PlanEntries []PlanEntry` 字段 + `PlanEntry{Content,Priority,Status}` 结构。
   - `flattenUpdate` 的 `u.Plan` 分支填 entries;新增 `u.PlanUpdate` 分支(取 `Items.Entries`,File/Markdown 忽略)。
   - `flattenPlanEntries` 拍平 acp.PlanEntry → 前端友好的 []PlanEntry。
   - plan 事件在 chat.go handleEvent 里本就 fall-through 到 emit(不进 timeline、不持久化),无需改动。

2. **前端 session 级状态**:`App.tsx`
   - `planBySession` 状态(类比 configOptionsBySession)。
   - `applyEvent` 拦截 `kind === "plan"` → 整表替换。
   - 新 turn(status→prompting)清掉上一轮 plan(避免旧计划残留;agent 会在本 turn 重发)。
   - 派生 `plan` 传给 ChatView。

3. **可视化组件**:`ChatView.tsx` 的 `PlanTimeline`
   - 头部:ListChecks/check 图标 + 「执行计划」+ `已完成/总数` + 进度条(green fill) + 百分比 + 折叠 chevron。
   - 体:每项一行(状态图标:pending=空心圆、in_progress=spinner、completed=绿勾)+ 内容 + 高优先级徽章。
   - 进行中高亮(text-1 + accent spinner)、完成提亮+删除线、待处理灰。
   - 长计划(>8 项)默认折叠避免占屏;短计划默认展开。可手动 toggle。
   - 渲染位置:chat-body 内 items 之后、typing-indicator 之前(与消息流同区,视觉协调)。
   - 复用现有 `collapse-body` 动画 + `thought-spinner`,无新依赖(§4.6 轻量)。

4. **样式**:`index.css` 新增 `.plan-timeline` / `.plan-summary` / `.plan-progress` / `.plan-entries` /
   `.plan-entry` 等规则,配色复用主题变量(--green/--accent-2/--red)。

## 改了哪些文件

- `internal/acp/handler.go`(后端:plan entries 透传)
- `frontend/src/types.ts`(PlanEntry 类型 + planEvents 字段)
- `frontend/src/App.tsx`(planBySession 状态 + 事件路由 + 传 prop)
- `frontend/src/components/ChatView.tsx`(PlanTimeline 组件 + 渲染)
- `frontend/src/index.css`(plan timeline 样式)

## 验证

- `go build ./...` / `go vet ./...` / `go test ./...` 全绿(无新测试,plan 是纯透传 + 前端渲染)。
- `cd frontend && bun run build`:tsc + vite 无类型/编译错误。
- `bun test`:27 pass(streamMerge 等未受影响)。

## 下一步

- 实测:接真 opencode harness 验证它发的是 `Plan` 还是 `PlanUpdate`(两者都已兼容)。
- 若需要跨 turn 保留计划历史(回看每轮的计划),再考虑把 plan 快照持久化到 DB(当前 KISS:不持久化)。
