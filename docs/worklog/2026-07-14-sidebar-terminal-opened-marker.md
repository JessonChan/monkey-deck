# 侧栏 session「已开终端」图标标记

## 起因
多 session 并行时,哪个 session 开着集成终端只能切过去才知道;侧栏缺一个一目了然的标记。
需求:侧栏 session 项加「已开终端」图标,开/关终端后即时更新,关闭后消失。

## 设计
- **数据源复用既有状态,零后端改动**:`termOpenBySession: Record<string, boolean>`(App.tsx)
  已是「终端面板对该 session 是否打开」的权威状态——`toggleTerminalPanel`(⌘J / 头部按钮)、
  `closeTerminalTab`(关最后一个 tab)、`onClosePanel`(收起面板)三处都走 `setTermOpenBySession`,
  覆盖了全部开/关路径。语义正好 = 「已开终端 / 关闭后消失」,无需新建字段、无需后端、无需事件。
  - 不用 `termTabsBySession.length>0`:它收起面板时仍为 true(tabs 不杀),与「关闭后消失」不符。
- **前端为主**:Sidebar 加一个可选 prop `termOpenBySession?`,App.tsx 直接透传已有 state。
- **渲染位置**:与置顶标记(`session-pin`)同格——都是「与瞬态活动状态(spinner/unread/time/perm/draft)
  正交的常驻标记」,放在 label 之后、状态簇之前;`flex-shrink:0` 不挤压状态簇。
- **图标**:复用 `SquareTerminal`(lucide-react),与 ChatView 头部终端切换按钮(`ChatView.tsx:257`)
  一致,图标语义统一。弱色 `--accent-2`(青),与置顶的 `--accent` 区分。
- **合规**:§4.5 hover tooltip(`data-tooltip-id="md-tip"`,文案 `sidebar.terminalOpenTip`);
  §4.2 `data-testid="term-open-${s.id}"`(自动化可见)。

## 实时性
无需额外接线:`termOpenBySession` 是 React state,任一开/关路径调 setter → App 重渲染 →
Sidebar 收到新 prop → marker 出现/消失。全在前端状态闭环内。

## 改了哪些文件
- `frontend/src/components/Sidebar.tsx`:lucide 导入加 `SquareTerminal`;`Props` 加
  `termOpenBySession?`;session 行置顶标记后渲染终端标记(tooltip + testid)。
- `frontend/src/App.tsx`:`<Sidebar>` 透传 `termOpenBySession={termOpenBySession}`。
- `frontend/src/i18n/locales/{zh,en}.json`:新增 `sidebar.terminalOpenTip`(已开终端 / Terminal open)。
- `frontend/src/index.css`:新增 `.session-terminal-mark` 样式(弱色常驻,同 `.session-pin` 模板)。

## 验证
- `wails3 generate bindings` 生成 bindings(本机不入库)后 `cd frontend && bun run build`
  (tsc + vite production)通过,无类型/编译错误。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿(纯前端改动,仅回归)。

## 下一步
- 手动在 wails3 dev 验证:开终端 → 侧栏对应 session 出现终端图标;切到别的 session 图标仍在
  (per-session 状态);关面板 / 关最后一个 tab → 图标消失;tooltip 文案正确。
