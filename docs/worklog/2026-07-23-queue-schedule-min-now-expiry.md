# 2026-07-23 feat:定时选择器 min=now + 提交复验过期拦截 + i18n 过期提示(Task #22386)

## 起因
Task #22386:`QueuePanel` 定时选择器(`datetime-local`)有三个缺口:
1. 没设 `min`,用户可在控件里直接选/键入过去时刻 → 定时项变成立即可发(语义错位,与「定时」意图相悖)。
2. 即便 UI 限制了,用户也可能「开了选择器停留过久」或「手动键入过去时刻」绕过 → 提交(`saveSchedule`)时无复验,过期时刻会静默退化成「立即」。
3. 过期被拦截时无可见反馈,用户不知道为什么保存没生效。

## 设计要点(关键决策)
- **两道防线,各司其职**:
  - 第一道(UX):`<input type="datetime-local" min={toLocalInput(Date.now())}>` —— 控件原生禁止选更早时刻(大部分浏览器/WebView 遵守)。
  - 第二道(正确性):`saveSchedule` 提交时复验 `ts > 0 && ts <= Date.now()` → 过期则 `setScheduleError` + `return`,**不调 `onSchedule`**,保持选择器打开等用户改。
  - 两道都必要:min 只是 UX 提示(可绕过 / 不刷新会陈旧),复验才是真相裁决。
- **min 不做定时刷新**:`min` 在选择器打开那一帧的 render 计算 = 那一刻的 now(截到分钟)。不挂 `setInterval` 强制重渲染去刷新 min —— 长停留场景由「提交复验」兜底,不引入额外定时器(§5.3 Less is More,避免无谓重渲染)。
- **错误以 state 承载,生命周期跟选择器行**:`startSchedule` / `cancelSchedule` / `clearSchedule` / 成功 `saveSchedule` 都清 `scheduleError`,保证下次打开不残留。
- **datetime-local 分钟精度**:min 截到分钟(丢秒/毫秒),故 min 的 epoch 可能比真实 `now` 早最多 1 分钟 —— 这是控件语义,不是 bug(测试断言据此放宽:`>= before - 60_000`)。

## 改法
### 1. `QueuePanel.tsx`
- 新增 state `scheduleError: string | null`。
- `startSchedule` / `cancelSchedule` / `clearSchedule` 末尾 `setScheduleError(null)`。
- `saveSchedule`:取出 `ts` 后,`if (ts > 0 && ts <= Date.now())` → 拦截 + 提示 + return;成功路径也清 error。
- `<input type="datetime-local">` 加 `min={toLocalInput(Date.now())}`。
- 选择器行末尾条件渲染 `<span className="queue-schedule-error" data-testid="queue-schedule-error">`(仅 `scheduleError` 非空时)。

### 2. i18n(`en.json` / `zh.json`)
- 新 key `queue.scheduleExpired`:
  - zh:「所选时刻已过期,请选一个未来时间」
  - en:「The picked time has already passed. Please pick a future time.」

### 3. `index.css`
- `.queue-schedule-error`:`color: var(--red)`、`font-size: 11px`、`font-weight: 600`、`flex-shrink: 0`(跟既有红色提示如 `.tc-fail` / `.pe-prio-high` 同色系)。

### 4. 测试(`QueuePanel.schedule.mount.test.tsx`)
新增 2 条:
- 「datetime-local input has min >= now」:打开选择器 → 读 `input.min` → 解析 epoch → 断言在 `[before - 60_000, after]` 窗口(分钟精度放宽)。
- 「submitting a past time is intercepted」:选 5 分钟前的时刻 → 点保存 → 断言 `onSchedule` 0 调用、`queue-schedule-error` 出现、选择器行仍打开(未关闭)。

## 改了哪些文件
- `frontend/src/components/QueuePanel.tsx`:min 属性 + 复验拦截 + error state/UI。
- `frontend/src/i18n/locales/{en,zh}.json`:`queue.scheduleExpired`。
- `frontend/src/index.css`:`.queue-schedule-error`。
- `frontend/src/components/QueuePanel.schedule.mount.test.tsx`:2 条新测试。

## 验证
- `wails3 generate bindings`:补齐(本 worktree 缺 `frontend/bindings`)。
- `tsc --noEmit`:**clean**。
- `bun test`:**109 pass / 0 fail**(新增 2 条;既有 107 全过)。
- `go build ./...` / `go vet ./...`:仅 `frontend/dist` embed 缺失提示(纯前端任务,既有非错误,无 Go 改动)。

## 下一步
- 桌面 app 实测:macOS WebKit / Win WebView2 下确认 `datetime-local` 的 `min` 行为一致(部分老 WebView 允许手键过去时刻,由复验兜底);过期提示在深色/浅色下可读。
- 可选增强:错误出现时给 input 加红色 outline / 抖动反馈(当前仅文字提示)。
