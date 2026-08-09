# 2026-08-09 QueuePanel schedule-row +5/+10/+30min 预设按钮

## 起因
QueuePanel 的「定时」编辑态(queue-schedule-row)只有 datetime-local 手动选时刻 + 保存/清除。
日常最常见的需求是「几分钟后发」,手动调 datetime-local 拨到 +5min 比较繁琐。
Task #24226:加 +5/+10/+30min 预设按钮,一键定时、退编辑态。

## 改法
- 在 `QueuePanel.tsx` 加 `presetSchedule(mins)`:`onSchedule(schedulingId, Date.now() + mins*60_000)`
  然后 `setSchedulingId(null) + setScheduleError(null)` 退出编辑态(与 `clearSchedule` 同模式)。
- 在 queue-schedule-row 的 `queue-item-actions` 里,Save 按钮之前用 `SCHEDULE_PRESETS=[5,10,30]`
  map 出三个 `queue-btn preset` 按钮(复用 queue-btn 样式,新增 `.preset` 修饰色)。
- i18n:加 `queue.schedulePreset`(`+{{mins}}分` / `+{{mins}}m`)+ `queue.schedulePresetTip`(tooltip)。
- CSS:`.queue-btn.preset` 默认 text-3(弱),hover 转 accent-2(蓝)与 save 同色系,提示可点。

## 改了哪些文件
- `frontend/src/components/QueuePanel.tsx`:`presetSchedule` + `SCHEDULE_PRESETS` + 三个预设按钮。
- `frontend/src/index.css`:`.queue-btn.preset` / `.queue-btn.preset:hover`。
- `frontend/src/i18n/locales/zh.json` / `en.json`:`schedulePreset` / `schedulePresetTip`。
- `frontend/src/components/QueuePanel.schedule.mount.test.tsx`:新增 preset 测试
  (三个预设各点一次,断言 onSchedule 收到 ~now+Nmin 且 row 关闭)。

## 验证
- `bun test src/components/QueuePanel`(4 文件 15 测试全过,含新增 preset 测试)。
- tsc 仅有 pre-existing 的 bindings 缺失错误(Wails 生成产物未入库),与本改动无关——
  本改动未触及任何 bindings import。

## 下一步
无;功能点自包含完成。
