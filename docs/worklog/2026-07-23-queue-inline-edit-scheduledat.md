# 2026-07-23 feat:QueueItem.scheduledAt + 队列消息 inline 编辑(Task #22132)

## 起因
Task #22132:(1) `QueueItem` 扩展 `scheduledAt` 字段(入队时刻);(2) `QueuePanel` 支持队列消息
**inline 编辑**——点编辑按钮把该条文本变 textarea,保存写回队列(保留 mentions/images/scheduledAt
原位),取消还原。区别于既有「撤回编辑」(revoke:移出队列 + 回填输入框)。

## 改法(KISS,纯前端)

### 1. 类型扩展(`types.ts`)
`QueueItem` 加 `scheduledAt: number`(入队时刻 `Date.now()`)。QueuePanel 据此显示「排队于 HH:mm」。

### 2. 入队 + 编辑回调(`App.tsx`)
- `sendMessage` 入队时 `scheduledAt: Date.now()`。
- 新增 `editQueueItem(id, text)`:原地替换该条 `text`,`mentions/images/scheduledAt` 保留(展开 `...q[idx], text`),
  不离开队列。经 `onEditQueue` 透传 ChatView → QueuePanel。

### 3. 透传(`ChatView.tsx`)
Props 加 `onEditQueue: (id, text) => void`,传给 `QueuePanel.onEdit`。

### 4. QueuePanel inline 编辑(`QueuePanel.tsx`)
- 每条加「编辑」按钮(Pencil,`queue.edit`),与既有「立即发送」(Zap)/「撤回」(Trash2,改为统一图标)
  并列。revoke 原本末条用 Pencil,现统一 Trash2(编辑独占 Pencil,语义更清)。
- 点编辑 → `editingId = item.id`,该条渲染 `<textarea defaultValue={item.text} ref>` + 保存(Check)/
  取消(X)。**textarea 用非受控 + ref**:保存时直接读 `editRef.current.value.trim()` 写回。
  - 选非受控理由:(a) 保存读 DOM 当前值,杜绝「state 未同步读旧值」stale 风险;(b) 规避 React 19 表单
    事件插件在 happy-dom 测试环境下 `onChange` 不触发的边角(见「验证」),真实 webview 无此问题。
  - 键盘:Enter(无 Shift)保存、Esc 取消(AGENTS §4.2 弹窗可 Esc 关闭约束延伸)。
  - 空/纯空白 trim 后不保存(防止清空)。
- `scheduledAt > 0` 时显示「排队于 HH:mm」(本地 `formatClock`)。

### 5. i18n(`en.json` / `zh.json`)
`queue.edit / editTip / save / saveTip / cancel / cancelTip / scheduled`(带 `{{time}}`)。

### 6. CSS(`index.css`)
`.queue-btn.edit/.save/.cancel` hover 配色;`.queue-scheduled`(mono 小字灰);`.queue-item-edit` 行内布局;
`.queue-edit-input`(透明底、focus 高亮 border)。

## 改了哪些文件
- `frontend/src/types.ts`:`QueueItem.scheduledAt`。
- `frontend/src/App.tsx`:入队带 `scheduledAt`;新增 `editQueueItem`;透传 `onEditQueue`。
- `frontend/src/components/ChatView.tsx`:Props + 透传。
- `frontend/src/components/QueuePanel.tsx`:inline 编辑 + scheduledAt 显示 + 非受控 ref。
- `frontend/src/i18n/locales/{en,zh}.json`:新 key。
- `frontend/src/index.css`:新样式。
- `frontend/src/components/QueuePanel.edit.mount.test.tsx`(新):inline 编辑 mount 测试。
- 既有 mount 测试 fixture 补 `onEditQueue: () => {}`(ChatView.virtual / TurnDivider.duration)。

## 验证
- `wails3 generate bindings` 补齐后 `npx tsc --noEmit`:**clean**。
- `bun test`:**100 pass / 0 fail**(新增 QueuePanel.edit.mount 3 条:编辑→保存写回、取消不触发 onEdit、
  Enter 保存 / Esc 取消)。
- `go build ./...` / `go vet ./...`:clean(本任务纯前端,无 Go 改动;`frontend/dist` embed 提示为既有,
  非错误)。
- **happy-dom + React 19 坑(实测)**:`<textarea value={v} onChange>` 受控组件在该测试环境下,即使用
  原型 setter 设值 + 派发 `input`/`InputEvent`,`onChange` 回调**不触发**(React 19 表单事件插件在 happy-dom
  的事件代理下不识别;click/keydown 等普通事件正常)。这是测试环境特性,**真实 Wails webview(WKWebView/
  WebView2/Chromium)无此问题**。改用非受控 + ref 读值后,测试用原型 setter 设值即可被 `saveEdit` 读到,
  测试与生产一致。后续如再遇「happy-dom 里 React 受控 input 不响应」,同法处理。

## 下一步
- 桌面 app 实测:排队中点编辑→改文本→保存,队列该条文本更新且保留排队顺序;取消还原;Enter/Esc 快捷键。
- 多平台抽检(macOS WebKit 优先):编辑态 textarea 高度 / 焦点 / 暗色主题渲染。
