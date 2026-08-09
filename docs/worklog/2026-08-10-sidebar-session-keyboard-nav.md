# 2026-08-10 侧栏 session 键盘导航(kbdSelectIdx + ↑↓/Tab/Enter + scrollIntoView)(#101, Task #24248)

**起因**:issue #101 要求侧栏 session 列表支持键盘导航 —— ↑↓ / Tab 移动高亮、Enter 激活、
超出视口自动滚动、组件卸载/切项目时清掉高亮态。此前 session 列表只能鼠标点。

## 设计(关键决策)

- **作用域 = 选中项目的 session 列表**:`kbdSelectIdx: number | null` 索引「当前选中项目
  的已渲染 session 列表」(与 render loop 里 per-project `list` 同源:可见分片 / 搜索过滤)。
  - 为什么是「选中项目」而非「任意展开项目」:点 session 会选中其项目(`onSelectSession` 带
    `p.id`),所以焦点在实践中始终落在选中项目的列表里 —— 与 ⌘1-9「选中项目的 sessions」模型
    一致(见 `2026-08-09-review-cmd1-9-switch-session.md`),单索引 + 单作用域最简单(§5.3 KISS)。
  - 选中项目折叠 / 列表空 → 导航键 no-op。

- **`onKeyDown` 挂在 `<aside>`**(从获得焦点的子节点冒泡上来),**不是 window 全局监听**:
  - 全局监听裸 ↑↓/Tab/Enter 太激进 —— Tab 是全局焦点遍历、Enter 是各处提交、箭头会滚屏;
    挂 aside 则只在「焦点在侧栏内」时触发,用户在 composer 打字时完全不干扰。
  - 生命周期由 React 管(卸载自动摘监听),无需手动 cleanup ——「卸载清」由「state 随组件
    卸载而丢弃」+ 两个 reset effect 共同满足(见下)。

- **启动/拦截规则(避免陷阱焦点 / 抢原生 Enter)**:
  - **↑↓ 总是启动并推进导航**(`preventDefault`):button 不消费箭头键,拦截无副作用。
  - **Tab / Shift+Tab / Enter 仅在 `kbdSelectIdx != null`(导航已启动)时才拦截**:
    未启动时放行原生行为 → 不会把焦点困在侧栏、不会在用户还没键盘导航就抢走原生 Enter。
  - 启动位置 = 当前激活 session 在列表里的 index(找不到则 ↓→0 / ↑→末尾),↑↓ 从当前位
    置步进而非跳到列表边缘。

- **Guard**(放行原生、不拦):目标元素是 `INPUT`/`TEXTAREA`/`contentEditable`(搜索框 / 重命名
  输入框自己处理键);带 meta/ctrl/alt 修饰(让 ⌘1-9 / ⌘W / ⌘J 透传);ctx 菜单 / confirm 弹窗开
  着(Esc 关它们,不导航)。

- **scrollIntoView**:`kbdActiveRef` 挂到高亮行,`useEffect([kbdSelectIdx])` 调
  `scrollIntoView({ block: "nearest" })`,箭头移出视口/分片边界时自动滚入(`nearest` 避免多余滚动)。

- **卸载清 / 失效清**:
  1. `useEffect(() => setKbdSelectIdx(null), [selProjId])` —— 切项目必清(kbdSelectIdx 只对选中
     项目有意义)。
  2. `useEffect` 依赖 `kbdList.length`,列表缩到 idx 以下时清(如搜索过滤 / session 被删)。
  3. Sidebar 卸载(如 popout 模式隐藏 Sidebar)→ state 随之丢弃,不泄漏。

- **视觉**:高亮行加 `kbd-active` class → `box-shadow: inset 0 0 0 1.5px var(--accent-2)`
  (与重命名输入框边框 / 项目选中名同色的 accent-2 内描边),与 `.active`(选中 session 背景)
  / `:hover` 叠加共存。不依赖原生 focus outline:现代引擎把 button focus outline 门控在
  `:focus-visible`(仅键盘聚焦才显),鼠标点击不显 → 高亮行只有 accent 环,无双高亮。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx`
  - 新增 `kbdSelectIdx` state + `kbdActiveRef`。
  - 新增 `kbdList`(选中项目已渲染列表,与 render loop 同源计算)+ 两个 reset effect +
    scrollIntoView effect + `onSidebarKeyDown` handler。
  - `<aside>` 加 `onKeyDown={onSidebarKeyDown}`。
  - render loop `list.map((s) =>` → `list.map((s, i) =>`,算 `kbdActive = p.id===selProjId && i===kbdSelectIdx`,
    给重命名行 / 普通行的外层 div 加 `ref`(仅高亮行)+ `kbd-active` class。
- `frontend/src/index.css`:`.session-item-row.kbd-active` inset accent 环。

## 验证(acceptance gate)

- `wails3 generate bindings`:293 packages / 2 services / 106 methods / 19 models(为 tsc 重生成,
  产物 gitignored 不入库)。
- `cd frontend && bunx tsc --noEmit`:**exit 0**(零 TS 错误)。
- `cd frontend && bun run build`:**成功**(production build 通过)。
- `cd frontend && bun run test`:196 pass / 5 fail —— 5 个 fail 全在 `NewSessionModal.mount.test.tsx`,
  与本次改动无关(该组件不 import Sidebar;fail 是本次为跑 tsc 重生成 bindings 导致的
  模型形状漂移,如 `mode:"new"` 字段,属环境性、非本次代码引入)。Sidebar/index.css 改动隔离。

## 下一步

- 桌面 app 实测:macOS WebKit 下 ↑↓/Tab 移高亮、Enter 激活、超出视口滚入、切项目清高亮、
  搜索框/重命名输入框内按键不被劫持。
- Win WebView2 抽检 ↑↓/Tab/Enter(Tab 在 Win 是主焦点键,确认拦截只在导航已启动时生效)。
- (可选)若实测发现鼠标点击后焦点环与 accent 环同时显的引擎差异,再决定是否给
  `.session-item-main` 加 `:focus-visible` 自定义样式统一。
