# #192 repeat 免过期误拦:saveSchedule 按 repeat 分流 + datetime dirty 判定

日期:2026-09-03
状态:完成(代码 + mount 测试全绿;真机 repeat 提交手感留人)
任务:Task #28977(基于 main 最新,含 bdd692c #184 修复,零冲突)

## 起因

队列行点「定时」展开编辑行后选循环档再点 Save,偶发被「定时时刻已过期」拦截。#192 拍板修法:repeat 场景免过期误拦,首发立即、循环自提交时刻起算。

## 根因

- `saveSchedule` 提交复验 `if (ts > 0 && ts <= now)` 一律拦截;
- datetime 默认值 = 行展开时刻的 `defaultLocalInput()`(now+1min),但 `toLocalInput` 按**分钟截断**——展开在 `:59s` 时默认值只领先 ~1s;
- 选 repeat 档停留数秒后默认值即成过去 → 复验必拦。合法的「选了循环 = 立即发 + 按间隔循环」意图被误杀。

## 修法(拍板四点,逐条落地)

1. **repeat-only 分流**(守卫次序:先于过期复验):`repeatPickedMs > 0 && !datetimeDirty` 时跳过过期复验,Save 走 `onSetRepeat(...)` 重申档位(幂等,兜住选择时丢包)+ `onSchedule(schedulingId, Date.now())`(首发立即;循环自发送时刻起算,`rescheduleRepeat` 的 `nextAt = send + interval` 既有语义,后端零改动;`clearSchedule` 的 due-now 先例同款)。
2. **dirty 判定**:`datetimeDirty` 仅由 datetime 控件的**显式编辑**置位;程序化写入(默认种子、preset 叠加、reset/cap 回弹)一律不算。组合态(显式改过 + repeat)复验照常生效——过期仍拦,且保持「过期复验先于 24h cap」的现状次序。
3. **UX**:repeat-only 时 datetime 控件 `disabled` + `min` 属性同步禁用(视觉明确循环不需要选时间);组合态控件保持可用。
4. **纯定时模式零改动**:过期复验 + 24h cap 逻辑一字未动。

**状态细节**:`repeatPickedMs: number | null`(null=未动 / 0=选了不重复 / >0=循环间隔 ms)——行内同步暂存选择,不等 binding 回程的 mirror 追平;`startSchedule`/`resetStaging` 随全部 staging 状态重置,不泄漏出已关行。

## 关键环境发现(mount 测试基建,后续必读)

**happy-dom + React 19 下,datetime-local 的 React `onChange` 合成彻底不可达**(单次 input 事件、warm-up 先装 value tracker 再变值、原生 change 事件、`InputEvent` 四种打法全部实测不触发;select 的 change 可触发,受控组件边角见 `2026-07-23-queue-inline-edit-scheduledat.md`)。但 **React `onInput`(SimpleEventPlugin,无 value-tracker 门控)可正常触发**,且生产环境两者是同一原生 input 事件。因此 `datetimeDirty` 挂在 `onInput` 而非 `onChange`——生产语义不变(显式编辑必然触发),mount 测试可驱动(既有 onChange 依赖的死区行为不受影响,存量测试全绿实证)。spec 原文「onChange 置 dirty」的实现落地为同一语义的 onInput 载体,已在代码注释注明缘由。

**测试确定性**:文件级冻结 `Date.now`,T0 = 分钟边界前 1s → 种子默认值恰领先 1s,人为推进 3s 即稳定复现「停留数秒 → 过期」;RED/GREEN 双态实跑(stash 组件后 repeat-only 场景确实转红,对照三场景保持绿)。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/components/QueuePanel.tsx` | 新增 `datetimeDirty`/`repeatPickedMs` state 与 `repeatOnly` 派生;`saveSchedule` 头部 repeat-only 分支;tier/custom 提交暂存选择;datetime 控件 `disabled`+`min` 条件化+`onInput` 置 dirty;过期复验注释转英文(§3.7)并标注适用面 |
| `frontend/src/components/QueuePanel.repeat-send-now.mount.test.tsx` | 新增:①repeat-only 直发(repeat 档 + 停留 → 无错、onSchedule≈提交时刻、onSetRepeat 收到档位、控件禁用+min 禁用);②纯定时键入过去 → 仍拦(对照);③组合(显式改过去 + repeat)→ 仍拦且控件保持可用(对照);④键入超 24h → cap 提示不回归(对照) |

后端零改动(`ScheduleQueueItem` 的 `<=now` 立即语义、`rescheduleRepeat` #176 重锚、`SetQueueItemRepeat` 均未触碰);App.tsx 无需接线(onSchedule/onSetRepeat 既有);#182 staged 常驻占位 DOM 结构未动。

## 验证

- `bun test --isolate src/components/QueuePanel.repeat-send-now.mount.test.tsx`:4/4 绿;
- **RED 实证**:`git stash` 组件修复后仅场景①转红(#192 误拦复现),②③④对照保持绿;`stash pop` 后 4/4 绿;
- `bun test --isolate`(前端全量):全绿(生成 bindings 后,见下);
- `bunx tsc`:0 错误(本 worktree 首次运行缺 `frontend/bindings/`——wails3 生成物不入库;`wails3 generate bindings` 生成后 tsc 全过,50 个 TS2307 均为缺生成物噪音,与本次改动无关);
- 后端:`go build`/`go test` 未跑(本次零 Go 改动,不动后端面);
- 三端(§4.7):本改动为 QueuePanel 交互逻辑,桌面 GUI/远程浏览器/PWA 共用同一组件逻辑,单测覆盖;桌面像素 diff 不涉及(schedule 行展开才出现的新禁用态,#182 占位布局不变量未被触动——staged-row/slot DOM 与 actions 行结构零改动);**真机 repeat 提交手感留人**(验收明示)。

## 下一步

- 真机(桌面 webview)手动过一遍:选档 → Save 立即首发、循环徽标出现、循环自提交时刻起算;组合态过期仍拦;
- happy-dom onChange 死区/onInput 可用的实测结论可回填 §5.4 坑表(如 orchestrator 认可)。
