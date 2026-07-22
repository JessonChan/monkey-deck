# 2026-07-23 feat:拖拽重排 —— QueuePanel drag-drop 重排 + reorderQueue 重写队列(Task #22135)

## 起因
Task #22135:给 QueuePanel 加「拖拽调整顺序」能力。队列是前端 FIFO 缓冲,`drainSession` 按数组顺序
逐条发;此前顺序固定(只能 revoke/编辑/定时/立即发送单条,不能整体换序)。用户需要拖拽换序 →
`queueBySession` 数组重排 → `drainSession` 按新顺序发。

## 设计要点(关键决策)
- **选 HTML5 drag-drop 而非 dnd-kit**:任务给出二选一(`HTML5 drag-drop 或 dnd-kit`)。虽然 `package.json`
  已预置 `@dnd-kit/*`,但 HTML5 原生 drag 更轻量(零运行时开销、纯 DOM,契合 §4.6「轻量、低开销」+
  §5.3 KISS / Less is More)。dnd-kit 留作更复杂拖拽场景(跨容器、键盘排序)的储备,本任务无需引入。
- **拖拽源 = 手柄(grip),落点 = 整行**:`.queue-grip`(GripVertical 图标)`draggable`,行容器作 drop
  target(`onDragOver`/`onDrop`)。避免「整行 draggable」与按钮点击/文本选择的干扰,且给一个明确的
  可抓取 affordance。grip 仅在 read 态出现(编辑/定时态不拖,以免与 textarea/input 冲突)。
- **重排契约用 ID 不用 index**:`onReorder(activeId, overId)`。parent(`reorderQueue`)按 id 找 from/to,
  `splice(from,1)` 后 `splice(to,0,moved)`(把 active 移到 over 位置)。index 在并发渲染间脆弱,
  ID 是稳定主键(§5.3 找不变量)。
- **重排后串联 drain + arm**:reorder 改了数组顺序 → 首条可能变(drainSession 取首条已到点的发)、
  定时器最早 scheduledAt 不变但保险重 arm;若 idle 且新首条已到点 → 主动 drain(与 scheduleQueueItem
  同模式,防静死)。
- **tooltip 走 react-tooltip(md-tip)**:grip 用 `data-tooltip-id="md-tip"`(§4.5 硬约束:统一 react-tooltip,
  禁用原生 title)。注:QueuePanel 既有按钮仍用原生 `title=`(历史债,本任务不顺带改,保持局部一致)。

## 改法
### 1. QueuePanel(`QueuePanel.tsx`)
- Props 加 `onReorder: (activeId, overId) => void`。
- 新增 state:`dragId`(正被拖的 id)、`overId`(悬停目标 id)。
- 每个行容器:`data-id={item.id}`;`onDragOver`(dragId 存在才 preventDefault + 标 overId)、`onDragLeave`
  (清自身 overId)、`onDrop`(preventDefault + 若 `dragId !== item.id` 调 `onReorder`,清 dragId/overId)。
- read 态最左加 `<span className="queue-grip" draggable>`(GripVertical + md-tip tooltip):
  `onDragStart` 设 dragId + 试写 dataTransfer(try/catch 兜测试环境无 dataTransfer)、`onDragEnd` 清状态。
- `drag-over` class:`overId === item.id` 时追加,行高亮提示落点。

### 2. 透传(`ChatView.tsx`)
- Props 加 `onReorderQueue: (activeId, overId) => void` → `QueuePanel.onReorder`。

### 3. App.tsx
- 新增 `reorderQueue(activeId, overId)`(useCallback):按 id 找 from/to → splice 重排 → 写 ref + state →
  `armScheduleTimer(sid)` → idle(`statusRef !== "prompting"`)则 `void drainSession(sid)`。deps `[armScheduleTimer, drainSession]`。
- ChatView 透传 `onReorderQueue={reorderQueue}`。

### 4. i18n / CSS
- `en.json`/`zh.json`:`queue.reorderTip`(zh「拖拽以调整发送顺序」/ en「Drag to reorder send order」)。
- `index.css`:`.queue-grip`(grab 光标 + hover 高亮)、`.queue-grip:active`(grabbing)、`.queue-item.drag-over`
  (琥珀边 + hover 底 + inset 阴影,落点高亮)。

### 5. 测试
- 新增 `QueuePanel.reorder.mount.test.tsx`(2 条):
  1. dragstart(q2 grip)→ dragover(q3 行)→ 断言行带 `drag-over` class → drop → 断言 `onReorder("q2","q3")` 且 class 清除。
  2. 同行 dragstart→dragover→drop → `onReorder` 不被调(no-op)。
  happy-dom 无完整 DragEvent;handler 只需原生事件分发 + state,故用 `window.Event("dragstart"/"dragover"/"drop")`
  合成;dataTransfer 访问在组件里 try/catch 兜底。
- 既有 fixture 补 `onReorder` / `onReorderQueue` 占位:QueuePanel.edit.mount(3 处)、QueuePanel.schedule.mount(3 处)、
  ChatView.virtual.mount、TurnDivider.duration.mount。

## 改了哪些文件
- `frontend/src/components/QueuePanel.tsx`:drag-drop UI + onReorder。
- `frontend/src/components/ChatView.tsx`:Props + 透传。
- `frontend/src/App.tsx`:`reorderQueue` + 透传。
- `frontend/src/i18n/locales/{en,zh}.json`:`queue.reorderTip`。
- `frontend/src/index.css`:`.queue-grip` / `.queue-item.drag-over`。
- `frontend/src/components/QueuePanel.reorder.mount.test.tsx`(新):drag-reorder mount 测试。
- 既有测试 fixture 补 prop。

## 验证
- `bun test src/components/QueuePanel`:**8 pass / 0 fail**(新增 reorder 2 条;既有 edit/schedule 6 条全过)。
- `bun test`(全量):**92 pass / 7 fail**。7 fail 全在 `HarnessUpdateAwareness.mount.test.tsx` —— 经
  `git stash -u` 对照确认是**先于本任务的跨文件测试隔离问题**(clean main 同样 7 fail),与本任务无关。
  本任务新增 2 条全过、既有相关 fixture 全过,零新增失败。
- `tsc --noEmit`:非 bindings 错误 **0**。(`bindings/` 缺失是 Wails3 生成物未入库的既有环境问题,
  clean main 同样 24 条 binding 错误,本任务未引入新 TS 错误。)
- 本任务纯前端,无 Go 改动。

## 下一步
- 桌面 app 实测:队列多条 → 拖 grip 换序 → 行高亮 → 松手后 drainSession 按新顺序续发;
  多平台抽检(WebKit/WebView2 drag 图像、grab 光标、drag-over 高亮一致性)。
- 后续可选:grip 加键盘可达(`tab` 聚焦 + 方向键移动)以满足 a11y;若需跨 session 拖拽再评估 dnd-kit。
