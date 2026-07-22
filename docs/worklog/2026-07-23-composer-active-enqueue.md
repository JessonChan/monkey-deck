# 2026-07-23 主动入队列:Composer「入队列」按钮(并列发送)+ ⌘⇧↩ 快捷键 + App enqueue 路径

## 起因
Task #22131。既有的「排队」是**隐式**的:发送按钮在 `prompting`(`sendMessage` 里 `statusRef.current === "prompting"` 分支)时才入队,idle 时直发。用户没有**显式**的「我就要把这条排队」入口 —— 想批量排队只能等一轮开始后再发。

需求:给 Composer 加一个与「发送」**并列**的「入队列」按钮 + `⌘⇧↩`(`Cmd+Shift+Enter`,跨平台兼容 `Ctrl+Shift+Enter`)快捷键,**无论 idle/prompting 都把消息压入前端队列**;App 侧提供独立的 `enqueue` 路径(不再复用 `sendMessage` 的 idle/prompting 二分支)。

## 设计(找不变量 / 尊重数据源,§5.3)
- **队列机制不变**:`queueBySession`(per-session FIFO)+ `drainSession`(由 `chat:status` 的 `idle`/`error` 事件按 `sessionId` 直驱续发)是既有不变量。本任务只加一个**始终入队**的入口,不改续发机制。
- **enqueue vs send 的本质差异在 idle 态**:
  - send(idle):直发(`SendMessage`),不经队列。
  - enqueue(任意态):先压入 `queueBySession`,再(若 idle)主动 `drainSession` 推一次队列。
- **idle 态必须主动 drain,否则队列静死**:`drainSession` 的触发器是 `chat:status` 的 `idle`/`error` **事件**(§5.3 尊重数据源)。idle 态下不会再发 idle 事件,若 enqueue 后不主动 `drainSession`,入队的消息会无限期卡在队列里(无事件触发续发)。这是 idle 入队与 idle 直发的关键实现差异。
- **主动入队 = 用户想继续**:清掉该 session 的 `userStoppedBySessionRef` 停意图(与 `interruptQueue` 一致),否则被 Stop 标记抑制、入队却不续发。

## 改法

### 1. Composer(`frontend/src/components/Composer.tsx`)
- Props 加 `onEnqueue: (text, mentions, images?) => void`(与 `onSend` 同签名)。
- `submit(finalText?, mode: "send" | "enqueue" = "send")`:末尾 `onSend(...)` → `(mode === "enqueue" ? onEnqueue : onSend)(...)`。其余收集提及/附件/清空输入逻辑复用,无重复。
- `onKeyDown`:在原 `Enter`(无修饰)发送之后,加 `Enter + shiftKey + (metaKey || ctrlKey)` → `submit(undefined, "enqueue")`。原 `Enter` 分支带 `!e.shiftKey` 守卫,⇧↩ 本就不会误触发送。
- 按钮区:在 `send-btn` 前插入 `send-btn enqueue`(`data-testid="enqueue-btn"`,`ListPlus` 图标,`disabled={disabled || empty}`,与 send 同禁用条件)。tooltip 用 `composer.enqueueTip`(含快捷键提示)。

### 2. App enqueue 路径(`frontend/src/App.tsx`)
新增 `enqueueMessage` 回调(置于 `interruptQueue` 后):
1. guard `selectedSessionId` / 空文本;`scrollToBottom`;记进输入历史(按发送键即记,含排队)。
2. 构造 `QueueItem` 压入 `queueBySessionRef` + `setQueueBySession`(始终入队,与 send 的 idle/prompting 二分支无关)。
3. `userStoppedBySessionRef.current.delete(selectedSessionId)` —— 主动入队清停意图。
4. `if (statusRef.current !== "prompting") void drainSession(selectedSessionId)` —— idle 态主动推队列,防静死。
- deps `[selectedSessionId, drainSession]`(`drainSession` 自身 `[]` 稳定)。`statusRef` 是 ref 不进 deps。

`App.tsx` 渲染 `ChatView` 处加 `onEnqueue={enqueueMessage}`。

### 3. 透传(`frontend/src/components/ChatView.tsx`)
Props 加 `onEnqueue`,`<Composer onEnqueue={props.onEnqueue} />`。

### 4. i18n(`frontend/src/i18n/locales/{en,zh}.json`)
`composer.enqueueTip`:en `"Enqueue · ⌘⇧Enter (always queues; auto-sent after current turn, or starts now if idle)"`;zh 对译。

### 5. 样式(`frontend/src/index.css`)
`.send-btn.enqueue { background: var(--amber); color: #1a1a1a; }` —— 琥珀色与 QueuePanel 队列色一致(视觉绑定「队列」),深色图标保对比;圆形与 send/stop 一致(§4.6 跨平台一致、纯 CSS)。

### 6. 测试
- `Composer.mount.test.tsx` 加一组「Composer active enqueue (Task #22131)」:
  - 点 `enqueue-btn` → `onEnqueue` 调一次、`onSend` 不调、`onChange("")` 清空。
  - textarea 上 `keydown` `Enter+shiftKey+metaKey` → `onEnqueue` 调一次、`onSend` 不调。
- 三个既有 mount 测试 stub(`Composer` / `ChatView.virtual` / `TurnDivider.duration`)补 `onEnqueue: () => {}`(新必填 prop)。

Go 零改动 —— 无需 `wails3 generate bindings`(本次为环境补齐另跑,gitignore 排除 bindings)。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| `frontend/src/components/Composer.tsx` | 加 `onEnqueue` prop;`submit` 加 `mode` 参数;`onKeyDown` 加 ⌘⇧↩;`enqueue-btn` 按钮(`ListPlus`)。 |
| `frontend/src/components/ChatView.tsx` | Props 加 `onEnqueue`,透传给 Composer。 |
| `frontend/src/App.tsx` | 新增 `enqueueMessage` 回调(始终入队 + idle 主动 drain + 清停意图);渲染处传 `onEnqueue`。 |
| `frontend/src/i18n/locales/{en,zh}.json` | `composer.enqueueTip`。 |
| `frontend/src/index.css` | `.send-btn.enqueue` 琥珀色变体。 |
| `frontend/src/components/Composer.mount.test.tsx` | enqueue 按钮 + ⌘⇧↩ 快捷键测试。 |
| `frontend/src/components/ChatView.virtual.mount.test.tsx`、`TurnDivider.duration.mount.test.tsx` | stub 补 `onEnqueue`。 |

## 验证
- `bun install` + `wails3 generate bindings`(环境补齐)后:
- `bun run build`(`tsc && vite build`)exit 0(仅 chunk 体积告警,既有无关项)。
- `bun test`:**99 pass / 0 fail**(含新增 2 条 enqueue 测试)。
- `go build ./...` + `go vet ./...` 通过(仅 macOS 链接器版本告警,无关)。
- 逻辑审查:
  - enqueue(idle)→ 入队 → `drainSession` 立即 dequeue 发送 ✓(不静死)。
  - enqueue(prompting)→ 入队 → 等本轮 `idle` 事件续发 ✓(与既有 auto-continue 自洽)。
  - 主动入队清 `userStopped` → 不会被前序 Stop 抑制 ✓。
  - `submit(mode)` 复用收集/清空逻辑,send 路径行为不变(默认 `"send"`)✓。
  - ⌘⇧↩ 与原 `Enter` 互不误触(原分支 `!e.shiftKey` 守卫)✓。

## 权衡 / OPEN
- **idle 入队时 QueuePanel 可能一瞬闪现**:enqueue 先 `setQueueBySession`(加入),紧接着 `drainSession` 再 `setQueueBySession`(dequeue)。React 批处理下通常合并不可见,极端时可能闪一帧。语义正确(确实经过了队列),非 bug;若后续体感不佳可在 idle 入队时跳过入队直接 send(但那样就与 send 同义、失去「显式入队」语义)。
- **prompting 态下 send 与 enqueue 行为同义**(都入队):send 的 `prompting` 分支本就入队。这是历史设计,本次不改动;enqueue 按钮的价值在 idle 态提供「入队」语义 + 跨态一致的显式入口。
- **未做实机验证**:涉及 Wails3 事件流 + 多消息排队续发,需 `wails3 dev` 实跑(idle 入队立刻发、prompting 入队等本轮结束续发、⌘⇧↩ 与按钮等价)。
