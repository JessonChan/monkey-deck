# 2026-08-10 queue scheduled real-time countdown (Task #24245 / issue #97)

## 起因
QueuePanel 里「定时发送」的条目只显示绝对时刻 `⏰ HH:mm`,用户得自己心算「还有多久到点」。
issue #97 要求给定时队列条目加**实时倒计时**(每秒刷新),让用户一眼看到「in 5m 30s」。

## 设计
- **setInterval tick**:组件挂一个 1s `setInterval`,驱动一个 `now` state,触发整面板重渲染。
  倒计时显示在原 `⏰ HH:mm` 徽标后作括号后缀:`⏰ 14:30 (in 5m 30s)`。
- **formatRemaining(ms, t)**:模块级纯函数,把剩余毫秒按「最粗非零桶」格式化:
  - `>= 1h` → `Xh Ym Zs` / `X时Y分Z秒`
  - `>= 1m` → `Ym Zs` / `Y分Z秒`
  - `< 1m` → `Zs` / `Z秒`
  - `<= 0` → 空串(由 `remaining > 0` 守卫兜底,不会渲染)
  - 单位串走 i18n key(`queue.countdownHms/Ms/S`),en/zh 各自本地化。
- **卸载清 timer**:`useEffect` 返回 `() => clearInterval(id)` —— 组件卸载或 `hasPending` 翻 false 时清掉。
- **省电守卫(§5.3 Less is More)**:tick **只在有 pending(未来定时)条目时 armed**。
  `hasPending = queue.some(q => q.scheduledAt > now)`;无定时条目 → 零定时器开销,空转面板不重渲染。
- **一致性**:`now` 作为唯一「当前时刻」来源,header 时钟检查 / per-item `pending` / 倒计时 `remaining`
  全部读 `now`,避免「`pending` 用 `Date.now()`、倒计时用 stale `now`」的 1 帧闪烁。
  (注意:`schedule input` 的 `min` 属性仍用 `Date.now()` —— 它是非受控 input 的 UX 提示,
  且 `hasPending=false` 时 `now` 会冻结,用 `Date.now()` 更准;不改。)

## 不变量 / 协议无关
- 纯前端 UI 增强,**不碰 ACP / SQLite / QueueItem schema**(`scheduledAt` 字段早已存在,见 types.ts)。
- 不影响 drainSession / armScheduleTimer / 到点发送逻辑 —— 那些仍由 App.tsx 的 `scheduledAt <= now` 判定驱动。

## 改了哪些文件
- `frontend/src/components/QueuePanel.tsx`
  - `useEffect` 进 import;`import type { TFunction } from "i18next"`(给 `formatRemaining` 标注)。
  - 新增 `now` state + `hasPending` + 1s tick `useEffect`(放在早 `return null` 之前,守 Rules of Hooks)。
  - header 时钟检查由 `queue.some(...Date.now())` 改用 `hasPending`;per-item `pending` 改用 `now`,
    新增 `remaining = pending ? scheduledAt - now : 0`。
  - future 徽标内追加 `<span data-testid="queue-countdown">`(`remaining > 0` 时)。
  - 新增模块级 `formatRemaining(ms, t)`。
- `frontend/src/i18n/locales/{en,zh}.json`:`queue` 段加 `inRemaining` / `countdownS` / `countdownMs` / `countdownHms`。
- `frontend/src/index.css`:`.queue-countdown { color: var(--text-3); font-weight: 400; }`(徽标本体保持 amber/600,倒计时后缀降一档不抢眼)。
- `frontend/src/components/QueuePanel.countdown.mount.test.tsx`(新):mount-test 钉两件事 ——
  未来条目渲染 `queue-countdown` span;已到点条目不渲染。

## 验证
- `bun test --isolate src/components/QueuePanel`(全部 5 个文件)**17 pass / 0 fail**(15 旧 + 2 新)。
- `bun run build`:我改动的 4 个文件(`QueuePanel.tsx`/`en.json`/`zh.json`/`index.css`)**零 TS / 编译错误**;
  其余报错全是 `bindings/` 缺失(`wails3 gen bindings` 产物,本 worktree 未生成,与本改动无关、环境性)。
- 行为复核:`hasPending` true→false 转换清 interval(卸载 / 最后一条到期 / 全部撤回);新增 pending 条目时
  `hasPending` 已 true 不重 arm(interval 持续 tick 覆盖新条目)。无定时器泄漏。

## 下一步
- 可选(不在本任务):倒计时最后 10s 变红 / 加紧迫感动画;当前 KISS 不做,先看实际使用反馈。
