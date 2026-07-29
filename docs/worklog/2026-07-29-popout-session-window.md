# 2026-07-29 popout-session-window

## 起因

用户想要 VS Code 式「move to new window」:任意 session 可弹到独立窗口,专注查看/操作该对话。

## 设计(多轮讨论后定稿)

核心:后端是唯一真相(对话在 SQLite,终端在新加的 ring buffer),窗口只是真相的"视图"。

- **popout 单例**:`map[sessionID]→*WebviewWindow`(实际用 Wails3 WindowManager 的 `GetByName("popout-<sid>")` 实现,命中 focus / 不命中新建)。
- **被 popout 的 session,主窗口不渲染其 ChatView + SidePanel + Terminal** → 单一渲染源 → 终端输入互斥不存在 → 权限/状态/声音不双弹。
- **主窗口事件过滤**:`poppedSessionIds` 集合,全局事件处理器对该集合内的 session 跳过 permission/error/sound。一道过滤杀掉一类症状(§5.3 不变量)。
- **对话状态传递**:路径 B 快照——主窗口弹出前打包 React state(items/queue/draft/livePlan/permission)→ `SaveSessionSnapshot` 后端中转 → popout boot 时 `GetSessionSnapshot` 取回(一次性)。已落库历史走 SQLite `LoadMessages`。
- **终端 scrollback**:后端 PTY ring buffer(64KB/终端),`readLoop` 同时写 ring buffer + emit 广播。任何窗口需终端 → `GetTerminalScrollback` replay 历史 → 继续订阅实时事件。弹出/回切/重开同一路径。MVP popout 终端全新开(ring buffer 为共享 PTY 场景预留)。
- **主窗口重建**:`ApplicationShouldTerminateAfterLastWindowClosed` 改 false(popout 开着时关主窗口不退出);`ApplicationShouldHandleReopen` 事件重建已销毁的主窗口(Wails3 内置 reopen 只 Show 不重建)。
- **hash 传参**:`/#popout=<sid>` 告诉新窗口自己是 popout;fragment 不发后端,前端 `location.hash` 读取。

## 改了哪些文件

**后端:**
- `internal/terminal/scrollback.go`(新):ring buffer 实现,`write`/`snapshot`,固定容量预分配 + size/pos 双游标。
- `internal/terminal/scrollback_test.go`(新):6 个测试覆盖写入、环形覆盖、跨边界、快照副本、空安全。
- `internal/terminal/service.go`:`termSession` 加 `sb *scrollback`;`readLoop` 写 ring buffer;新增 `GetTerminalScrollback` binding。
- `internal/chat/window.go`(新):`OpenSessionWindow`/`FocusSessionWindow`/`CloseSessionWindow`/`IsSessionWindowPopped`/`GetSessionProjectID` + `SaveSessionSnapshot`/`GetSessionSnapshot` + `emitPopoutChanged`。
- `main.go`:`ApplicationShouldTerminateAfterLastWindowClosed: false`。
- `desktop.go`:`createMainWindow` 抽函数 + reopen handler(`events.Mac.ApplicationShouldHandleReopen`)重建主窗口。
- `internal/terminal/scrollback_stress_test.go`(新):3 个压测(10000 次随机写入、后缀正确性、交替写+快照)。

**前端:**
- `App.tsx`:`parsePopoutHash` + `popoutMode`/`isPopout`/`poppedSessionIds` state;popout 启动 effect(查 projectId 后 `openSession`);快照还原 effect;popout-changed 订阅 + boot 对账;全局事件过滤(permission/error/sound);`popoutSession`/`focusPopout`/`closePopout` callback;渲染分支(popout 隐藏 Sidebar,已 popped session 不渲染 ChatView/SidePanel)。
- `components/Sidebar.tsx`:`poppedSessionIds`/`onPopoutSession`/`onFocusPopout`/`onClosePopout` props;session 行角标(`ExternalLink`)+ 点击 focus;右键菜单「移到独立窗口/移回主窗口」。
- `index.css`:`.session-popout-mark` + `.app[data-sidebar-collapsed="popout"] .chat-header { padding-left: 78px; }`。
- `i18n/locales/{en,zh}.json`:`moveToNewWindow`/`moveBackToMainWindow`/`popoutTip`。

## 验证
- `go test ./internal/...` 全过(scrollback 9 测含压测 + chat 包不回归)。
- `bun run tsc -- --noEmit` 通过。
- server 模式 + 浏览器端到端:sidebar 隐藏、SidePanel 渲染、chat-header 有标题、composer 可输入 + send 按钮激活、78px 红绿灯避让。
- **压测:10 session × 5 轮 = 50 次 popout 打开/验证,全部通过(50/50)**。内存 63-128MB 波动,无单调累积(GC 正常回收)。ring buffer 10000 次随机写入压测,snapshot 长度始终正确。

## 踩坑

- **popout 模式 selectedProjectId 没设**:`openSession(popoutMode)` 没传 projectId → `sessions`/`activeSession` 派生空 → SidePanel 空 + sendMessage 上下文不完整。初版从 `sessionsByProject` 查 projectId,但**多项目加载时序**导致某些 session 查不到(它在某项目数组里但还没加载)。修复:后端加 `GetSessionProjectID` binding,前端启动 effect 直接调后端拿 projectId(不依赖 sessionsByProject 时序)。
- **GetSessionProjectID panic(nil 解引用)**:`store.GetSession` 在 session 不存在时返回 `nil, nil`(不报错),直接 `se.ProjectID` panic。修复:加 nil 检查,返回空串。
- **server 模式 embed 缓存**:改前端后需 `bun run build:dev` + 重 build server binary + kill 旧进程重起(restart 不重新 embed;端口可能被旧进程占)。

## 下一步

- 桌面 dev 模式实测窗口创建/聚焦/关闭/主窗口重建(跨平台 §4.6:macOS WebKit + Win WebView2)。
- 终端共享 PTY 场景:同一 terminalID 两个窗口,ring buffer replay 已就绪,前端 termRegistry 接入即可。
- 可选:popout 窗口几何记忆、重启恢复 popout 列表。
