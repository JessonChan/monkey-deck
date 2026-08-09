# 2026-08-10 Review #97 队列定时实时倒计时 前端 (APPROVE, Task #24246)

**起因**:Task #24246 对 #24244/#24245/issue #97(commit `ae0f9ea`,feat(queue): live
countdown for scheduled items)的前端部分做 Frontend Reviewer 端到端验收。本审只评
前端(`frontend/src/`),无后端改动(纯 UI 增强,见 worklog「不变量」)。

## 复审范围

- `QueuePanel.tsx`(新增 `now` state + `hasPending` + 1s tick `useEffect`、`pending`/
  `remaining` 改用 `now`、future 徽标内追加 `queue-countdown` span、模块级 `formatRemaining`)
- `i18n/locales/{en,zh}.json`(`queue.inRemaining/countdownS/countdownMs/countdownHms`)
- `index.css`(`.queue-countdown`)
- `QueuePanel.countdown.mount.test.tsx`(新 mount-test)
- 类型对齐(`TFunction` 消费)、a11y / data-testid、与 App.tsx 到点发送逻辑的耦合

## 正确性:timer 生命周期(核心)✅

- **Hooks 顺序**:`useEffect` 在早 `return null`(line 52)**之前**注册,守 Rules of Hooks。✅
- **arm/disarm**:`useEffect` dep `[hasPending]`。`hasPending=false` → 不 arm(空转面板零
  定时器开销,§5.3 Less is More);`false→true`(用户新增未来定时项)→ arm;
  `true→false`(最后一条到期 / 全部撤回 / queue 清空)→ cleanup 清 interval。**无定时器泄漏**。✅
- **新 pending 项不重 arm**:interval 已 armed 时,新增未来项只让 `hasPending` 维持 true
  (dep 不变)→ effect 不重跑,interval 持续 tick 覆盖新条目。✅
- **effect 体不读 `now`**:`setInterval(() => setNow(Date.now()), 1000)` 闭包不引用 `now`,
  无 exhaustive-deps 缺失,无 stale-closure。✅
- **单一时间源**:`now` 作 header 时钟检查 / per-item `pending` / `remaining` 唯一来源,
  避免「`pending` 用 `Date.now()`、倒计时用 stale `now`」的 1 帧闪烁(worklog 已述)。✅
  schedule input 的 `min={toLocalInput(Date.now())}` 是非受控 input 的 UX 提示,且
  `hasPending=false` 时 `now` 冻结、用 `Date.now()` 更准——不改,合理。

## formatRemaining 纯函数 ✅

- `ms<=0` 返空串(render 处 `remaining>0` 守卫兜底,不会渲染);单位取「最粗非零桶」
  (h/m/s → m/s → s),边界数值核对(3905000→1h5m5s、305000→5m5s、45000→45s)无误。
- 走 i18n key,纯函数、无副作用、`TFunction` 标注正确(tsc 通过)。

## 与 App.tsx 到点发送解耦 ✅

实际发送由 `App.tsx` 的 `drainSession`(找 `scheduledAt <= now`)+ `armScheduleTimer`
(一次性定时器到最早 `scheduledAt`)独立驱动,QueuePanel 倒计时纯装饰、不参与判定。
两侧都用同一阈值 `scheduledAt <= now`,视觉上「倒计时归零 ↔ 标记转 due」阈值一致。✅

## i18n ✅

`inRemaining` / `countdownS` / `countdownMs` / `countdownHms` 在 en.json / zh.json
**同行号(364–367)、同插值变量**(`{{remaining}}` / `{{s}}` / `{{m}}` / `{{s}}` /
`{{h}}`/`{{m}}`/`{{s}}`)。en 用缩写单位(`h/m/s`)、zh 用全称(`时/分/秒`),各自
本地化风格一致。无缺失、无错位。

## 类型安全 ✅

`bunx tsc --noEmit`(排除 `bindings/` 中间产物)零错误。`import type { TFunction } from
"i18next"` 标注 `formatRemaining` 参数,`formatRemaining` 返回 `string` 进 `t()` 插值,
全链路类型自洽。无「字段加了但全链路没人消费」(§类型补丁反模式):新 i18n key 均被
`QueuePanel.tsx` 消费,`queue-countdown` testid 被 mount-test 消费。

## CSS / 主题 ✅

`.queue-countdown { color: var(--text-3); font-weight: 400; }` —— `--text-3`/`--amber`
均为既有主题 var(line 16/25)。倒计时后缀相对父徽标(`var(--amber)` / 600)降一档
(灰 / 400),不抢眼、层次合理。无溢出 / 换行风险(行内 span)。

## a11y / data-testid ✅

新增 `data-testid="queue-countdown"`(§4.2)。倒计时为非交互展示文本,父徽标已有
`title={scheduledSendTip}`;无需额外 tooltip / aria。

## 测试质量 ✅

mount-test 按「断言 testid 存在、非 copy」(§反模式)钉两件事:未来项渲染
`queue-countdown` span、已到点项不渲染。react-i18next mock 回显 key + 插值 opts,
断言 `/countdown/` 锚定 helper 运行而非文案。happy-dom + createRoot 路径与既有
schedule/reorder/edit/ime mount-test 同模式。

## 观察项(非阻塞 nit)

### #1 `remaining > 0` 守卫恒真(冗余)

`QueuePanel.tsx:257` 该 span 在 `pending ? (...)` 分支内,而 `pending = scheduledAt > now`
→ `remaining = scheduledAt - now` 必 > 0,故 `remaining > 0 &&` 恒真。属防御性冗余,
功能无影响。§5.3「删掉后功能不变的代码就该删」精神下可简化为直接渲染,不强求。

### #2 mount-test 未 unmount 清 interval(测试卫生)

未来项用例 arm 了 1s interval 但测试结束未 `root.unmount()`。`bun test --isolate` 每
文件重置 registry、实测 17 pass 无 hang,故无实际问题;仅为测试卫生 nit,可加
`root.unmount()` 收尾更干净。

(均不影响正确性 / 不阻塞合入。)

## 验证(acceptance gate)

- `bun install` + `bun test --isolate src/components/QueuePanel`:**17 pass / 0 fail**
  (15 旧 + 2 新),与 worklog 一致。
- `bunx tsc --noEmit`(排除 `bindings/`):**零错误**。
- i18n key 逐行核对 en/zh 同步;CSS var 存在性核对通过。
- 代码层面逐行复核完毕。

## Verdict:APPROVE

timer 生命周期(arm/disarm/无泄漏/无重 arm)、单一时间源一致性、formatRemaining 正确性、
i18n 同步、类型安全、CSS 主题、a11y、测试质量全部过关;与 App.tsx 到点发送逻辑正确
解耦。#1/#2 为非阻塞 nit(冗余守卫 / 测试 unmount 卫生),不影响合入。建议直接合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-review-queue-countdown-frontend.md`(本条,新增)
