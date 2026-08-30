# 2026-08-30 编辑器选区引用/复制拼来源尾注(#168)

## 起因

#168:编辑器(CodeViewer 查看态)里选中代码后「引用到对话」,进 composer 的只有裸文本,
对话里看不到这段话出自哪个文件哪几行——尤其配合 worktree 并行 session,脱离源头的引用
基本不可追溯。Task 拍板规格 D1-D8:在 EditorPane 的 run 闭包内给选区文本拼
`— <file.path>:<行号>` 尾注(App 逐行 `> ` 前缀机制让尾注自然成为 blockquote 块内末行),
首期仅编辑器入口,App/Composer/SelectionToolbar/ChatView 零改动。

## 改法(frontend/src/components/EditorPane.tsx,单文件核心)

- **D4/D5 行号自查**:模块级 `selectionLineRange()` 从 `window.getSelection()` 的
  anchorNode/focusNode 各自 `closest("[data-line]")` 取行号(CodeViewer 行元素自
  Task #15088 起就带 `data-line`,**本次 CodeViewer.tsx 零改动**);anchor 行 N、
  focus 行 M,N>M 交换(拖拽方向与引用范围无关)。任一端点解析不到行元素
  (空态/异常/选在语言角标等非行区)→ 返回 null → 无尾注,行为同现状,不报错。
- **D1/D2 尾注**:`withSourceFootnote(text, path)` 单行拼 `\n— path:N`、跨行拼
  `\n— path:N-M`(N≤M 升序);path 用 `file.path` 原样相对路径;尾注刻意不做 i18n
  (机读锚点,非 UI 文案)。在 run 执行时读活动选区——SelectionToolbar 先 run 后
  `removeAllRanges` 已实证选区此时存活。
- **D6 Copy 动作**:编辑器选区工具栏原有仅 Quote,本次对齐 ChatView 形态补
  `copy` 动作(`copyTextQuiet`,testId `editor-selection-copy`,复用既有 i18n 键
  `common.copy`/`selectionToolbar.copyTip`,**零新增翻译键**),与 Quote 共用同一
  `withSourceFootnote` 行号代码路径。
- **闭包稳定性**:沿既有 `onQuoteRef` 模式新增 `filePathRef`——EditorPane 跨文件
  tab 切换不重挂,`selectionActions` useMemo 依赖仍只有 `[t]`,file.path 经 ref 在
  run 时取最新,不会串到上一个文件的路径。
- **D7 天然排除**:edit 态是 textarea(SelectionToolbar 对 input/textarea/contenteditable
  直接不弹);二进制/图片无文本选区,均无需实现。
- **D3 边界**:ChatView 选区工具栏(ChatView:245)与工具卡内选中未触碰;不碰
  @mention/chip 体系;RawPayloadDisclosure/复制契约无关面未动。

## 改了哪些文件

- `frontend/src/components/EditorPane.tsx` —— `selectionLineRange`/`withSourceFootnote`
  模块级助手 + `filePathRef` + 选区工具栏补 Copy 动作、Quote/Copy run 拼尾注;注释英文(§3.7)。
- `frontend/src/components/EditorPane.quote.mount.test.tsx`(新增)—— 4 条 mount 测试:
  单行尾注 `path:N`、跨行反向拖拽归一为升序 `path:N-M`、Copy 输出带同源尾注、
  选区锚点在语言角标(无 data-line 祖先)时退化为纯文本无尾注不报错。
- `docs/worklog/2026-08-30-editor-quote-source-168.md` —— 本条。

## 怎么验证的

- **单测(真流程驱动)**:新测试装真实 DOM 选区 → 手动派发 `selectionchange`
  (SelectionToolbar 的 compute 消费)→ flush rAF → 点真实工具栏按钮,断言
  onQuoteToComposer / copyTextQuiet 收到的完整 payload;唯一 shim 是
  `Range.prototype.getBoundingClientRect`(happy-dom 无布局引擎,零 rect 会触发
  工具栏零尺寸守卫,与 QueuePanel.list-budget.mount.test 同配方)。4/4 绿。
- **回归**:既有 EditorPane.edit.mount.test 5/5 绿;全量 `bun test --isolate`
  **490 pass / 0 fail**(基线 486 + 新增 4)。
- **门禁**:`bunx tsc` 零错误;`npm run build`(tsc + vite build)过(chunk 体积警告为既有)。
- **三端说明(§4.7)**:本次改动是选区时读 DOM 属性 + 纯字符串拼接,**零 CSS/布局/
  断点/组件结构变化**(红线「桌面/移动渲染零差异」由构造保证);三端共享同一 React
  前端,引用/复制产出文本逐字节一致;远程浏览器/PWA 的 `isRemoteClient` 守卫分支、
  WS 事件流均未触及,clipboard 走既有 `copyTextQuiet` 三通道(远程端不写桌面剪贴板
  的语义原样保留)。未起真机 GUI 冒烟(任务验收门即 D8 单测+tsc,已全绿)。

## 决策 / 备注

- **补 Copy 动作而非改工具栏整体复制按钮**:D6「编辑器选区 Copy 动作」+ D8「Copy 输出
  带源」要求选区级复制带尾注;编辑器工具栏既有的整体复制按钮(全文,无选区语义)不动。
- **尾注格式硬编码 em-dash `—`**:D2 明写不做 i18n;与 D1 公式逐字一致,
  App.quoteToComposer 的逐行 `> ` 前缀(未改)使其成为 blockquote 末行。
- 踩坑记录:happy-dom 的 Selection 手动派发 `selectionchange` + element 边界
  `setBaseAndExtent` 可完整驱动工具栏流程,已沉淀为新测试配方。

## 下一步

- 无(任务即终:不派 review、不 push、不关 issue)。
- 后续可选(未拍板不做):聊天选区工具栏(ChatView)同样拼来源尾注——需给消息体
  定位锚点,属 D3 显式排除范围。
