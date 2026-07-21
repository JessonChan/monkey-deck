# 2026-07-22 plan 默认展开 + 展开偏好按 session 持久化(localStorage)

## 起因

Task #21298。前序 #21295(2026-07-22 按 turn 保留历史 plan)把 plan 做成按 turn 列表后,
`PlanTimeline` 的展开/折叠行为有两个问题:

1. **长计划默认折叠**:`defaultOpen = total <= 8`,>8 项的 plan 默认收起,用户每次都得手动
   展开,体验割裂。
2. **无持久化**:展开状态是组件内 `manual` useState,plan 重新挂载(切 turn / 重开 session /
   live→持久化切换)就丢失,用户设过的展开偏好不记得。

本任务闭合这两点:plan 默认展开,展开偏好按 session 持久化到 localStorage。

## 改法

**核心决策:把偏好上提到 ChatView(单一真相源),而非留在 PlanTimeline 内。**

为什么上提:同一 session 内有多条 PlanTimeline(当前 turn 的实时 plan + 每个 history turn 的
静态 plan),「按 session 持久化」最自然的语义是**一个 session 一个偏好**——用户折叠一次,
该 session 的所有 plan 都遵循,重开会话恢复。若留在 PlanTimeline 内各自持有 state,折叠一条
不会同步到其他条,与「per-session」语义不符,且 ChatView 不随 session 切换重挂载(用 ref
检测,见 `prevSessionIdRef`),内嵌 state 不会在切 session 时重读 localStorage。

上提后 ChatView 持有单一 `planOpen` state + `onTogglePlanOpen`,以 props 下发给两处
`PlanTimeline`(history plan 分支 + livePlan 分支),保证整 session 同步。

**localStorage 键**:`md:plan-open:<sessionId>`(与既有约定 `md:notify-sound` / `md:lang`
同前缀风格)。值 `"1"`/`"0"`,缺省(`null`)视作默认展开。

**session 切换重读**:ChatView 不重挂载,故加一个 `[props.sessionId]` effect,切 session 时
从 localStorage 重读该 session 的偏好,避免沿用上一 session 的内存状态。

**默认展开**:`useState` 初始化 + effect 都用 `saved === null ? true : saved === "1"`,
即无记录时默认展开。`PlanTimeline` 内删除原 `manual`/`defaultOpen`/`toggle` 逻辑,改受控
(`isOpen`/`onToggle` props)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - ChatView 新增 `planOpen` state(`useState` lazy initializer 读 localStorage,默认 true)
    + `[props.sessionId]` effect(切 session 重读)+ `onTogglePlanOpen`(`useCallback`,写 localStorage)。
  - 两处 `<PlanTimeline>` 调用(history plan / livePlan)传 `isOpen={planOpen}` +
    `onToggle={onTogglePlanOpen}`。
  - `PlanTimeline` 签名改 `{ entries, prompting, isOpen, onToggle }`,删除内部
    `manual`/`defaultOpen`/`toggle`,header 按钮 `onClick={onToggle}`。

## 验证

- `cd frontend && bun run build`(tsc + vite):clean(只剩 chunk size 警告,非错误)。
- `cd frontend && bun test`:60 pass / 0 fail(streamMerge / ModelSelect / MermaidRenderer 等未受影响)。
- 无 Go 改动;`go build ./...` / `go vet ./...` 不受影响(本任务纯前端)。

## 下一步

- 实测:接真 opencode / omp harness,验证「折叠后切走再切回仍折叠」「重开 app 仍折叠」
  「不同 session 独立偏好」(本任务用 build + 既有单测覆盖,真行为需桌面 app / §5.5 server 模式实操)。
- 若将来要把偏好粒度细化到 per-turn(每个 plan 独立展开),键改成 `md:plan-open:<sessionId>:<turnId>`,
  并把 state 回退到 PlanTimeline 内(届时需处理跨组件同步)。
