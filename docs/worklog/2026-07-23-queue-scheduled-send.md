# 2026-07-23 feat:定时发送 —— QueuePanel 时间选择 + drainSession 到点才发(Task #22134)

## 起因
Task #22134:给队列消息加「定时发送」能力 —— QueuePanel 加时间选择器(给队列消息设
`scheduledAt`),`drainSession`(原 `drainQueue` per-session 化后的名字)「到点才发」:未到点的
条目跳过、不阻塞后续无定时项(扫描找第一条已到点的发)。

## 设计要点(关键决策)
- **复用 `scheduledAt` 字段语义升级**:#22132 引入 `scheduledAt` 表「入队时刻」(恒 `Date.now()`)。
  本任务把它升级为「定时发送时刻」:默认仍是入队时刻(`Date.now()`,即「立即可发」);
  用户可经 QueuePanel 选一个未来时刻 → 该条变定时。语义自洽:`scheduledAt <= now` = 已到点(可发),
  `scheduledAt > now` = 未来(跳过)。无需新增字段,符合 §5.3 Less is More。
- **drainSession 改「找第一条已到点」(破纯 FIFO)**:`q.findIndex(it => it.scheduledAt <= now)`
  取首条已到点的 dequeue + 发;全队未到点则不发。这破了严格 FIFO——但任务明确要求「未到点跳过、不阻塞
  后续无定时项」,即位置 1 的定时项不能挡住位置 2 的即时项。已到点项之间仍保 FIFO(findIndex 取首个)。
- **定时器兜底(必须,否则功能假死)**:idle 状态下定时消息没有 idle 事件会触发 drainSession,会静死。
  故 `armScheduleTimer(sid)`:按队列里最早的未来 `scheduledAt` 设一个一次性 `setTimeout`,到点再
  `drainSessionRef.current(sid)`。用 ref 解 `drainSession ↔ armScheduleTimer` 的循环依赖。
  幂等(先清旧再设),`delay` 封顶 `2_147_000_000`(< 2^31,setTimeout 上限)。触发/重 arm 点:
  drainSession 全未到点分支、drainSession `finally`、enqueueMessage(prompting 时)、scheduleQueueItem、
  removeSession(清)。

## 改法
### 1. 类型(`types.ts`)
`QueueItem.scheduledAt` 注释升级为「定时发送时刻;默认入队时刻 = 立即可发」。字段类型不变(`number`)。

### 2. QueuePanel(`QueuePanel.tsx`)
- Props 加 `onSchedule: (id, scheduledAt) => void`。
- 每条加「定时」按钮(Clock 图标,`queue.schedule`),点开 inline `<input type="datetime-local">`
  (非受控 defaultValue + ref,沿用 #22132 编辑态同模式,规避 React 19 + happy-dom 受控坑)。
  保存(Check)→ 读 `scheduleRef.value`(`YYYY-MM-DDTHH:mm`)经 `fromLocalInput` → epoch ms → `onSchedule`。
  「立即」(`queue.clearSchedule`)→ `onSchedule(id, Date.now())`(清定时)。默认值:`pending` 用该条
  scheduledAt,否则「现在 +1 分钟」(建议)。
- 显示:`scheduledAt > now`(未来)显 `queue.scheduledSend`(⏰ HH:mm,琥珀色,`data-testid=queue-scheduled-send`);
  否则退回 `queue.scheduled`(排队于 HH:mm)。
- 新增本地工具:`toLocalInput` / `defaultLocalInput` / `fromLocalInput`(datetime-local 本地时区互转)。

### 3. 透传(`ChatView.tsx`)
Props 加 `onScheduleQueue: (id, scheduledAt) => void` → `QueuePanel.onSchedule`。

### 4. App.tsx
- 新增 ref:`scheduledTimersRef`(per-session setTimeout 句柄)、`drainSessionRef`(解循环依赖)。
- `drainSession`:取首条 `scheduledAt <= now` 的(findIndex);全未到点 → `armScheduleTimer` + return;
  发送 finally 里再 `armScheduleTimer`(剩余可能仍定时)。dequeue 由 `q.slice(1)` 改 `q.filter((_,i)=>i!==dueIdx)`。
- 新增 `armScheduleTimer(sid)`(useCallback):清旧 → 找最早未来 scheduledAt → setTimeout 到点 drain;
  无未来项则清掉。
- 新增 `scheduleQueueItem(id, scheduledAt)`:原地改 scheduledAt → arm → 若已到点且非 prompting 则主动 drain。
- `enqueueMessage`:prompting 时 arm(定时项兜底);依赖加 `armScheduleTimer`。
- `removeSession`:清该 session 定时器。
- 透传 `onScheduleQueue={scheduleQueueItem}` 给 ChatView。

### 5. i18n / CSS
- `en.json`/`zh.json`:`queue.schedule / scheduleTip / clearSchedule / clearScheduleTip / scheduledSend / scheduledSendTip`。
- `index.css`:`.queue-btn.schedule/.clear` hover、`.queue-scheduled.future`(琥珀 + 时钟)、`.queue-schedule-input`。

### 6. 测试
- 新增 `QueuePanel.schedule.mount.test.tsx`(3 条):未来 scheduledAt 显 scheduled-send badge(非 queued)、
  定时→选→保存经 `onSchedule` 回 epoch ms、`clearSchedule` 回传已到点时间戳。input 用原型 setter 设值
  (沿用 #22132 受控坑规避)。
- 既有 fixture 补 `onScheduleQueue` / `onSchedule` 占位:ChatView.virtual / TurnDivider.duration /
  QueuePanel.edit.mount(3 处)。

## 改了哪些文件
- `frontend/src/types.ts`:`scheduledAt` 注释。
- `frontend/src/components/QueuePanel.tsx`:定时选择 UI + 工具函数。
- `frontend/src/components/ChatView.tsx`:Props + 透传。
- `frontend/src/App.tsx`:drainSession 到点才发 + armScheduleTimer + scheduleQueueItem + enqueue/removeSession 串联。
- `frontend/src/i18n/locales/{en,zh}.json`:6 个新 key。
- `frontend/src/index.css`:schedule 样式。
- `frontend/src/components/QueuePanel.schedule.mount.test.tsx`(新):定时选择 mount 测试。
- 既有测试 fixture 补 prop。

## 验证
- `wails3 generate bindings`:补齐(本 worktree 缺 `frontend/bindings`)。
- `tsc --noEmit`:**clean**。
- `bun test`:**105 pass / 0 fail**(新增 schedule mount 3 条;既有 102 条全过,含补 prop 的 3 个 fixture)。
- `go build ./...` / `go vet ./...`:clean(本任务纯前端,无 Go 改动;`frontend/dist` embed 提示为既有,非错误)。

## 下一步
- 桌面 app 实测:队列里给某条设未来时间 → 标签变 ⏰、drainSession 跳过它发后续无定时项;到点自动发;
  「立即」清除定时立即发;多平台抽检 datetime-local 控件渲染(Win WebView2 / macOS WebKit 一致性)。
- 边界:session idle 下设定时 → 定时器到点发(本轮已含);prompting 下设定时 → 本轮结束 idle 事件 +
  定时器双保险。
