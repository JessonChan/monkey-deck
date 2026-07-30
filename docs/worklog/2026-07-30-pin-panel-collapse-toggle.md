# 修面板折叠/展开按钮位置割裂

日期:2026-07-30
类型:fix(纯前端 UI/交互一致性)

## 起因

右侧面板(SidePanel)的折叠按钮在展开态位于面板头部右端(`.side-tabs` flex 流 `margin-left: auto`),折叠后整块 Panel 被 `react-resizable-panels` 隐藏(`collapsedSize={0}`),取而代之的是 App 层条件渲染的 `.panel-rail.right`(14px fixed 细条贴窗口右边)。两个按钮位置差距巨大(展开在面板头部右端 ≈ 窗口右 20% 处;折叠贴窗口最右 14px),用户每次折叠/展开都要重新定位。左侧侧栏同理。独立窗口与主体窗口均复现。

## 根因

- 展开态按钮:在面板/侧栏 **内部** 的 flex 流里,跟随容器宽度;
- 折叠态按钮:App 层 **独立** 的 `position: fixed` 细条,与面板布局无关联。
- 两套按钮 DOM 层级 + 定位方式完全不同 → 开合时坐标跳变。

## 改法

收敛成 **单一固定锚点 toggle**:`position: fixed`,无论开合都钉在同一坐标,只换图标方向(`PanelRightClose ↔ PanelRightOpen` / `PanelLeftClose ↔ PanelLeftOpen`),点击根据当前 `*Collapsed` 状态调 `collapse*/expand*`。

- **右侧**:`.panel-toggle.right` 钉在 `top:13px; right:8px`(原展开态按钮 ≈ 同一处,因右面板是窗口最右元素)。
- **左侧**:`.panel-toggle.left` 钉在 `top:58px; left:8px`(让开 macOS 红绿灯,从标题栏下方开始)。popout 窗口无侧栏,左 toggle 不渲染。
- **popout 置顶 toggle**(`on-top-toggle`)与右 toggle 同处右上,纵向错开(置顶 `top:48px`)避免重叠。

## 改了哪些文件

- `frontend/src/App.tsx`
  - import 增加 `PanelLeftClose` / `PanelRightClose`。
  - 删除原「两条件渲染 rail 按钮(left/right)」,换成两块**常驻** `.panel-toggle`(图标随 `*Collapsed` 切换)。
  - 移除传给 `<Sidebar>` / `<SidePanel>` 的 `onCollapse={...}`(折叠入口统一到固定 toggle)。
  - popout 置顶 toggle 的 className 从 `panel-rail on-top-toggle` 改为 `on-top-toggle`(解耦,因 `.panel-rail` 已删)。
- `frontend/src/components/SidePanel.tsx`
  - 删除 `.side-tabs` 里的折叠按钮 + `onCollapse` prop + 未用的 `PanelRightClose` import。
- `frontend/src/components/Sidebar.tsx`
  - 删除 sidebar-header 里的折叠按钮 + `onCollapse` prop + 未用的 `PanelLeftClose` import。
- `frontend/src/index.css`
  - 删除 `.panel-rail` / `.panel-rail.left` / `.panel-rail.right` 规则。
  - 新增 `.panel-toggle` / `.panel-toggle.right` / `.panel-toggle.left`(固定锚点 + hover)。
  - 删除 `.side-collapse-btn { margin-left: auto; }`(已不用)。
  - `on-top-toggle` 调 `top: 48px`(原 14px,与右 toggle 错开)。

## 验证

- `wails3 generate bindings` 重新生成 Go→TS 绑定。
- `frontend`: `tsc --noEmit` 通过(exit 0)。
- `frontend`: `bun run test` → **147 pass / 0 fail**(含 i18n key 一致性检查)。
- `go build ./internal/...` 通过(本次未碰后端)。
- 旧的 `.panel-rail` / `collapse-sidebar` testid 无测试引用,无需改测试。

## 下一步 / 备注

- 视觉验证(桌面 app + popout)需 `wails3 dev` 跑起来肉眼确认;纯布局改动,逻辑已被类型 + 单测覆盖。
- 左 toggle 钉在窗口左下(让红绿灯)而非侧栏头部右端——这是红绿灯不可让的代价;用户本次只点名右侧,右侧是「完全等价原展开位」,左侧是「稳定但让红绿灯」的折中。若左侧也要求严格等价原位,需另议(红绿灯区域不可放交互元素)。
