# 2026-08-09 · Review #24211 SelectionToolbar + ChatView Copy/Quote + EditorPane 引用 + quoteToComposer 接线

## 起因
Task #24217(前端 reviewer):对 #24211(a511103)做端到端验收。改动 8 文件:
新增可复用 `SelectionToolbar`(选区浮动工具条:scope ref + actions[],viewport fixed 定位、
scroll/Esc/折叠收起、mousedown preventDefault 保选区);ChatView 挂 Copy/Quote(scoped 到
.chat-body);EditorPane 挂 Quote(scoped 到新增 `.editor-pane-content` 包裹);App 新增
`quoteToComposer`(blockquote 拼接 + 切回 chat tab + bump `composerFocusSignal`);Composer 新增
`focusSignal` prop(rAF 展开 + 聚焦 textarea 末尾);i18n selectionToolbar.* + CSS。

## 验收方法(对照反模式清单)
逐条从**定义点**出发追到**消费点**,确认全链路真实消费(不是「字段加了没人用」):

| 新增字段 | 定义点 | 消费点(逐跳) | 结论 |
|---|---|---|---|
| `onQuoteToComposer` (ChatView prop) | `ChatView.tsx:88` | `onQuoteRef`(L209-210)→ quote action `run` 调 `onQuoteRef.current?.(text)`(L227)→ App `quoteToComposer`(L1946 绑定) | ✓ 全链路 |
| `focusSignal` (ChatView prop) | `ChatView.tsx:91` | 透传给 Composer(L788) | ✓ |
| `focusSignal` (Composer prop) | `Composer.tsx:48` | useEffect(L211-221):setCollapsed(false)+ rAF focus + 光标置末 + autoGrow | ✓ |
| `composerFocusSignal` (App state) | `App.tsx:980` | quoteToComposer 内 `setComposerFocusSignal((n)=>n+1)`(L995)→ ChatView `focusSignal={composerFocusSignal}`(L1947) | ✓ 读写闭环 |
| `onQuoteToComposer` (EditorPane prop) | `EditorPane.tsx:46` | `onQuoteRef`(L58-59)→ quote action `run`(L68)→ App 绑定(L1970) | ✓ 全链路 |
| `quoteToComposer` (App callback) | `App.tsx:981` useCallback | 绑定到 ChatView(L1946)+ EditorPane(L1970) | ✓ 两处真实消费 |

**无类型补丁反模式**:每个新字段从定义点到最终消费点逐跳可追,无悬挂。

## 行为正确性复核
- **SelectionToolbar 选区判定**:`isCollapsed`/空 trim/`!scopeEl.contains(el)`/form-field(`input|textarea|
  contenteditable`)排除 → setSel(null);非零 rect 才定位。逻辑周密,不会在 composer/header/search-input
  误弹。✓
- **保选区点击**:按钮 `onMouseDown={e.preventDefault()}` → 选区不在 mousedown 折叠 → onClick 正常 fire →
  `run(a)` 消费文本 → `removeAllRanges()` 干净收起(selectionchange 驱动 dismiss)。富文本编辑器选区工具条
  标准做法(Slate/Lexical 同款)。✓
- **定位**:初始 inline `left/top:-9999` 防 (0,0) 闪烁;`useLayoutEffect` 同步(commit 后 paint 前)读
  offsetWidth/Height → clamp 视口 + 上方放不下翻下方。无闪烁。✓
- **dismiss 三路**:selectionchange(折叠即隐)/ scroll(capture,覆盖任意嵌套滚动容器)/ Esc。✓
- **`.editor-pane-content` 包裹**:新增 `flex:1; min-height:0; flex-direction:column` 包裹 error/loading/
  img/CodeViewer —— 与原先它们作为 `.editor-pane` 直接子元素等价(`.preview-img-scroll`/`.cv` 的 `flex:1`
  仍正确解析),且把 `.editor-toolbar`/`.editor-search-overlay` 排除在 scope 外。✓
- **quoteToComposer blockquote**:每行前缀 `> `;草稿非空 `\n\n` 分段;`text.trim()` 空则 no-op。Markdown
  blockquote 语义正确。✓
- **Composer.focusSignal rAF 时序**:setCollapsed(false)(折叠态 textarea 未挂载、ref null)→ rAF 等下一帧
  (chat tab display:none→visible + 折叠展开都已 commit)→ focus + 光标末尾 + autoGrow。时序注释清晰、
  正确处理「隐藏 textarea focus 是 no-op」。✓
- **useCallback/useMemo 稳定性**:`quoteToComposer` deps `[]`(全用 ref + 稳定 setter,正确);selectionActions
  deps `[t]`(t 稳定,onQuoteRef 是 ref,Copy/Quote/copyText 模块级)+ eslint-disable 说明,actions 数组
  每次 selectionchange 重渲不重建。✓

## 纪律对齐
- §4.2 data-testid:toolbar `selection-toolbar` + 按钮 `selection-copy`/`selection-quote`/`editor-selection-quote`。✓
- §4.5 react-tooltip:每按钮 `data-tooltip-id="md-tip"` + content;无原生 title。✓
- §3.7 英文注释:新增注释全英文。✓
- §4.4 不裸露结构化格式:tooltip/aria-label 全人话。✓
- i18n en/zh 同步:`locales.test.ts` 2 pass(selectionToolbar.label/copyTip/quote/quoteTip/quoteToChat/
  quoteToChatTip 两边 leaf key 一致;Copy 复用 `common.copy`)。✓

## 类型 / 构建
- `wails3 generate bindings`(worktree 缺,先补齐)→ `bun run build`(tsc + vite build)**通过**,本次改动 0
  类型错误。`Quote` icon 来自 lucide-react(已验证 `quote.mjs` 存在 + d.ts 导出 `Quote`)。

## 回归测试
- `bun test`:全量 152 pass / 31 fail —— **与改动前 baseline 完全一致**(worklog 已 stash 验证);31 fail
  全是 pre-existing 跨文件 mock 污染(McpChip 的 `ChatService.GetSessionMcpServers` 等 undefined)。
- 隔离运行关键链路:
  - `ChatView.virtual.mount.test.tsx`:11 pass / 0 fail。
  - `Composer.mount.test.tsx` + `Composer.usage.mount.test.tsx`:26 pass / 0 fail。
  - `i18n/locales.test.ts`:2 pass / 0 fail。
- 本次**未新增 SelectionToolbar 单测**:组件由浏览器 Selection API 驱动(`getSelection`/`selectionchange`/
  range `getBoundingClientRect`),happy-dom(本仓测试运行时)对这些支持残缺/不可靠,硬写会成 flaky 测试
  反成维护负担(违背 §5.3「测试要锚定真实不变量」精神)。集成点(ChatView/EditorPane/Composer mount)已绿,
  data-testid 就位便于将来真机集成测。判定:不补单测,可接受。

## 结论
**APPROVE #24211。** 全链路真实消费、无类型补丁反模式;选区工具条生命周期(selection 监听 + rAF 合批 +
三路 dismiss + mousedown 保选区)正确;定位 clamp + 翻下方无闪烁;blockquote 拼接 + focusSignal rAF 时序
正确;纪律对齐(data-testid / react-tooltip / 英文注释 / i18n 同步);build 过、隔离测试 0 回归。

## 下一步 / OUT OF SCOPE
- 桌面 app 实测:macOS WebKit + Win WebView2 抽检 fixed 定位 / fadeIn / focus ring / 选区跨越虚拟化行边界。
- DiffPane 当前未接 `onQuoteToComposer`(diff 里选中文字无法引用到对话)—— 不在本任务范围,留作后续。
- EditorPane 选区工具条只有 Quote 没有 Copy(全文件复制由工具栏按钮承担、选区复制走原生 ⌘C)—— worklog
  已记录为有意设计,可接受;若后续用户反馈困惑再补 Copy。
