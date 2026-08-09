# 2026-08-09 文本选择浮动工具条(SelectionToolbar)+ 引用到对话

## 起因
Task #24211:用户在对话区 / 编辑器里选中文字时,浮一条小工具条提供快捷操作:
- **ChatView**:Copy(复制选中文字)+ Quote(把选中文字作为 markdown 引用插入输入框)。
- **EditorPane**:Quote(把选中文字引用到对话输入框 —— 「引用到对话」)。
- App 接线 `onQuoteToComposer`:把引用文本格式化为 blockquote 追加进当前 session 草稿,
  切回 chat tab(从编辑器引用时 chat 是隐藏的),并聚焦输入框、光标落末尾。

## 设计 / 根因
- **SelectionToolbar 是可复用组件**,props:`scope`(ref,选区必须落在此元素内)+ `actions`(
  `SelectionAction[]`,每个含 labelKey/tipKey/Icon/testId/run)。用 `document.selectionchange` +
  rAF 合批监测选区;选区在 scope 外 / 空 / 在 input/textarea/contenteditable 内 → 不弹。
  viewport 坐标定位(`position: fixed`),`useLayoutEffect` 里 clamp 视口 + 上方放不下翻下方。
- **mousedown preventDefault**:按钮 `onMouseDown={e.preventDefault()}` 保住选区(否则浏览器
  在 mousedown 就折叠选区 → selectionchange → 工具条先于 onClick 消失)。action 跑完再
  `removeAllRanges()` 干净收起。这是富文本编辑器选区工具条的标准做法(Slate/Lexical 同款)。
- **关闭时机**:选区折叠(selectionchange 驱动,点别处即折叠)/ 滚动(capture,任意滚动容器)/ Esc。
- **ChatView scope = scrollRef(.chat-body)**:把 composer(header 外,在 .chat-footer)、
  header 排除在外,选 composer 文本不误弹。actions 用 `useMemo` 稳定引用,quote 回调用 ref
  透传(避免每次 render 重建 actions 数组)。
- **EditorPane scope = contentRef(内容区包裹 div)**:排除 .editor-toolbar(路径 span 可选中文本)、
  search input。新增 `.editor-pane-content`(flex:1 + flex-column)包裹 error/loading/img/CodeViewer,
  让 CodeViewer 的 `.cv`(flex:1)继续正确填充。EditorPane 只挂 Quote(Copy 已由其工具栏的全文件
  复制按钮承担;选区复制走 ChatView 那条路不在 editor 重复,符合任务标题「EditorPane 挂引用到对话」)。
- **App.quoteToComposer**:每行前缀 `> ` 拼 blockquote;草稿非空则 `\n\n` 分段。同时
  `setActiveFileTabBySession(sid,"chat")`(编辑器→chat 显形)+ bump `composerFocusSignal`。
- **Composer.focusSignal**:新增可选 prop,变化时展开长文本折叠态 + rAF 聚焦 textarea、光标置末尾、
  autoGrow。rAF 等 chat tab 从 display:none 切到可见后再聚焦(聚焦隐藏 textarea 是 no-op)。
  先 setCollapsed(false) 再 rAF:折叠态下 textarea 没挂载、ref 为 null,必须先展开再聚焦。
- **i18n**:新增 `selectionToolbar.{label,copyTip,quote,quoteTip,quoteToChat,quoteToChatTip}`,
  Copy 按钮复用既有 `common.copy`。zh/en 同步。
- **CSS**:`.selection-toolbar`(复用 ctx-menu 视觉语言:elev-2 卡 + 发丝边 + 柔光 + fadeIn)、
  `.selection-toolbar-btn`(hover/focus-visible);`.editor-pane-content`。

## 改了哪些文件
- `frontend/src/components/SelectionToolbar.tsx`(新增)
- `frontend/src/components/ChatView.tsx`(挂 Copy/Quote + 透传 focusSignal)
- `frontend/src/components/EditorPane.tsx`(挂 Quote + contentRef 包裹)
- `frontend/src/components/Composer.tsx`(focusSignal prop + 聚焦 effect)
- `frontend/src/App.tsx`(quoteToComposer + composerFocusSignal + 接线两处)
- `frontend/src/index.css`(.selection-toolbar* / .editor-pane-content)
- `frontend/src/i18n/locales/{zh,en}.json`(selectionToolbar 段)

## 验证
- `wails3 generate bindings`(worktree 缺,先补齐)。
- `cd frontend && bun run build`(= `tsc && vite build`)通过,无 TS / 编译错误。
- `bun test`:全量 152 pass / 31 fail —— 与改动前 baseline **完全一致**(stash 验证);
  31 个 fail 是既有的跨文件 mock 污染(McpChip 的 `ChatService.GetSessionMcpServers` 等未 mock),
  与本次无关。ChatView 虚拟化 / Composer 相关单测在隔离运行下全绿。
- 无 lint 脚本(package.json 未配)。

## 下一步
- 桌面 app 实测:对话区选中文字 → 浮 Copy/Quote;编辑器选中 → 浮 Quote;点 Quote → 草稿出现
  blockquote + 聚焦。macOS WebKit + Win WebView2 抽检(§4.6:fixed 定位 / fadeIn / focus ring)。
- 可选增强:选区跨越多个虚拟化行时的边界(当前虚拟化是 normal-flow,选区几何正确,但极端长选区
  的 getBoundingClientRect 边界可再验);Copy 反馈(当前选中即清,无 Check 闪烁,与 GitHub 选区条一致)。
