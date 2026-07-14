# 2026-07-14 统一设置中心面板(收敛分散设置项)

## 起因
Task #15134。此前设置项散落在侧栏头部的 4 个图标按钮里:
- 语言(zh/en)→ Globe popover
- 对话结束提示音 → Bell 开关
- 权限规则 → ShieldCheck 弹窗(PermissionSettings)
- harness 管理 → Boxes 弹窗(HarnessSettings)

入口分散、无统一导航,后续新增设置无处安放。需要统一「设置」中心面板:
齿轮入口 → 左侧分类导航 + 右侧表单,把分散项迁入对应分类,配置统一存储,
改设置即时生效,结构可扩展。

## 设计

### 分类(7 项,可扩展)
通用 / 外观 / 语言 / 对话 / 权限 / 模型与 harness / 声音。
- **通用**:应用版本(占位 + 后续扩展)。
- **外观 / 对话**:暂无设置,展示「后续将在此补充」占位(结构留位,不偷跑下阶段)。
- **语言**:zh/en 单选(迁自侧栏 Globe popover)。
- **权限**:分级权限规则(迁自 PermissionSettings 弹窗,复用全部规则 CRUD UI)。
- **模型与 harness**:harness 发现/版本/升级(迁自 HarnessSettings 弹窗)。
- **声音**:对话结束提示音开关(迁自侧栏 Bell)。
- 模型刷新(probe harness 拉最新 configOptions)是**per-session 动作**而非全局持久设置,
  留在 ChatView header(与活跃 session 绑定),不迁入设置中心。

### 统一设置 store(§5.3 KISS / §3.1 不提前实现)
- 新增 `frontend/src/lib/settingsStore.tsx`:`FrontendSettingsProvider` + `useFrontendSettings()`。
  收敛前端轻量开关(language / notifySound)为单一响应式 Context,各分类 pane 经它读写同一处。
- **持久化真相源不动**:语言 → i18next(md:lang);提示音 → localStorage(md:notify-sound)。
  store 只提供响应式 UI 状态 + 统一 setter,避免每个组件各自维护本地镜像。
  不为语言/提示音新建 SQLite 配置表(那是阶段 2 的事,提前实现违反 §3.1)。
- 后端 SQLite 持久化的设置(权限规则 / harness)不进此 store,由各 pane 直连 ChatService。
- **即时生效**:语言 i18next changeLanguage 即时重渲染;提示音 setter 写 localStorage 即时,
  App 的回合结束播音判定读 `isNotifySoundEnabled()`(每次事件 fresh 读 localStorage,无 stale closure);
  权限规则变更后端 `applyPermissionRulesToAll` 即时刷活跃 session handler;harness 即时。

### 入口收敛(移除分散快捷入口)
侧栏头部原来的 4 个按钮(Globe / ShieldCheck / Boxes / Bell)全部移除,
替换为单个齿轮(Settings)按钮 → 打开 SettingsPanel。侧栏头部仅留:收起 + 齿轮 + 添加项目。

### pane 化重构(去 modal 包裹)
- `PermissionSettings.tsx`:`export default PermissionRulesPane`(去掉 modal-overlay/card/Esc 包裹,
  只保留规则列表 + 增删改 + 恢复默认的 pane 内容)。
- `HarnessSettings.tsx`:`export default HarnessPane`(同理)。
- `SettingsPanel.tsx` 按当前分类懒挂载对应 pane(切到才挂载 + 拉数据,避免无谓请求)。
- App.tsx 移除 `permSettingsOpen` / `harnessSettingsOpen` 两个独立弹窗 state,改为单一 `settingsOpen`。

## 改了哪些文件
- 新增 `frontend/src/lib/settingsStore.tsx`(统一前端设置 Context + hook)。
- 新增 `frontend/src/components/SettingsPanel.tsx`(设置中心:左导航 + 右 pane,7 分类)。
- 改 `frontend/src/components/PermissionSettings.tsx`(pane 化:去 modal,导出 PermissionRulesPane)。
- 改 `frontend/src/components/HarnessSettings.tsx`(pane 化:去 modal,导出 HarnessPane)。
- 改 `frontend/src/components/Sidebar.tsx`(4 散按钮 → 单齿轮;移除 Popover/语言/提示音本地 state 与相关 import)。
- 改 `frontend/src/App.tsx`(移除两个独立弹窗 state,改 settingsOpen;渲染 SettingsPanel;Sidebar props 改 onOpenSettings)。
- 改 `frontend/src/main.tsx`(App 包 `FrontendSettingsProvider`)。
- 改 `frontend/src/i18n/locales/{zh,en}.json`(新增 `settings.center.*` 分类/文案;移除已死的
  `settings.languageTip` / `settings.notifySound.*` / `settings.perm.openTip` / `settings.perm.title` /
  `settings.harness.openTip` / `settings.harness.title`)。
- 改 `frontend/src/index.css`(新增 settings-card/nav/pane/row/opt/switch 等样式;
  移除已死的 `perm-settings-card/head/title/desc/actions` / `harness-settings-card`)。

## 验证
- `wails3 generate bindings` 重新生成(bindings 不入库)。
- `cd frontend && bun run build`(tsc + vite production):通过,无类型错误(仅预存在 chunk>500kB 警告)。
- `cd frontend && bun run test`:27 pass / 0 fail。
- `go build ./...` / `go vet ./...`:clean(仅无关 macOS SDK 链接器 warning)。
- `go test ./...`:全包通过(本 task 仅改前端,Go 侧无逻辑改动;dist embed 因 `bun run build` 产出的 dist 存在而正常)。

## 设计权衡 / 已知限制
- **不迁模型刷新进设置中心**:它是 per-session 动作(对活跃 session spawn probe harness),
  与全局设置语义不符,留在 ChatView header。
- **外观 / 对话分类暂为占位**:留位为后续(主题、字号、auto-continue 开关等)扩展做准备,
  当前不实现具体设置(§3.1 不提前实现)。
- **快捷入口取舍**:选择「移除」而非「保留快捷跳转」,以最强程度收敛到单一入口;
  权限待决状态仍由侧栏 session 行的 perm-dot 指示(不受影响)。

## 下一步
- 实机 `wails3 dev` 验证:齿轮 → 各分类切换、语言即时切换、提示音开关即时生效、
  权限规则增删改 + 恢复默认、harness 刷新/升级。
- 后续新设置(主题、字号、auto-continue、危险命令 deny 可视反馈等)按分类加进 SettingsPanel。
