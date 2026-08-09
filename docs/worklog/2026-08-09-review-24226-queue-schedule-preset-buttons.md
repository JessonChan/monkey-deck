# 2026-08-09 · Review #24226 QueuePanel 定时预设按钮(QueuePanel.tsx + mount 测试)

## 起因
Task #24227(前端 reviewer):对 #24226(230cfee `feat(queue): +5/+10/+30min preset buttons
in schedule-row`,PR #98)做前端验收。改动 5 文件、+53 行,纯前端增量:
- `frontend/src/components/QueuePanel.tsx`:+19(`presetSchedule(mins)` + `SCHEDULE_PRESETS`
  + 三个 `queue-btn preset` 按钮,插在 queue-schedule-row 的 Save 之前)。
- `frontend/src/index.css`:+2(`.queue-btn.preset` 默认 text-3、hover accent-2 + border 色)。
- `frontend/src/i18n/locales/{zh,en}.json`:各 +2(`queue.schedulePreset` / `schedulePresetTip`)。
- `frontend/src/components/QueuePanel.schedule.mount.test.tsx`:+28(三个预设各点一次的用例)。

功能:queue-schedule-row(定时编辑态)在 Save 前加 +5/+10/+30min 三个预设;点一个调
`onSchedule(id, Date.now()+mins*60_000)` 并退出编辑态(与 `clearSchedule` 同模式)。

## 验收方法(对照反模式清单)
从**定义点**追到**消费点**,确认全链路真实消费(非「字段加了没人用」):

| 新增符号 | 定义点 | 消费点(逐跳) | 结论 |
|---|---|---|---|
| `presetSchedule(mins)` | `QueuePanel.tsx:86` | `onClick={() => presetSchedule(mins)}` L181(三个预设按钮 map 内) | ✓ |
| `SCHEDULE_PRESETS` | `QueuePanel.tsx:92` | L176 `.map((mins) => …)` 渲染三按钮 | ✓ |
| i18n `queue.schedulePreset` | en/zh.json L351 | L184 `t("queue.schedulePreset", { mins })`(按钮正文) | ✓ 两端同步 |
| i18n `queue.schedulePresetTip` | en/zh.json L352 | L182 `title={t("queue.schedulePresetTip", { mins })}` | ✓ 两端同步 |
| `.queue-btn.preset` | index.css:1376-1377 | L179 `className="queue-btn preset"` | ✓ |

**无类型补丁反模式**:新增函数 / 常量 / i18n key / CSS class 全部有写有读,无悬挂字段。

## 行为正确性复核
- **`presetSchedule` 与 `clearSchedule` 同构**(L86-91 vs L79-84):guard `!schedulingId` →
  `onSchedule(schedulingId, …)` → `setSchedulingId(null)` + `setScheduleError(null)`。
  唯一差异是时间参数:`clearSchedule` 传 `Date.now()`(=立即),preset 传 `Date.now()+mins*60_000`
  (= N 分钟后)。语义与 §Props 注释「scheduledAt 0/Date.now()=立即」一致。✓
- **`Date.now()` 单次取值**:L88 `Date.now() + mins * 60_000` 在一次调用内求值一次,无 stale
  风险(不像 `saveSchedule` 读 ref 两次)。✓
- **退出编辑态生效**:preset 后 `setSchedulingId(null)` → `schedulingId === item.id` 为 false →
  schedule-row 整段 unmount,回到默认展示分支。测试锚定 `queue-schedule-input` 变 null。✓
- **无过期复验需要**:与 `saveSchedule` 不同,preset 时间恒为未来(now+Nmin,N≥5),不存在
  「用户手动键入过去时刻 / 停留过久致合法时刻变过去」的过期路径,故无需走 `scheduleExpired`
  复验。设计正确,非漏判。✓
- **按钮顺序**:预设 → Save → Cancel → (pending 时)Clear。预设排在 Save 前,符合「快捷动作
  靠左、确认/取消靠右」的常见节奏;预设本身即提交(无需再点 Save),与 Save 各自独立提交,
  无交互冲突。✓
- **键盘可达**:原生 `<button>`,Enter/Space 默认触发,无需额外 onKeyDown。✓
- **`key={mins}`**:map key 用稳定数字(5/10/30),非数组 index,重渲染稳定。✓

## 纪律对齐
- §3.7 英文注释:`presetSchedule` 注释 L85 `// Preset: schedule N minutes from now, then close
  the schedule row.` 全英文。✓
- §4.2 data-testid:`queue-schedule-preset-${mins}`(`queue-schedule-preset-5/10/30`),离散可点
  元素均带 testid。✓
- §4.4 不裸露结构化格式:按钮正文是 `+5m` / `+5分`(人话),非 JSON / 字段名。✓
- §5.3 找不变量:`mins` 作为主键驱动(map key + testid 后缀 + i18n 插值),单一数据源,无启发式。
- i18n en/zh 同步:两端均加 `schedulePreset` / `schedulePresetTip`,插值参数 `{{mins}}` 一致。✓
- CSS:`.queue-btn.preset` 复用基类(基类 L1359 已有 `border: 1px solid var(--sep-strong)`),
  hover 的 `border-color: rgba(100,210,255,0.3)` 在已有 border 上生效(非凭空加 border-width);
  配色 accent-2 与 `.save` / `.interrupt` 同色系,视觉一致。✓

## 类型 / 构建 / 测试
- `bun test src/components/QueuePanel`:**15 pass / 0 fail**(4 文件;schedule 文件 6 个 = 旧 5 + 新 1),
  与 worklog 声称一致。新用例覆盖三个预设各点一次。
- `bunx tsc --noEmit`:QueuePanel.tsx / index.css / locales **0 新增类型错误**;仅全仓预存的
  generated bindings 模块未找到(worktree 未跑 `wails3 gen bindings`,与本次改动无关)。
- 测试质量(对照反模式「锚定值,非字段存在」):断言全部锚定值 ——
  - `calls[0].id === "q1"`、
  - `calls[0].scheduledAt` 在 `[before + mins*60_000, after + mins*60_000]` 区间(容忍事件循环延迟)、
  - 点击后 `queue-schedule-input` 为 null(行关闭)。
  非仅断言「onSchedule 被调」。✓ 每个预设独立 mount(干净状态),无跨用例污染。

## 观察(非阻塞,不阻止合并)
1. **§4.5 tooltip 硬约束 —— 预存的全文件问题(新按钮沿用,非本次引入)**:
   AGENTS §4.5 规定「统一 react-tooltip(`data-tooltip-id="md-tip"` + `data-tooltip-content`),
   禁用原生 `title`」。本仓其它组件(Sidebar / Composer / ChatView / HarnessSettings 等数十处)
   全部走 `md-tip`(Tooltip 实例挂载于 `App.tsx:2142`)。**但 `QueuePanel.tsx` 里所有 `queue-btn`
   按钮(save/cancel/clear/schedule/edit/interrupt/revoke + 本次新增 preset)都用原生 `title=`**,
   只有 `queue-header-clock`(L103)与 `queue-grip`(L225)用 react-tooltip。这是**预存的文件级
   违规**,新 preset 按钮与同 row 的 save/cancel/clear 保持一致(都用 title)。
   **不在本次阻断**:若只把 preset 三个改成 react-tooltip,同一 row 内会出现「preset 用悬浮提示、
   save/cancel 用原生 title」的撕裂,反而更糟;正解是把 QueuePanel 全部 `queue-btn` 的 `title=`
   统一迁到 `data-tooltip-id/content`,宜作**单独 follow-up 任务**(改动面是全文件、与本任务
   「加预设按钮」是两件事,§6.2 原子提交也不宜混做)。
2. **`SCHEDULE_PRESETS` 定义在组件体内**(L92):每次 render 重建一个 3 元素常量数组。开销可忽略,
   但更干净的做法是提到模块顶层(与文件底部 `formatClock`/`toLocalInput` 同层)。纯风格,非阻塞。

## 结论
**APPROVE #24226(Task #24227 PASS)。** 逻辑正确(与 clearSchedule 同构、Date.now 单次取值、
无过期路径需复验)、无类型补丁反模式、i18n en/zh 同步、CSS 配色与同色系一致、data-testid 齐全、
键盘可达;15/0 测试过、0 新增类型错误;测试锚定值(时间区间 + 行关闭)。
一个 §4.5 预存全文件 tooltip 问题(新按钮沿用、宜单独 follow-up 全文件迁移)+ 一个常量位置风格
nit,均非阻塞。

## 下一步 / OUT OF SCOPE
- QueuePanel 全文件 `queue-btn` 的 `title=` → react-tooltip(`md-tip`)迁移(单独任务,§4.5)。
- `SCHEDULE_PRESETS` 提到模块顶层(可选风格优化)。
