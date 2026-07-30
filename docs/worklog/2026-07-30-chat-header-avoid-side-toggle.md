# ChatView header 右端图标避让右侧固定折叠按钮

日期:2026-07-30
类型:fix(纯前端 UI/交互)

## 起因

上一轮把面板折叠/展开按钮统一为**固定锚点 toggle**(`.panel-toggle.right` 钉在 `top:13px; right:8px`,常驻不随面板开合移动,见 `2026-07-30-pin-panel-collapse-toggle.md`)后,产生新的重叠:右侧面板折叠 → ChatView 撑满窗口右边 → chat-header 右端的状态徽标 / Terminal 图标被这个固定 toggle 按钮**压住**。

用户期望:折叠后这些图标之间不应重叠;具体方案是「折叠时 chat-header 右边距自动变大,展开时自动变小」,且在 header 处加说明解释为什么留这么大空隙。

## 根因

- `.panel-toggle.right` 是 `position: fixed`,钉在窗口右上角,**无论面板开合都在那个坐标**。
- 面板展开时,SidePanel 占据窗口右边一整列,其顶栏(`.side-tabs`)与 chat-header **不重叠**(header 在面板左边),所以默认 chat-header 右内边距 `16px` 没问题。
- 面板折叠时,ChatView 的 main 区域向右延伸到窗口边缘,chat-header 右端的图标正好落在 `.panel-toggle.right` 的固定坐标下方 → 重叠。
- 原先 chat-header 没有任何「右面板折叠」相关的样式分支(只有左侧 sidebar 折叠的 `data-sidebar-collapsed` 分支)。

## 改法

按用户方案:折叠态自动加大右边距避让,展开态收窄。复用已有的 app 根 `data-*` 属性驱动 CSS 的模式(与 `data-sidebar-collapsed` 一致)。

- **App.tsx**:`<Group className="app">` 新增 `data-side-collapsed={rightCollapsed ? "true" : "false"}`(原已有 `data-sidebar-collapsed`)。`rightCollapsed` 状态早已存在(`useState(isPopout)` + `syncCollapsed`),无需新逻辑,只是把它暴露给 CSS。
- **index.css**:新增规则
  ```css
  .app[data-side-collapsed="true"] .chat-header { padding-right: 40px; }
  ```
  并附注释解释:40px = 按钮 26px 宽 + 两侧间距,折叠态避让固定 toggle;展开态面板顶栏不与 header 重叠(面板在 header 右边),维持默认 `16px`,开合都和谐。

说明文本(用户要求「在 header 加说明解释为什么留大空隙」)直接写进 CSS 注释——这是纯布局避让,无语义,不需在 UI 上对用户显示任何文字说明;注释面向后续维护者解释为什么有这条规则。

## 改了哪些文件

- `frontend/src/App.tsx`:app 根 `<Group>` 加 `data-side-collapsed` 属性(1 行)。
- `frontend/src/index.css`:新增 `.app[data-side-collapsed="true"] .chat-header { padding-right: 40px; }` + 解释注释。

## 验证

- `frontend`: `tsc --noEmit` 通过(exit 0)。
- `frontend`: `bun run test` → **147 pass / 0 fail**。
- 后端未改。

## 下一步 / 备注

- 视觉验证(桌面 app 折叠/展开右面板)需 `wails3 dev` 肉眼确认;逻辑已被类型 + 单测覆盖。
- popout 窗口默认 `rightCollapsed=true`(右侧面板默认收起),此规则同样适用——popout 的 chat-header 右端也会避让(但 popout 无 `.panel-toggle.right`,只有 `on-top-toggle` 在更下方 `top:48px`,不与 header 重叠;多留的 40px 右内边距在 popout 下略浪费但无害,保持规则统一不特判)。
