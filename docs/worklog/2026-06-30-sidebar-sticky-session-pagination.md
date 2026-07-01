# 2026-06-30 侧栏项目头吸顶冻结 + session 列表分片渲染

## 起因

用户提两个侧栏体验需求:

1. **项目栏滚动时自动冻结**:展开一个 session 很多的大项目往下滚时,项目头(项目名 / caret / 新对话按钮)跟着滚走,丢失「我在哪个项目里」的上下文。
2. **对话历史默认 25 + 加载更多**:侧栏每个项目的 session 列表此前是 `ListSessions` 拉全量 + `map` 全渲染,单项目几百个 session 时 DOM 节点爆炸。期望默认 25 个、「加载更多」每次 +25。

## 设计 / 改法

两个都**不引库**——现成的成熟方案就够(AGENTS.md §5.3 / §4.6)。

### 1. 项目头吸顶:纯 CSS `position: sticky`

- `.project-item` 加 `position: sticky; top: 0; z-index: 2;`,背景换实色 `--sidebar-solid`。
- 它的滚动祖先是 `.project-list`(`overflow-y: auto`),粘附容器是 `.project-item-wrap` →
  每个项目头只在自己 wrap 范围内吸顶,下一个项目头上行时把它自然顶走(macOS 设置 / Finder 分组吸顶同款,原生能力,比 react-sticky 之类库更成熟更轻)。
- hover/active 原来用半透明 `background`,吸顶时 session 行会穿帮。改成 `inset 0 0 0 9999px` 的 box-shadow 叠在实色底上 ——
  底不透明(session 不穿帮)+ tint 叠加(颜色不变),content / `::before` 活跃竖条仍在阴影之上可见。

### 2. session 列表分片渲染:客户端 slice(不动后端)

- **不碰后端**:本地 SQLite `ListSessions` 查询本来就快,瓶颈是 DOM 节点数,不是查询。KISS:数据流不变,只在前端控制渲染数量。
- Sidebar 加 `SESSION_PAGE = 25`(模块常量)+ `sessionLimit: Record<string, number>` state(按项目隔离)。
- 每个项目渲染时 `projSessions.slice(0, sessLimit)`,底部 `hiddenCount > 0` 时显示「加载更多（还有 N 个）」,点击用 `prev[p.id]` 函数式更新(避免连点 stale closure 不递增)。
- `projRunning / projUnread / barCls` 仍用全量 `projSessions`(跨全部 session 探测活跃/未读),只有渲染用切片。

## 改了哪些文件

- `frontend/src/index.css`:`.project-item` sticky + 实色底 + hover/active 改 inset 阴影;新增 `.session-more-btn` 样式。
- `frontend/src/components/Sidebar.tsx`:`SESSION_PAGE` 常量 + `sessionLimit` state + `visibleSessions/hiddenCount` 切片 + 「加载更多」按钮(`data-testid=load-more-sessions-<pid>`)。

## 修复(同日):吸顶缝隙 + 滚动抖动

用户反馈两个细节问题,用浏览器还原创局精确测量确认根因后修。

### 1. 吸顶缝隙 → 悬浮感

- **现象**:项目条吸顶后与顶部有缝隙,像悬浮在对话列表上。
- **实测**:构造还原布局(滚动容器 + sticky 项目头 + padding-top),JS 量 sticky 元素吸顶后距容器顶的像素:
  - `padding-top:6`(原)→ 吸顶 gap **6px**(sticky 停在 content edge,padding 露出)。
  - `padding-top:0`(修)→ 吸顶 gap **0px**(贴顶)。
  - 铁证:缝隙 = padding-top,sticky 不覆盖 padding-top 而是停在它下方。
- **修法**:`.project-list` padding `6px 8px 12px` → `0 8px 12px`(去 top);顶部留白改用 `.project-item-wrap:first-child { padding-top:6px }`(首个 wrap 的 padding 在滚动时滚走,不影响后面项目吸顶贴顶;首个项目本就在顶部、不会吸顶)。

### 2. 滚动抖动(几像素上下)

- **根因**:WebKit 上 `position: sticky` 叠在 `.sidebar` 的 `backdrop-filter: blur(...)` 里滚动,合成层冲突导致亚像素抖动(经典 WebKit bug)。
- **修法**:`.project-item` 加 `transform: translateZ(0)` 提升独立合成层,隔离 backdrop 重绘。实测确认 transform 不改变 sticky 定位(gap 仍 0)。
- 注:抖动是 WebKit 时序问题,Chromium headless 复现不了,translateZ 是该 bug 的社区标准修法,待 `wails3 dev`(WebKit)实看。

### 改了哪些文件(修复)

- `frontend/src/index.css`:`.project-list` 去 padding-top;新增 `.project-item-wrap:first-child` 顶部留白;`.project-item` 加 `transform: translateZ(0)`。

## 验证

- `bunx tsc --noEmit` 通过。
- 分页逻辑纯 JS 复算:73 个 session → 初始 25/48 → 连点两次(stale-free)正确累积到 73 封顶、hidden 归零、按钮消失 → 另一项目独立 25/48 不串。
- 缝隙:浏览器还原布局精确测量,6px→0px。
- 抖动:WebKit 特有,Chromium 无法复现,靠 translateZ 经验修复,待 WebKit 实看。

## 注:并行改动

本次期间 `Sidebar.tsx` 被并行加了「会话搜索」功能(`searchProj`/`SearchSessionContent`/`toggleSearch`/`matchSession` 等),并把我的「加载更多」按钮条件补成 `!searching && hiddenCount>0`(搜索态不分页、不显示加载更多,显示「无匹配」提示)。与我的分页/吸顶改动无冲突,typecheck 通过。

## 下一步

- 抖动修复效果待 `wails3 dev`(WebKit)实看;若仍抖,再给 `.project-list` 滚动容器加 `isolation: isolate` / `will-change`。
- 若未来单项目 session 上千、全量查询也成瓶颈,再上后端 `ListSessionsPage`(offset/limit,复用 `LoadMessagesPage` 的 limit+1 取 hasMore 套路)。当前客户端切片足够。

## 二次修复（同日）：抖动根因——去掉 backdrop-filter

`transform: translateZ(0)` 没根治 WebKit 抖动(用户反馈仍有明显上下 shift)。web_search 调研确认:

- WebKit 上 `position: sticky` 与祖先 `backdrop-filter` 的合成层在滚动时竞态,是已知顽固问题,**无纯 CSS 完美共存方案**;translateZ/will-change 只提升 sticky 自己的层,挡不住 backdrop-filter 层的重绘干扰。
- 更关键:`.sidebar` 的大面积 `backdrop-filter: blur(40px)` 本就**违反 AGENTS.md §4.6**(禁止大面积 backdrop-filter 重绘 / 跨平台一致性——vibrancy 是 macOS 特有,Win WebView2 / Linux WebKitGTK 表现不一致)。

**最 solid 的方案 = 消除根因**:去掉 `.sidebar` 的 backdrop-filter,sidebar 改实色 `--sidebar-solid`;sticky 的 translateZ 升级为 `will-change: transform`(更现代,预先提层)。一石三鸟:抖动根因消除 + 回归 §4.6 合规 + 跨平台视觉一致。

### 改了哪些文件(二次修复)
- `frontend/src/index.css`:`.sidebar` 去 backdrop-filter 两行 + 背景改 `--sidebar-solid`;`.project-item` `transform: translateZ(0)` → `will-change: transform`。

### 验证(二次修复)
- `bunx tsc --noEmit` 通过。
- 浏览器还原布局(无 backdrop-filter + 实色 + will-change + pad0)实测:sticky 吸顶 gap=0(贴顶),布局正确。
- 抖动根因(backdrop-filter)已去除 → WebKit 上不再有合成层冲突源;最终观感(实色 sidebar)待 `wails3 dev` 实看。
