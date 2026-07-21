# 2026-07-22 Review #38 plan 默认展开 + session 持久化端到端验收结论(PASS)

## 起因

Task #21299(Review):验收 Task #21298「plan 默认展开 + 展开偏好按 session 持久化」的
2 个 commit(`44a7e25` 前端实现 / `af13d70` worklog)。

重点不是「能否编译」,而是「代码是否真的实现了所需行为变更」——拒收「改了签名/类型
但函数体行为不变、构建绿但 bug 仍在」的常见失败模式。

## 验收方法

1. 通读 worklog(`2026-07-22-plan-default-expand-per-session.md`)+ 2 个 commit diff。
2. 逐处核对控制流(不只看 diff 表面):
   - `ChatView` 新增 `planOpen` state 的 lazy initializer
     (`ChatView.tsx:150-153`):`saved === null ? true : saved === "1"` →
     **无记录默认展开**,确认不再有 `total <= 8` 的按条数折叠判断。✓
   - `[props.sessionId]` effect(`ChatView.tsx:156-159`):切 session 时重读 localStorage,
     与 initializer 用**同一表达式**(`saved === null ? true : saved === "1"`)。✓
   - `onTogglePlanOpen`(`ChatView.tsx:160-166`):`useCallback` deps=[sessionId],
     翻转后写 `md:plan-open:<sessionId>` = `"1"`/`"0"`。键含 sessionId → **per-session**。✓
   - 两处 `<PlanTimeline>` 调用(history plan `ChatView.tsx:478` / livePlan `:494`)
     均传 `isOpen={planOpen}` + `onToggle={onTogglePlanOpen}` → 整 session 同步受控。✓
   - `PlanTimeline` 函数体(`ChatView.tsx:1302-1345`):签名加 `isOpen`/`onToggle`,
     **删除**原 `manual`/`defaultOpen`/`toggle`;`onClick={onToggle}`、
     `aria-expanded={isOpen}`、`className={…isOpen?"open":""}`、`{isOpen && <ol…>}` 全部
     用受控 props → 真正改了行为,非空壳签名。✓
   - 全仓 grep `PlanTimeline` 仅 2 处调用点 + 1 处定义,无遗漏未改的调用。✓
3. 跑命令(§8 自检):
   - worktree 初始 `node_modules` 为空 + bindings 未生成 → build/test 全报环境错;
     `bun install` + `wails3 generate bindings` 补齐后:
     `bun run build` 成功(仅 chunk 体积告警,既有无关项)、`bun test` 60 pass / 0 fail。
     与 worklog 宣称一致。

## 关键判断(行为是否真的改变)

- **默认展开**:initializer + effect 同用 `saved === null ? true`,>8 项的 plan 不再默认折叠。
  旧实现下 `defaultOpen = total <= 8` 会让长计划收起,新实现彻底移除该判断。✓
- **per-session 持久化**:键 `md:plan-open:<sessionId>` 随 session 隔离;偏好上提到 ChatView
  (单一真相源)而非留在 PlanTimeline 内,故同一 session 的实时 plan + 各历史 turn plan 共用
  一个偏好,折叠一次全 session 遵循。设计理由(上提 vs 内嵌)worklog 写得充分,与「per-session」
  语义自洽。✓
- **session 切换重读**:ChatView 不随 sessionId 变化重挂载(用 `prevSessionIdRef` 检测),
  故 effect 是必需的——否则切 session 会沿用上一 session 内存态。逻辑正确。✓
- **重开会话恢复**:ChatView 首次挂载 lazy initializer 读 localStorage,跨进程恢复。✓

## 规约合规

- §4.2:`plan-timeline` / `plan-entries` / `plan-entry` 三个 `data-testid` 保留,
  测试友好。✓
- §4.4 / §4.5:本次改动不涉及新增裸露结构化格式或 tooltip 场景。✓
- §0.3 / §6.2:worklog 已写、2 commit 原子(实现/文档各一),commit message 说清改了什么+为什么。✓

## 次要观察(不阻塞)

- `onTogglePlanOpen` 在 `setPlanOpen` 的 updater 里写 `localStorage.setItem`(副作用)。
  React 要求 updater 纯函数(StrictMode 下会双调用);此处写的是幂等定值,实测无害,
  但属轻微 code smell。更地道写法是先算 next → setItem → setState。不阻塞,记作后续可打磨项。
- 首次挂载时 lazy initializer 与 `[props.sessionId]` effect 都读一次 localStorage(冗余一次);
  React 对同值 setState 会 bail-out,无额外渲染,无害。
- **无自动化测试断言本行为**:`PlanTimeline` 是 ChatView 内部非导出函数,隔离测需先导出/抽离;
  worklog「下一步」已记真 harness / §5.5 server 模式实操待办。本次以「代码逐处核对 + build/test 绿」
  作验收,与前序 Review #39 同一基线(可接受);若日后导出 PlanTimeline 建议补一个
  「>8 项默认展开 / 折叠后写 localStorage / 切 session 重读」的 mount 测试以锁回归。

## 结论

**PASS**。默认展开(彻底移除按条数折叠)+ per-session localStorage 持久化 + 切 session 重读
+ 受控 PlanTimeline 同步,逻辑真实落地、非空壳;build / test 全绿;规约合规。
次要 smell(updater 内副作用)不阻塞,无需改动即可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-plan-default-expand-per-session.md`(本文件)。

## 验证

- `bun install` + `wails3 generate bindings` 补齐环境后:
- `bun run build`:成功(仅 chunk 体积告警)。
- `bun test`:60 pass / 0 fail。
