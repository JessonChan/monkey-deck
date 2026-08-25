# 2026-08-26 Review #24299(#24297 / #130 前端):定时预设累加式——PASS(无阻塞缺陷,附观察项)

## 审查对象
- `62474ea` feat(frontend): QueuePanel 定时预设改累加式(#130)。
- `20b5030` test(queue): 定时预设累加/seed 叠加/24h 钳制 mount 测试(#130)。
- 范围仅前端(`frontend/src/`):QueuePanel.tsx / index.css / i18n(zh+en)/ mount 测试。

## 结论:**PASS**(实现与 issue #130 + worklog 设计一致,零阻塞缺陷;4 条非阻塞观察见下)

## 逐项核验(任务指定重点)

### 1. base=max 叠加 ✅
- `presetSchedule`:`base = pendingAt !== null && pendingAt > Date.now() ? pendingAt : Date.now()`
  ——严格 `max(暂存, now)`;暂存已过期(开行停留过久)自动回落 now,不在死值上继续叠。
- 每次点击 `at = base + mins`,ref 回写非受控 datetime-local(程序化赋值不触发 onChange,
  无回环);`saveSchedule` 读 DOM 值提交,pendingAt↔input 双向同步闭环成立。

### 2. 不关行连点 ✅
- `presetSchedule` 不调 `onSchedule`、不清 `schedulingId`——行保持打开,可继续点/手调。
- 测试锚定:连点 5+10+30 后 `calls.length === 0` + input 仍在 + chip 可见;Save 才
  `calls.length === 1` 且锚定 epoch 区间 `[before+45m−1m, after+45m]`(1m 为 datetime-local
  分钟截断容差)。**断言锚定值而非字段存在**(反模式清单 ✓)。

### 3. 累计 chip 重置 ✅(reviewer 补充实证,PR 测试未覆盖此路径)
- `startSchedule` 每次开行都重置 `pendingAt`(seed = 条目未来 scheduledAt,否则 null)+
  `scheduleCapped=false`——stale 暂存不会跨会话泄漏。
- **reviewer 临时探针测试实证**(跑完即删):①未定时条目上叠 35m → 取消 → 重开 → chip
  无(旧栈弃置),再点 +5 从 now 起步(Save 提交 < now+6m);②已定时条目(seed 20m)叠
  +30 后取消重开 → chip 回到 seed ~20m(非 ~50m)。两条均过。

### 4. 24h 上限双路径 ✅(按 worklog 设计口径;见观察 #1 的口径说明)
- 预设路径:每次点击独立算 `cap = now+24h`,`at > cap` 即钳到 cap 并置 `scheduleCapped`
  ——**新鲜起步连点**与 **seed 叠加**两条到达上限的子路径都过同一钳制代码。测试锚定:
  seed 23h55m + 30m×2 → cap 提示出现、二次点击不再增长、Save 提交值 `≥ before+24h−1m` 且
  `< seed+60m`(证明确实钳了,非未叠加)。
- 手动 datetime 路径:**按设计不钳**(worklog:「手改 datetime = 覆盖暂存并清 cap」)——
  手选超 24h 是自由逃生口,onChange 清掉 cap 提示。✅ 符合实现任务口径。

### 5. 取消回原值 ✅
- `cancelSchedule` 只清 `schedulingId`/`scheduleError`,**不调 `onSchedule`**——条目
  `scheduledAt` 原值不动(组件本就不持有队列真相,props 镜像未变)。探针实证取消后
  `calls.length === 0`;重开行 seed 回条目原值(同上第 3 点)。
- 残留 `pendingAt` 不可见(chip 只在开行分支渲染)且被下次 `startSchedule` 重置;`staging`
  随 `schedulingId=null` 熄灭,ticker 无泄漏。

### 6. 不回归 ✅
- ticker 由 `hasPending` 扩为 `hasPending || staging`(超集),既有倒计时行为不变;无
  staging 且无 pending 时仍零定时器(§5.3)。
- 旧「预设=立即提交+关行」测试已按 #130 语义改写;全仓 grep 无其它消费
  `queue-schedule-preset*` 的测试/E2E;旧 tooltip 文案("N minutes from now")无残留引用。
- 非受控 input 模式沿用既有(edit 行同款),React 重渲(now 每秒 tick)不会覆写 DOM value。
- i18n:4 键(schedulePresetTip 改写 + schedulePending/schedulePendingTip/scheduleCap 新增)
  zh/en 成对同插值参,`locales.test.ts` 过;文案人话化(§4.4 ✓,chip 为「⏱ 剩余 · 时刻」)。
- 类型:`pendingAt: number | null` 全链路类型正确,`tsc --noEmit` 过。
- **反模式排查(类型补丁)**:新增 state/键/类全部有真实消费端——`pendingAt`(base 计算/
  chip 渲染/staging 门)、`scheduleCapped`(cap span + 三处清理)、i18n 键(渲染)、
  CSS 类(组件引用)。无死字段。

## 非阻塞观察(记录,不要求本次改)

1. **onChange 双向联动零自动测试覆盖**(测试缺口,非 bug):happy-dom 无法触发 React 对
   datetime-local 的 onChange(测试文件头已记载的既有边缘;reviewer 用 input/change/
   InputEvent 三种派发均未通电,探针实证 chip 不亮)。PR 的 mount 测试全部绕过 onChange
   (原生 setter + Save 直读 DOM),**手选覆盖暂存/清 cap 这条新耦合只有代码推演**。
   worklog 亦记「未做真机/浏览器手动冒烟」。建议:后续在 server 模式(§5.5)补一条真
   浏览器 E2E,或真机冒烟时专门点这条路径。
2. **混用时「+」可使时刻回退**(UX 边角):手选 3 天后(合法,手动路径不钳)再点「+5」
   → base=3 天后 > cap → 钳回 now+24h,**暂存时刻向后跳 ~48h**(「加」按钮让时间变早)。
   代码推演确定(钳制对 base 也生效)。属设计取舍而非缺陷:若要更直觉,可改为「base 已
   超 cap 时保持 base 仅提示不再叠加」,需产品拍板,本次不动。
3. `presetSchedule` 读渲染闭包的 `pendingAt` 而非函数式更新(`setPendingAt(prev => …)`):
   离散 click 事件 React 逐事件同步 flush,真实连点每次都拿到新闭包,当前无 bug;但若未来
   在同一 handler 里连调两次会丢一次增量。健壮性备注。
4. 既有债务(非本 PR 引入,仅记录):①预设/保存/取消等按钮仍用原生 `title`(§4.5 说禁用,
   全文件既有模式,本 PR 只改了 tooltip 文案且文案正确);②定时行无 Esc 关闭(编辑行有,
   §4.2 约束延伸的不一致);③桌面 >768px 开行态 actions(nowrap + flex-shrink:0)新增
   chip ~130px,窄桌面窗口(~800-900px)理论上有横向溢出风险,≤768px 已正确独行换行。

## 验证
- `bun install` + `wails3 generate bindings`(worktree 缺生成产物,按 worklog 补齐)。
- `bun test src/components/QueuePanel src/i18n`:**24/24 过**(含重写 3 + 新增 3 的 #130 用例)。
- `bunx tsc --noEmit`:**过**(0 错误)。
- 全量 `bun test`:261 pass / 6 fail——全部为 NewSessionModal.mount 的 **pre-existing**
  (`mcpServerIDs: []` 期望缺失;该文件最后由 7f171e1 触及,早于本 PR;与 #24297 改动无交集)。
- reviewer 探针(临时文件,跑完已删):取消不提交 / 取消重开 chip 重置(未定时 + seed 两路)
  实证通过;onChange 路径 happy-dom 不通电(观察 #1)。
- 三端(§4.7/§5.6):纯前端组件/CSS/i18n 改动,同构 React 树;移动端 ≤768px 断点内扩展
  既有换行规则(chip/cap/error 同组 flex-basis:100%),>768px 无新增生效规则;远程端无
  `isRemoteClient()` 分支触及。与 coder worklog 论证一致。

## 下步
- OPEN:onChange 手选覆盖路径的真浏览器/E2E 验证(观察 #1,可搭 #130 真机冒烟一起)。
- 既有:NewSessionModal.mount 6 个 pre-existing 失败(mcpServerIDs 期望)另任务处理;
  预设按钮原生 title → react-tooltip 迁移可作为 QueuePanel 级清理任务。
