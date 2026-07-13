# 左右面板可收起/展开 toggle(对话区最大化)

## 起因
左侧栏(Sidebar 项目/session 列表)与右侧栏(SidePanel 文件/git)常挤占横向空间,
用户希望各能一键收起,让对话区(ChatView)横向铺满;收起后保留一个可点回展开的细条把手。

## 设计取舍
- 三栏布局用的是 `react-resizable-panels` v4(`Group/Panel/Separator`)。收起方案有两条:
  1. 条件渲染 Panel(卸载):会改变 Group 子结构,与 `useDefaultLayout` 的持久化布局(按 panel id 存)
     相互影响,易抖动/错位。
  2. 用 v4 自带的 `collapsible` + `collapsedSize={0}` + `panelRef` 命令式 `collapse()/expand()`:
     **面板结构恒定,只改尺寸**,布局切换最稳。
- 选 2(结构恒定 = 无抖动,符合需求「布局切换要稳定」)。收起时面板尺寸归 0(不占横向空间),
  相邻 `Separator` 条件渲染为 null(收起态无需拖拽把手)。
- 「点回展开的细条」:面板 0 宽后内容被 lib 的 inner div(`maxWidth:100%; overflow:auto`)裁掉,
  没有空间放把手 → 把手做成 Group 外的兄弟节点(`position: fixed` 贴窗口左/右边),只在 collapsed 时渲染。
- collapsed 状态用 `useState` 管,但**经 `onResize` 回调从 `panelRef.isCollapsed()` 同步**,
  以兼容「持久化布局恰好把该面板存成 0」的复载场景(此时面板挂载即 collapsed,state 必须跟上,否则把手不出现 / 图标错)。
- 命令式 collapse 非用户拖拽,`useDefaultLayout({onlySaveAfterUserInteractions:true})` 不会把它当用户操作存盘,
  故不会污染持久化布局。

## macOS 红绿灯避让
窗口用 `MacTitleBarHiddenInset`,红绿灯原生浮在 webview 之上,原靠 Sidebar 头部 `padding-left:84px` 让位。
侧栏收起后红绿灯会浮到 chat-header 左上 → 给 `.app[data-sidebar-collapsed="true"] .chat-header` 加 `padding-left:84px`。
左把手 `.panel-rail.left` 的 `top` 从 52px 开始(标题栏下方),不与红绿灯争抢顶部。

## 改了哪些文件
- `frontend/src/App.tsx`:
  - `usePanelRef` ×2 + `leftCollapsed/rightCollapsed` state;`syncCollapsed` 经 `onResize` 同步。
  - 左右 `<Panel>` 加 `collapsible collapsedSize={0} panelRef onResize`;相邻 `<Separator>` 改 `{!collapsed && ...}`。
  - Group 加 `data-sidebar-collapsed`;渲染左/右 `.panel-rail` 把手(`<PanelLeftOpen/PanelRightOpen>`)。
  - 把 `onCollapse` 透传给 `Sidebar` / `SidePanel`。
- `frontend/src/components/Sidebar.tsx`:新增 `onCollapse?` prop + 头部「收起侧栏」按钮(`PanelLeftClose`),
  头部按钮包进 `.sidebar-header-acts`。
- `frontend/src/components/SidePanel.tsx`:新增 `onCollapse?` prop + tabs 行末「收起右侧面板」按钮(`PanelRightClose`)。
- `frontend/src/index.css`:`.panel-rail(.left/.right)`、`.sidebar-header-acts`、`.side-collapse-btn`、
  红绿灯避让规则。

## 验证
- `wails3 generate bindings` 后 `cd frontend && npm run build`(tsc + vite production)通过,无类型/编译错误。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿(无 Go 改动,仅回归)。

## 下一步
- 手动在 wails3 dev 验证:收起/展开切换无抖动;左右各自独立;收起后对话区铺满;
  macOS 红绿灯不挡标题;复载持久化布局后把手图标正确。
- 可选增强:`Cmd/Ctrl+B` 切左侧栏(VS Code 肌肉记忆);把 collapsed 状态也持久化(localStorage)。
