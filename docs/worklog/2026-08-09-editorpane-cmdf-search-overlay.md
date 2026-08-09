# 2026-08-09 EditorPane ⌘F 搜索浮层(Task #24197)

## 起因
EditorPane 是只读代码 / 文本预览(中间列 file tab 内容)。此前没有「在当前文件里找文本」
的能力——长文件里定位一个标识符只能肉眼扫或滚动条拖。桌面代码阅读器(VSCode / 浏览器)
对 ⌘F 的肌肉记忆很强,补一个文件内查找浮层是基础体验。

## 设计
- **形态**:EditorPane 内一条横向 find bar(.editor-search-overlay),非 modal——不抢代码区
  交互,挂在 toolbar 下方、CodeViewer 上方。input + 计数 + 上/下/关 三个按钮。
- **触发**:⌘F / Ctrl+F(window keydown,preventDefault 拦掉 webview 原生 find);toolbar 上
  也有一个 Search 图标按钮兜底(鼠标用户)。仅文本文件触发,图片不分流。
- **匹配**:case-insensitive 子串扫描 `content`(split 行后逐行 indexOf)。每个匹配记录
  `(line, col)` occurrence——这是不变量(§5.3 找不变量);per-line 高亮集合与 active 行
  都从它派生,不存成独立 state 防漂移。同行多 occurrence 在行高亮上合并为一条,但 next/prev
  步进仍按 occurrence 维度。
- **去抖**:`query`(live input)与 `debouncedQuery`(实际匹配用)分离,200ms 防抖,避免大文件
  逐键全量扫描 + 全行重渲染卡顿。每次去抖落地重置 `activeIdx=0`(落到首个匹配)。
- **导航**:Enter 下一个 / Shift+Enter 上一个(modulo wrap);按钮同效。
- **Esc 关闭**:input 的 keydown 拦 Escape 关浮层。
- **reset**:切文件(`file.path` 变)时整体清掉(open/query/debouncedQuery/activeIdx)——
  上一文件的匹配对新内容无意义,不该残留。
- **CodeViewer 联动**:新增两个 props:
  - `searchMatches?: number[]`——需高亮的行号集合(1-based),CodeViewer memo 成 Set 做
    O(1) per-line 判定,加 `.cv-search-match` 淡蓝底。
  - `activeMatchLine?: number | null`——当前 active 匹配行,加 `.cv-search-active` 强蓝底 +
    左侧 accent 条,并新增一个 useLayoutEffect 滚入视野(虚拟化态像素定位、平铺态
    scrollIntoView smooth),复刻 highlightLine 的滚入逻辑但独立 keying,这样步进时每次重定位。
- **与 highlightLine 共存**:两者是正交维度(一个是文件打开时的目标行,一个是搜索命中行)。
  CSS 里 `.cv-search-*` 写在 `.cv-target` 之后,但两者用不同色相(yellow vs accent-blue),
  同行同时命中时 target 黄色读起来仍主导(背景叠加,box-shadow 各占一侧不冲突)。滚入视野
  上 highlightLine effect 先定义先跑、activeMatchLine effect 后定义后跑,文件刚打开那一刻
  若两者都有效,target 先定位、search 再覆盖,符合预期(搜索一般在打开之后才触发)。
- **i18n**:filePreview 下新增 searchTip / searchPlaceholder / searchCount(`{{n}} of {{total}}`)/
  searchNoMatch / searchPrev / searchNext / searchClose,zh/en 同步(locales.test 锁了 leaf key 对等)。

## 改了哪些文件
- `frontend/src/components/EditorPane.tsx`——搜索 state / ⌘F 监听 / 去抖 / reset / 扫描匹配 /
  导航 / 浮层 JSX / 透传 searchMatches+activeMatchLine 给 CodeViewer;toolbar 加 Search 按钮。
- `frontend/src/components/CodeViewer.tsx`——props 加 `searchMatches` / `activeMatchLine`;
  searchMatchSet memo;active match 滚入视野 useLayoutEffect;rowEl 加 `.cv-search-match` /
  `.cv-search-active` class + active match ref(平铺态用于 scrollIntoView)。
- `frontend/src/index.css`——`.editor-search-overlay` / `.editor-search-input` /
  `.editor-search-count` / `.editor-search-step` + `.cv-search-match` / `.cv-search-active`。
- `frontend/src/i18n/locales/en.json` / `zh.json`——filePreview.search* 七条 key。

## 验证
- `cd frontend && bun run build`(tsc + vite build)clean,无类型 / 编译错误。
- `bun test src/i18n/locales.test.ts` 通过(zh/en leaf key 对等不破坏)。
- `bun test` 全量:149 pass / 31 fail,与改动前(stash 后重跑)完全一致——31 个 fail 全是
  预存(mock 缺失等无关项),本次改动**零新增 fail**。
- (未写 EditorPane/CodeViewer 专项测试:项目里这两个组件原本就无测试文件,本次任务也只要求
  实现层;后续若补,可按 FileTabBar.test 的 mount 模式覆盖 ⌘F 开 / Esc 关 / 计数文案。)

## 下一步
- 可选:match 内字符级高亮(目前只到行级;字符级需把 occurrence col 透传进 CodeViewer 在
  对应行 HTML 上叠 mark——会与 highlight.js 片段渲染耦合,留作增强)。
- 可选:正则 / 大小写敏感 / 全词 切换(VVSCode 有,当前 case-insensitive 子串已够基础使用)。
- DiffPane 是同列另一个 file-tab 内容视图,目前未接搜索;若需要可把搜索逻辑抽成 hook 复用。
