# 2026-07-23 Review #22130 队列 4 项端到端验收结论(PASS)

## 起因

Task #22136(Review):验收 Task #22130「队列 4 项端到端验收」聚合的 4 个子任务实现:

- **#22131 主动入队列**:Composer「入队列」按钮(并列发送)+ ⌘⇧↩ + App `enqueueMessage` 路径。
- **#22132/#22133 inline 编辑**:QueueItem 加 `scheduledAt`;QueuePanel inline 编辑(改队列里某条文本,原地保留)。
- **#22134 定时发送**:QueuePanel 时间选择 + `drainSession`「到点才发」(未到点跳过、不阻塞后续无定时项)+ 定时器兜底。
- **#22135 拖拽重排**:QueuePanel HTML5 drag-drop + `reorderQueue` 重写队列顺序。
- **外加 interrupt/revoke 不回归**。

验收范围:`4065efc`(#22131 基点)→ `2ba1258`(#22135 docs)共 13 commit(8 feat/test + 5 docs),
源码改动集中在 `App.tsx`(+134)/`QueuePanel.tsx`(+262)/`Composer.tsx`(+22)/`ChatView.tsx`(+8)/
`types.ts`(+4) + 3 个新 mount 测试 + i18n/CSS。

重点不是「能否编译」,而是「代码是否真的实现了所需行为变更」——拒收「改了签名/类型但函数体行为
不变、构建绿但 bug 仍在」的常见失败模式。

## 验收方法

1. 通读 5 条 worklog(composer-active-enqueue / queue-inline-edit-scheduledat /
   restore-22132 / queue-scheduled-send / queue-drag-reorder)+ 全部 commit diff。
2. 逐处核对控制流(不只看 diff 表面)——见下「关键判断」。
3. 跑 gate(§8 自检):worktree 初始 `node_modules` 空 + bindings 未生成 → `bun install` +
   `wails3 generate bindings`(2 Services / 67 Methods / 10 Models)补齐后跑 build/test/tsc/go。

## 关键判断(行为是否真的改变)

### 1. 主动入队列(#22131)✓
- `Composer.tsx`:`submit(finalText?, mode="send")` 末尾按 mode 选 `(mode==="enqueue" ? onEnqueue : onSend)`
  ——参数非空壳,真改路由;`enqueue-btn`(ListPlus)+ `⌘⇧↩`(`Enter+shiftKey+(metaKey||ctrlKey)`)
  都调 `submit(undefined,"enqueue")`;原 `Enter`(`!e.shiftKey` 守卫)与之互不误触。✓
- `App.tsx enqueueMessage`(780-805):**始终入队**(与 send 的 idle/prompting 二分支无关)、清
  `userStoppedBySessionRef`、idle(`statusRef!=="prompting"`)→ `void drainSession`(防静死)、
  prompting → `armScheduleTimer`(定时兜底)。idle 入队不静死这条核心差异真落地。✓

### 2. inline 编辑(#22132/#22133)✓
- `editQueueItem`(823-832):按 id findIndex → `next[idx] = {...q[idx], text}`,**mentions/images/
  scheduledAt 原地保留**(展开 `...q[idx]`),不离开队列。✓
- `QueuePanel` edit 态:textarea 非受控(`defaultValue` + ref),保存读 `editRef.current.value.trim()`,
  空/纯空白不保存;Enter(无 Shift)保存、Esc 取消。✓
- **rebase 调和已落地**:两条入队路径都带 `scheduledAt: Date.now()`——`sendMessage` prompting 分支
  (App.tsx:712)、`enqueueMessage`(App.tsx:789)。`QueueItem` 不会出现「有的有 scheduledAt、有的没有」
  的不一致(#22133 的核心调和点)。✓

### 3. 定时发送(#22134)✓
- `drainSession`(285-294):`dueIdx = q.findIndex(it => it.scheduledAt <= now)` —— 取**首条已到点**的
  dequeue + 发(`q.filter((_,i)=>i!==dueIdx)` 只移除该条、保序);全队未到点 → 不发 + arm。**破了
  纯 FIFO 但符合「未到点跳过、不阻塞后续无定时项」的明确要求**。✓
- `armScheduleTimer`(316-330):幂等(先 clearTimeout 旧)、找最早未来 scheduledAt、`setTimeout` 到点
  drain、`delay` 封顶 `2_147_000_000`(<2^31);无未来项则清掉。用 `drainSessionRef` 解循环依赖。✓
- `scheduleQueueItem`(840-855):改 scheduledAt → arm → 若 `at<=now && !prompting` 主动 drain。
  触发点完整:drainSession 全未到点分支 + finally、enqueueMessage(prompting)、scheduleQueueItem、
  removeSession(清,1167-1168)。定时消息不会静死。✓
- `scheduledAt` 语义自洽:默认入队时刻(`Date.now()`)= 立即可发(`<=now`);用户选未来时刻才跳过。
  无新增字段,§5.3 Less is More。✓

### 4. 拖拽重排(#22135)✓
- `QueuePanel`:grip(GripVertical,`draggable`)+ 整行 drop target(`onDragOver`/`onDrop`);契约用
  **ID**(`onReorder(activeId, overId)`)非 index(§5.3 找不变量);`dragId!==item.id` 守卫 + 父层
  `activeId===overId` 早返回 = 同行 no-op。`dataTransfer` 访问 try/catch 兜测试环境。✓
- `reorderQueue`(858-872):按 id 找 from/to → `splice(from,1)` 后 `splice(to,0,moved)` → arm →
  idle 则 drain(新首条已到点立即发)。重排后 drainSession 按新数组顺序续发,真改了发送顺序。✓

### 5. interrupt/revoke 不回归 ✓
- `interruptQueue`(754-773)、`revokeQueue`(808-820)**函数体未被本变更集改动**(diff 仅在注释 / JSX
  wiring `onInterruptQueue=`/`onRevokeQueue=` 处引用它们)。两者纯按 id 操作、不读 `scheduledAt`,
  新增字段不影响其行为。✓
- revoke 按钮图标从「末条 Pencil / 其余 Trash2」统一为 Trash2 —— 但编辑独占了新 Pencil 按钮(`queue-edit`),
  是有意的语义拆分(revoke=移出队列回填、edit=原地改),非回归。✓

### 6. 重复写历史检查(防双写)
- `sendMessage` 与 `enqueueMessage` 在按发送/入队键时各写一次 `historyBySession`(去重:与最后一条相同不重复);
  `drainSession` 续发只调 `ChatService.SendMessage`(App.tsx:300)、**不写 historyBySession** ——
  排队消息不会因「入队记一次 + 续发又记一次」而重复。✓

## 规约合规

- §5.3(找不变量 / 尊重数据源):reorder 契约用稳定 ID 非 index;scheduled 复用既有 `scheduledAt`
  字段语义升级而非新增字段;drainSession 按主键(id)操作。
- §1.6(现实面 = SessionUpdate 流):auto-continue / 定时续发数据源仍是 `chat:status` 事件 + 前端定时器,
  未自抓 agent 输出。
- §4.2(测试友好):全部新增交互元素带 `data-testid`(queue-edit / queue-edit-input / queue-schedule /
  queue-schedule-input / queue-scheduled-send / queue-grip / enqueue-btn …);Esc 关闭编辑/定时态。
- §4.5(react-tooltip):grip 用 `data-tooltip-id="md-tip"`(drag-reorder worklog 已注明既有按钮的
  原生 title 历史债未顺带改,保持局部一致 —— 可接受的存量债,非本次引入)。
- §0.3 / §6.2:5 条功能 worklog + 本 review;commit 原子(feat/test/docs 分离),message 说清改了什么+为什么。

## 验证(gate 全绿)

- `bun install` + `wails3 generate bindings` 补齐环境后:
- `bun run build`:成功(仅既有 chunk-size > 500kB 警告,非错误)。
- `bun test`(全量):**107 pass / 0 fail** / 6267 expect() calls。
  - 含新增 8 条:Composer enqueue 2 + QueuePanel edit 3 + schedule 3 + reorder 2。
  - 注:drag-reorder worklog 曾记「7 fail 在 HarnessUpdateAwareness(clean main 同样)」属先于本任务的
    跨文件测试隔离问题,当前 main 已 **107/0 全绿**(该 7 fail 已不存在, favorable,非本变更集引入)。
- `npx tsc --noEmit`:**clean**(exit 0)。
- `go build ./...`:clean(exit 0,仅 macOS 链接器版本告警,无关;本变更集纯前端无 Go 改动)。

## 次要观察(不阻塞)

- **无实机验证**:4 项均涉及 Wails3 事件流 + 多消息排队续发 / 定时器 / 拖拽,需 `wails3 dev` 实跑
  (idle 入队立刻发、prompting 入队等本轮续发、定时到点自动发、拖拽换序后续发按新序、datetime-local
  跨平台渲染)。各功能 worklog 均已记此 OPEN,与前序 Review 同基线(可接受)。
- **测试断言质量**:3 个新 mount 测试断言的是**真实 DOM 交互 + 回调具体参数**(edit 写回 `onEdit("q1","hello edited")`、
  schedule 回传 `scheduledAt>Date.now()`、reorder 回传 `{activeId:"q2",overId:"q3"}`、同行 drop no-op),
  非空壳恒真测试。✓
- 桌面 app 拖拽多平台抽检(WebKit/WebView2 drag 图像、grab 光标、drag-over 高亮一致性)留待实机。

## 结论

**PASS**。4 项功能的核心 DoD 真实落地(非签名/类型摆设):
- 主动入队列:idle/prompting 都入队 + idle 主动 drain 防静死;
- inline 编辑:原地改文本保留 scheduledAt/mentions/images,Enter/Esc 快捷键;
- 定时发送:`findIndex(due)` 跳过未到点不阻塞后续 + 定时器兜底防静死;
- 拖拽重排:ID 契约 + splice 重排 + 按新序续发;
- interrupt/revoke 函数体未动、不读新字段,**无回归**;
- 排队消息无 history 双写。
build / tsc / test(107/0)/ go build 全绿,规约合规。无需改动即可合入。

## 改了哪些文件

- `docs/worklog/2026-07-23-review-queue-4-features-e2e.md`(本文件)。

## 验证

- `bun install` + `wails3 generate bindings` 补齐环境后:
- `bun run build`:成功(仅 chunk 体积告警)。
- `bun test`:107 pass / 0 fail。
- `npx tsc --noEmit`:clean。
- `go build ./...`:clean。
- 逐处核对 4 功能 diff + interrupt/revoke 未回归 + history 无双写(见上)。
