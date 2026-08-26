# 2026-08-26 SidePanel 移动端右侧抽屉(#side fixed 右滑镜像 + header 入口)

Task #24323 / issue #124。

## 起因

M2 移动适配(#124 系列收尾):≤768px 下右侧 SidePanel(文件 / 源代码管理)沿用了桌面
`react-resizable-panels` 的 flex 布局,而 App.tsx 在窗口 <750px 时会自动 `collapse()` 它,
且 M2 已把 `.panel-toggle.right` 在手机上 `display:none`(注释判定该面板是「桌面密度 UI」,
展开是 54px 死条)——结果移动端**完全没有**访问文件树 / SCM 的入口。镜像既有左侧 sidebar
抽屉(M2)把它做成右滑 overlay 抽屉,补上这个入口。

## 改法(全部镜像左侧抽屉既有机制,桌面零修改)

1. **`#side` fixed 右滑镜像(≤768px 断点内)**:`position: fixed; top/right/bottom: 0;
   width: min(85vw, 340px); transform: translateX(105%) → 0`(0.18s ease-out),
   z-index 60 / scrim 55 / modal 65 层级沿袭;safe-area padding(上/下/右,右缘对应左抽屉的左缘)。
   面板库的 inline flex sizing 对 fixed 元素失效(与 #sidebar 同理),collapsed 状态无关紧要,
   CSS transform 主导可见性。
2. **`rightDrawerOpen` 显式状态**(App.tsx):`openRightDrawer` / `closeRightDrawer`;
   **双抽屉互斥**(openRightDrawer 关左、开左的三个路径——rail toggle mdViewport 分支 /
   PWA shortcut switch-project——关右),保证 scrim 永远只有一层。**Scrim 单实例复用**:
   onClick 同时关两个(互斥下等价于关开着的那个);渲染不再限定 `!isPopout`——窄 popout
   窗口的右抽屉也需要 scrim 可关(左抽屉在 popout 不存在,`data-md-drawer` 恒 false,
   `>768px` 依旧 display:none,桌面渲染不变)。
3. **`useBackLayer(rightDrawerOpen, …)`**:Android 返回手势关顶层抽屉(§4.7 PWA)。
4. **header 入口(ChatView)**:`onOpenSideDrawer?: () => void` prop + `.side-drawer-btn`
   按钮(PanelRightOpen 图标,`data-testid="open-side-drawer"`,aria-label/tooltip 复用
   `app.expandSidePanel` 既有 i18n,无新 key)。**刻意不用 `.icon-btn` 类**——M2 规则
   `.chat-header-actions .icon-btn { display: none }` 会把它藏掉;base `display: none` +
   断点内 reveal(36px 触摸目标、`:active` 替代 hover),与 `.msg-share-btn` 同一模式。
   同时复位 `.app[data-side-collapsed="true"] .chat-header { padding-right: 16px }`
   (桌面 40px 避让给已隐藏的右 rail toggle,在手机让位给 header 入口按钮)。
5. **触控适配**:`#side` Panel 挂 swipe-right 关闭手势(镜像左抽屉 swipe-left:dx > 60 +
   主轴守卫,面板内纵向滚动不误触;桌面不发 touch 事件,惰性);`.side-tab` min-height 40px +
   touch-action: manipulation、`.side-panel .tree-row` / `.git-file-row` min-height 36px、
   `.side-tabs` 进 user-select:none 组。
6. **打开即收起**:SidePanel 的 `onOpenFile` / `onOpenDiff` 在 App.tsx 的包装里
   `setRightDrawerOpen(false)`(镜像「openSession 关左抽屉」:浏览结束,用户要看打开的 tab);
   桌面 no-op(状态恒 false,React bail)。

## 改了哪些文件

- `frontend/src/App.tsx`:rightDrawerOpen 状态 + 互斥 + useBackLayer + swipe 手势 +
  data-md-side-drawer + onOpenSideDrawer 接线 + 打开文件/diff 收起 + scrim 双关。
- `frontend/src/components/ChatView.tsx`:onOpenSideDrawer prop + header 入口按钮
  (+PanelRightOpen import)。
- `frontend/src/index.css`:base 1 条(`.side-drawer-btn` display:none);≤768px 块内
  #side 抽屉镜像 + scrim 双选择器 + 按钮 reveal + header padding 复位 + 触摸目标 3 条 +
  side-tab/user-select 两组扩容。
- `frontend/src/components/ChatView.sidedrawer.mount.test.tsx`(新):2 个 mount 测试。

## 验证

- 新增 mount 测试 2 pass(入口按钮渲染 + 点击触发 onOpenSideDrawer 一次;无 prop 不渲染)。
  注:与 SidePanel.mount.test.tsx **同批**跑会因 bun 单 worker 内 mock.module 先注册者胜
  而互相干扰(SidePanel 的 chatservice mock 缺 GetSessionMcpServers,McpChip 挂掉)——
  这是测试文件间的既有 mock 竞争问题,全量套件(38 files)中两者各自通过;单独跑各自通过。
- `bun run build`(tsc + vite):通过(bindings 不在 git,先 `wails3 generate bindings -ts`)。
- 全量 `bun test`:301 pass / 23 fail(37→38 files,+2 全来自新测试)——**干净 HEAD 基线
  同环境同为 23 fail / 1 error**(sttClient/voice/NewSessionModal 等,环境性预存在,
  与本任务无关;此前记录 15 fail,本次中断后 node_modules 重装出现环境差异,但
  基线与改后 fail 集完全一致)。
- `go build ./...` / `go vet ./...`:clean(本任务无 Go 改动,例行确认;仅本机
  linker 的 macOS 版本 warning,预存在)。
- 三端(§4.7/§5.6):
  - **桌面 GUI(>768px)**:所有新 CSS 全在断点块内;新增 DOM 元素 `.side-drawer-btn`
    base display:none;scrim 按钮 base display:none(仅从 `{!isPopout && …}` 解包为恒渲染,
    桌面上 display:none 与原先不渲染等价);`data-md-side-drawer` 恒 "false"。
    由构造保证渲染不变(未跑像素 diff)。
  - **远程浏览器**:同一份 CSS/组件,>768px 同桌面结论;未触及 `isRemoteClient` 分支。
  - **PWA(≤768px)**:本任务目标端;wiring 由 mount 测试钉死,断点规则声明式。
    **375px 视口冒烟实拍(抽屉滑入/scrim/滑动关闭/tab 切换)待做**,testid 已备好。
- 中断续跑说明:首次实现因会话中断丢失(worktree 被清),本次完整重做并验证。

## 下一步

- ≤768px 浏览器/真机冒烟(§5.6):抽屉滑入动画、scrim 点击、swipe-right、
  FilePanel/GitPanel 在 340px 宽度下的可用性(树缩进深度、diff 展开)。
- 若 bun mock 冲突再困扰,可把两文件 mock 统一成超集(范围外,未动)。
