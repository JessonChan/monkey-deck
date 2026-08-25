# 2026-08-26 QueuePanel 定时预设累加式(#130 / Task #24298)

## 起因
[Issue #130](https://github.com/JessonChan/monkey-deck/issues/130):定时预设按钮(+5/+10/+30 分)原是
**一次性绝对设定**——点一下 = `now+Nmin` 并立即关闭设定行,不可组合(设 45 分钟/1 小时只能手动拨
datetime-local)。期望改为**累加式**:点「+5」再点「+30」= 暂存 35 分钟后;设定行不关闭,暂存实时显示;
点「保存」才提交。Task #24298 附加:**24h 上限** + i18n。

## 设计(按 issue #130 的修法,前端纯交互改动)
- **staged 状态**:`pendingAt: number | null`(暂存时刻)+ `scheduleCapped: boolean`(叠加被 24h 钳到)。
  打开设定行(`startSchedule`)时 seed:条目已有未来 `scheduledAt` → 用它(编辑已有定时 = 在其上叠加);
  否则 null(预设从 now 起步)。
- **预设累加**:`presetSchedule(mins)` 的 base = `max(pendingAt, now)`,`at = base + mins 分钟`,
  **钳到 `now+24h`**(`SCHEDULE_CAP_MS`),被钳则显示 cap 提示;不调 `onSchedule`、**不关行**,并把
  非受控 datetime-local 的 value 用 ref 回写同步(程序化赋值不触发 onChange,无回环)。
- **保存才提交**:`saveSchedule` 逻辑不变(读 input DOM 值 → 过期复验 → `onSchedule` → 关行);
  input 与 pendingAt 双向联动:手动改 datetime = `onChange` 覆盖暂存并清 cap/过期提示。
- **累计 chip**:设定行内预设按钮之后渲染 `queue-schedule-pending`(⏱ 剩余时长 + 目标时刻,
  复用 `formatRemaining`/`formatClock`,react-tooltip 说明累加语义);cap 提示为独立 span
  `queue-schedule-cap`(amber 警示色,区别于红色 `queue-schedule-error`)。
- **秒级 ticker 扩展**:原 `hasPending`(队列里有未来项)才起 1s interval;现在「设定行开着且有暂存未来值」
  也起,chip 实时倒计时。无暂存且无 pending 时仍零定时器开销(§5.3 Less is More)。
- i18n:新增 `queue.schedulePending` / `schedulePendingTip` / `scheduleCap`,改写 `schedulePresetTip`
  (zh/en 成对,`locales.test.ts` key 奇偶校验过)。
- CSS:`.queue-schedule-pending`(mono amber,同 pending badge 家系)+ `.queue-schedule-cap`;
  ≤768px 断点把两者并入既有 `.queue-schedule-error { flex-basis:100% }` 独行换行规则。

## 改了哪些文件
- `frontend/src/components/QueuePanel.tsx`:`pendingAt`/`scheduleCapped` state、`startSchedule` seed、
  累加式 `presetSchedule`(24h 钳制 + ref 回写 input)、input `onChange` 双向联动、chip + cap 渲染、
  ticker 扩展。
- `frontend/src/index.css`:`.queue-schedule-pending` / `.queue-schedule-cap` + 移动端换行。
- `frontend/src/i18n/locales/zh.json` / `en.json`:上述 4 条 key。
- `frontend/src/components/QueuePanel.schedule.mount.test.tsx`:旧「预设=立即提交+关行」测试改写为
  #130 语义,新增 3 个测试(累加+保存提交 / seed 叠加 / 24h 钳制)。

## 验证
- `bun test src/components/QueuePanel src/i18n`:24 测试全过(含重写/新增)。
- `bun run test` 全量:270 pass / 5 fail——**5 个 fail 均为 pre-existing**(NewSessionModal.mount 期望缺
  `mcpServerIDs: []`,系 Go 侧模型后加字段、测试未跟;stash 干净 HEAD 复跑同样 5 fail,与本改动无关)。
  另:worktree 缺 `frontend/bindings`(生成产物不入库),先 `wails3 generate bindings` 补齐才可跑全量。
- `bun run build`(tsc + vite 生产构建):过(chunk 体积警告为既有)。
- Go 门禁 `go build ./...` + `go vet ./...`:过(本任务零 Go 改动,bindings 重新生成不改 Go 源)。
- 三端(§4.7/§5.6):改动为纯前端组件/CSS/i18n,三端同一 React 树。桌面 GUI(>768px)仅在定时
  编辑行内新增 chip/cap 元素(交互触发才出现),布局未动;远程浏览器走同一 binding/event 通道,
  无 `isRemoteClient()` 分支触及;PWA ≤768px 仅扩展既有换行规则(chip/cap 独行),断点内条件生效、
  >768px 样式不变。后端能力零改动,无需重验。**未做真机/浏览器手动冒烟**(mount 测试 + 构建为实证),
  chip 的 react-tooltip 与 header-clock/move 按钮同机制(既有三端通路)。

## 下一步
- 顺带发现的 pre-existing:NewSessionModal.mount 5 个测试需补 `mcpServerIDs` 期望(另任务处理)。
