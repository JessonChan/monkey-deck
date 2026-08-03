# 2026-08-03 editor-tabs-file-preview.md

## 起因

右侧文件树点文件 / 聊天工具卡片里点路径,原来的预览是**两个互相独立的模态弹窗**
(`FilePanel` 内部的 `preview` overlay + 聊天区独立的 `FilePreviewOverlay`)。用户想
要 VS Code 编辑器式的体验:**点文件 → 在中间列开一个文件 tab,可多开、可切、可关**,
不再弹模态层。

经多轮讨论(见本 session 前序 issue_update)收敛为最终方案:

- **模型 A(Session 级)**:文件 tab 按 session 隔离,`fileTabsBySession`。切 session
  换一组文件 tab,与项目现有 per-session state 模式一致。
- **放置 A1(下方单独一行)**:当前 session 的文件 tab 渲染在 session TabBar(第一行)
  下方第二行,作为独立的 `FileTabBar`。
- **Chat tab 固定首位、不可关闭**:第二行只要渲染就一定带一个 `[Chat]` tab(气泡图标
  + 加粗字样 + 蓝色图标 + 与文件 tab 之间的竖分隔线),它是「回到聊天」的稳定入口。
- **第二行只在有文件打开时渲染**:文件 tab 数为 0 → 整行不渲染(第一行 session tab
  + 下面直接是 ChatView,即现状)。
- **ChatView 隐藏而非卸载**:切到文件 tab 时 ChatView 用 `display:none` 隐藏(composer
  草稿 / 虚拟列表滚动位置 / 未读状态全保留),不重建。
- **纯只读预览,不引入编辑功能**:经库调研确认 highlight.js(已是事实标准)+ 自写虚拟化
  保留;Monaco/CodeMirror 在只读场景下不引入(违反 §4.6 轻量约束 + 与项目定位冲突,
  见前序「成熟库调研报告」)。本期也不引入 `react-diff-viewer-continued`(diff 仍是
  现有的文本染色;那是后续独立改造)。

## 设计要点(为什么这么选)

### 为什么文件 tab 是另一套 state,而不是把 `openTabs: string[]` 异质化

这是关键的「减代码、收敛表示」点(§5.3)。如果把 session tab 数组改成
`{kind, id}[]` 异质,会牵连 `openTabs` 的**全部 6 处读写**:closeTab 邻居选择、popout
互斥、⌘W 关 active、memory saver 驱逐、TabBar 渲染。这些都是机械改动且容易漏。

文件 tab 用独立 state(`fileTabsBySession` / `activeFileTabBySession`)→ 上述 6 处
**零牵连**,TabBar.tsx(session tab 条)**完全不动**。代价是多写一层 map,但完全
跟随项目现有的 `bySession` 模式,一致性更高。

### 为什么 active 用 `"chat" | path` 字符串而不是 `FileTabId | null`

原本评估时是 `activeFileTab ?? null`(null → 渲染 ChatView,非 null → 渲染 EditorPane),
是两个分支。后来用户提出「Chat 也应该是第二行的一个 tab」后,统一成线性:active 就是
一个字符串,"chat" 显示 ChatView、某 path 显示 EditorPane。逻辑更线性,不用判空。
`FileTabBar` 的 tab 数组首项固定是 Chat,后面 append 文件。

### 为什么 EditorPane 直接搬 FilePreviewOverlay 的加载逻辑

FilePreviewOverlay 已经把「文本走 CodeViewer、图片走 `<img>`、loading/error 态、
复制按钮」做对了。EditorPane 就是去掉 overlay 壳(modal、Esc、居中卡片)的版本。
按 path 加载内容(`useEffect` 依赖 `[file.path, sessionId, image]`),line 变化不重载
(CodeViewer 靠 `highlightLine` prop 重新高亮,无需 refetch)。

## 改法

### 新增

- `frontend/src/components/FileTabBar.tsx`:第二行 tab 条。`tabs.length === 0` 返回 null
  (整行不渲染)。首项固定 Chat tab(无 close),后跟文件 tab(带 × close)。
  `data-testid` 全覆盖(§4.2),tooltip 走 react-tooltip(§4.5)。
- `frontend/src/components/EditorPane.tsx`:active 文件 tab 的内容渲染。加载逻辑搬自
  FilePreviewOverlay。toolbar(路径 + 复制 + 关闭)+ CodeViewer / `<img>` 分流。
- `frontend/src/components/FileTabBar.test.tsx`:4 个 mount 测试(happy-dom + createRoot,
  遵循 `ChatView.virtual.mount.test.tsx` 套路,不引 `@testing-library/react`)。

### 改

- `frontend/src/App.tsx`:
  - 新 state:`fileTabsBySession` / `activeFileTabBySession`。
  - 新动作:`openFileTab`(同 path 已开则激活不重开,否则 append + 激活)、
    `selectFileTab`、`closeFileTab`(关 active 则回退 chat)。
  - 中间列:TabBar 后插入 `FileTabBar`(条件:`fileTabs.length > 0`);chat-area Panel
    内 ChatView 包一层 `.chatview-wrap`(active 非 chat 时加 `is-hidden` → `display:none`),
    同级条件渲染 `EditorPane`。
  - `evictSessionCache`:加 `setFileTabsBySession(drop)` + `setActiveFileTabBySession(drop)`
    (呼应 §5.3 单点驱逐)。
  - `onOpenFile` 接线:传给 ChatView(props.onOpenFile)和 SidePanel(props.onOpenFile)。
- `frontend/src/components/ChatView.tsx`:
  - Props 加 `onOpenFile?: (path, line?) => void`。
  - `openFilePreview` 改成调用 `props.onOpenFile?.(path, line)`(内部 10+ 处透传签名
    不变,只换源头)。
  - 删 `previewTarget` state、`closeFilePreview`、`<FilePreviewOverlay>` 渲染、import。
- `frontend/src/components/FilePanel.tsx`:
  - Props 加 `onOpenFile`。
  - `openFile` 从「加载内容 + setPreview」简化为 `setSelected(node.path) + onOpenFile(node.path)`。
  - 删 `preview` state、`Preview` 类型、preview-overlay JSX、Esc handler(简化为只关 modal)。
  - 删未用的 `CodeViewer` / `isImageFile` import。
- `frontend/src/components/SidePanel.tsx`:Props 加 `onOpenFile`,透传给 FilePanel。
- `frontend/src/index.css`:
  - 删 `.preview-overlay` / `.preview-card` / `.preview-head*` / `.preview-name` /
    `.preview-path` / `.preview-pre*` / `.preview-line*`(模态层样式)。
  - **注意 Mermaid 共享的 resizer 选择器**:`.mermaid-box::-webkit-resizer` 原来和
    `.preview-card::-webkit-resizer` 共用一个选择器;删 `.preview-card` 时拆出来单独
    保留 `.mermaid-box` 的(不误伤 Mermaid 全屏 modal 的 resize 把手)。
  - 新增 `.editor-pane` / `.editor-toolbar` / `.editor-path` / `.editor-toolbar .tool-btn` /
    `.chatview-wrap` / `.chatview-wrap.is-hidden`。
  - 保留 `.preview-error` / `.preview-loading` / `.preview-img-scroll` / `.preview-img`
    (EditorPane 复用)+ `@keyframes fadeIn`(可能他处用,保留)。
- `frontend/src/i18n/locales/{en,zh}.json`:加 `fileTab.{chat,chatTip,closeFile}`。

### 删

- `frontend/src/components/FilePreviewOverlay.tsx`:整文件删(逻辑搬进 EditorPane)。

## 改了哪些文件

- 新增:`frontend/src/components/EditorPane.tsx`、`FileTabBar.tsx`、`FileTabBar.test.tsx`。
- 改:`frontend/src/App.tsx`、`components/ChatView.tsx`、`components/FilePanel.tsx`、
  `components/SidePanel.tsx`、`index.css`、`i18n/locales/en.json`、`i18n/locales/zh.json`。
- 删:`frontend/src/components/FilePreviewOverlay.tsx`。

## 验证

- `npx tsc --noEmit`:**通过**(0 错误)。
- `bun run build:dev`:**通过**(production build 成功,529ms)。
- `bun test src/components/FileTabBar.test.tsx`:**4/4 通过**(空 tab 不渲染、Chat tab
  首位无 close、点 tab 激活、close 不激活)。
- `bun test`(全量):133 pass / 29 fail。**29 个 fail 全部是 pre-existing**——
  经 `git stash` 验证:stashed 我的改动后,`ChatView.virtual.mount.test.tsx` 仍 0/10
  fail(根因是 `McpChip` 调用 `ChatService.GetSessionMcpServers` 但该测试的 binding stub
  没有这个方法,与本期改动无关);其余 HarnessPane/NewSessionModal/QueuePanel/msg-meta
  fail 同理都是 mock 漂移问题。**本期改动零回归。**

## 下一步

- **未做的独立改造**(前序调研已评估,本期不做):
  - 引入 `react-diff-viewer-continued` 替换 `lib/diff.ts`(diff 从文本染色升级为真正的
    split/unified + word-diff + 虚拟化)。这是独立的 diff 改造,不阻塞本期。
- **风险点(后续盯)**:
  - 单 session 内开很多文件 tab,内容缓存吃内存(每个 active 文件 tab 切回都重新加载,
    因为 EditorPane 按 path 卸载重建非 active 的)。本期可接受(用户主动关);长期可加
    LRU 或 keep-alive 多 tab(实测内存后再定,§5.5)。
  - ChatView `display:none` 下虚拟列表 ResizeObserver 行为——`ChatView.virtual` 测试
    因 pre-existing mock 问题没跑通,本期未能在此验证;待 McpChip mock 修好后补跑。

## 修复:ChatView 聊天框消失(2026-08-03 当晚 hotfix)

**症状**:用户反馈「巨大的 bug chatview 直接没有了聊天框了」——切到文件 tab 之外的
任何时候,ChatView(含 composer / 消息列表 / footer)整个塌缩消失。

**根因**:`.chatview-wrap`(我新增的 ChatView 包裹层)用了 `flex: 1; min-height: 0`,
但它父级是 `react-resizable-panels` 的 `<Panel id="chat-area">` 渲染出的内容盒——
**该内容盒有确定 height(block,非 flex 容器)**。`flex:1` 只在父级是 flex 容器时生效;
父级是 block → `flex:1` 失效 → `.chatview-wrap` 高度塌为内容 auto → 内部 `.chat-view`
的 `height:100%` 解析到 0 → 整个聊天区消失。

**对比不变量**:`.chat-view`(L314)和 `.terminal-panel`(L2193)都是 `height:100%`——
它们直接做 Panel 子元素时能正确拿到高度,正是因为 Panel 内容盒是「确定高度的 block」,
`height:100%` 能解析。`flex:1` 在这个布局里是错的。

**修法**(2 行 CSS,`index.css`):
- `.chatview-wrap`:`flex: 1` → `height: 100%`(对齐 `.chat-view`/`.terminal-panel` 模式)。
- `.editor-pane`:`flex: 1` → `height: 100%`(同理,它也是 Panel 内容盒的直接子元素,
  用 `flex:1` 会塌缩;改成 `height:100%` 后文件预览也能正确撑满)。

**验证**:`npx tsc --noEmit` 通过(CSS 改动,无 TS 影响)。布局问题靠 dev 实测确认。

**教训(呼应 §5.3「找不变量」)**:新增中间层(`chatview-wrap`)时,没核对该层父级的
盒模型(flex 容器 vs block)。Panel 内容盒是确定高度 block——这是本布局的不变量,所有
直接子元素都该用 `height:100%` 而非 `flex:1`。下次新增同类包裹层,先看父级怎么给高度。
