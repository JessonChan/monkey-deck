# #173 移动端抽屉遮住 chat-header + 右抽屉入口改 toggle

## 起因

issue #173:≤768px(PWA/移动端)下,左右抽屉(`#sidebar`/`#side`)与 `.drawer-scrim` 都是 `top: 0` 起步、`inset: 0` 铺满,**盖住了 0~52px 的 chat-header 行**。后果:抽屉开着时右上角的 `.side-drawer-btn`(抽屉入口按钮,就在 header 行里)被自己的抽屉/scrim 压住不可点——入口按钮把门焊死,只能靠 scrim 点按或 back 手势逃生。

## 根因

M2(#124)引入右抽屉时照搬了左抽屉的全屏几何(两者都从视口顶端起步),没有给 52px 的 header 行留位。`52` 的来源:`.chat-header { height: 52px }`(index.css:527)。

## 改法

### 1. 几何:抽屉/scrim 一律从 header 底部起步(全部在 ≤768 块内)

- `#side`、`#sidebar`:`top: 0` → `top: calc(env(safe-area-inset-top) + 52px)`;**同步删掉各自的 `padding-top: env(safe-area-inset-top)`**——top 里已含 safe-area,再叠 padding 就是双重偏移。`padding-bottom`/`padding-left`(左)/`padding-right`(右)保留。
- `.drawer-scrim`:`inset: 0` → `top: calc(env(safe-area-inset-top) + 52px); right: 0; bottom: 0; left: 0`(left/right/bottom 不变)。
- 效果:header 行(0~52px)永不被抽屉/scrim 覆盖,`.side-drawer-btn` 常驻可点。既有 z 值一律不动(抽屉 60、scrim 55、modal-overlay 65、panel-toggle 60、install-banner 50)。

### 2. 语义:右抽屉入口从单向 open 改 toggle

几何修好前 toggle 无意义(开着时按钮点不到);修好后同一按钮天然应承担开/关:

- `App.tsx`:新增 `toggleRightDrawer`(`rightDrawerOpen ? closeRightDrawer() : openRightDrawer()`),给 ChatView 传 `onToggleSideDrawer={toggleRightDrawer}` + 状态 `rightDrawerOpen`(即 `data-md-side-drawer` 的数据源)。`openRightDrawer` 本身不动(互斥另一个抽屉的语义保留)。
- `ChatView.tsx`:prop `onOpenSideDrawer` → `onToggleSideDrawer?: boolean 状态 rightDrawerOpen?: boolean`;按钮 label/tooltip 动态——开 → `t("sidebar.closePanel")`、关 → `t("app.expandSidePanel")`;图标同步翻转(开 `PanelRightClose` / 关 `PanelRightOpen`,对齐桌面 `.panel-toggle.right` 的既有模式)。不加新 i18n 键。
- 左抽屉 `panel-toggle.left` 本就是 toggle,不动。

## 改了哪些文件

- `frontend/src/index.css` —— ≤768 块内 3 处几何(`#sidebar` 3212、`#side` 3237、`.drawer-scrim` 3261)+ 注释。
- `frontend/src/App.tsx` —— `toggleRightDrawer` + 调用点传 `rightDrawerOpen`/`onToggleSideDrawer`。
- `frontend/src/components/ChatView.tsx` —— prop `onOpenSideDrawer` → `onToggleSideDrawer`,新增 `rightDrawerOpen?: boolean`;按钮 label/tooltip 动态——开 → `t("sidebar.collapse")`、关 → `t("app.expandSidePanel")`;图标同步翻转(开 `PanelRightClose` / 关 `PanelRightOpen`,对齐桌面 `.panel-toggle.right` 的既有模式)。不加新 i18n 键。
- `frontend/src/components/ChatView.sidedrawer.mount.test.tsx` —— 测试重写为 toggle 契约:关态 label=`app.expandSidePanel` 且点击触发回调;开态 label=`sidebar.collapse` 且点击仍触发回调;无 prop 不渲染按钮。

## 验证

coder 侧(自动):

1. `bunx tsc` 干净(全新 worktree 先 `wails3 generate bindings` 补 gitignore 的 bindings 产物,非本改动引入)。
2. `bun test --isolate` 全绿:**527 pass / 0 fail**(72 文件);sidedrawer 单文件 3/3。
3. `bun run build`(tsc + vite production)通过。
4. CSS 断言:`top: calc(env(safe-area-inset-top) + 52px)` 恰 3 处;≤768 块内 `padding-top: env(safe-area-inset-top)` 计数 0;`.drawer-scrim` 无 `inset: 0` 残留;`git diff` 的 index.css hunk 全部落在 3208~3261(≤768 块内,块起 3160)→ **桌面 >768 零变化**。

三端矩阵(§4.7):

- **桌面 GUI**:本次为 ≤768 定向改动;CSS hunk 局部性 + `.side-drawer-btn` 桌面仍 `display:none`(基础规则未动)保证 >768 布局/交互不变,未逐像素复拍(风险≈0,改动不触及 >768 任何选择器)。
- **远程浏览器 / PWA**:几何与 toggle 生效面正是这两端的 ≤768 布局;自动化通道已过(构建 + 全量测试)。**像素几何(抽屉顶=header 底、scrim 不盖 header、390 视口)待真机/浏览器 390 视口人工复核**——按任务约定以人工复核为准。

## 下一步

- 真机(iOS Safari / Android Chrome)或 390 视口人工复核像素几何,回写本条。
- 红线均未触碰:#124 打开链路、scrim 点按关闭、back 手势(`useBackLayer`)、modal 65 层级、install-banner(z-50)。
