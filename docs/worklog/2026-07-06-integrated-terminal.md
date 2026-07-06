# 集成终端功能(VSCode 式多 tab 底部面板)

## 起因
项目需要「执行基础 shell 命令」的集成终端,形态对标 VSCode:对话区(含 Composer)作为一个整体,终端作为另一个整体,底部可拖拽 resize,多 tab。

## 调研(先调研后动手,§5.3)
并行调研 4 路:VSCode 终端架构、openwork(最接近同类产品)、orca、Go/Wails3 PTY 方案。结论:
- 三家(VSCode/openwork/orca)底层都是 node-pty + xterm.js;openwork 形态最贴近(react-resizable-panels 同款、底部可拖拽面板、Cmd+J、agent bash 工具走卡片与用户终端分离)。
- monkey-deck 是 Go 后端,node-pty 不能用 → Go 对应物。
- 调研后用户拍板:每 session 终端(cwd = worktree)、多 tab 从一开始(VSCode 式)、扁平 tab 不做 split。

## 选型(遵守成熟库优先 + Less is More)
自查后砍掉 3 处过度设计:
- PTY 库选 `creack/pty`(2.1k★ 成熟标准),不用 aymanbagabas/go-pty(73★ v0.x,为不存在的 Windows 需求选不成熟库违反成熟库优先)。
- 砍掉 ptyHandle 接口 + pty_unix/windows 三文件抽象(只有 1 个实现就抽象,违反「重复 3 次再抽象」),直接用 creack/pty 返回的 *os.File。
- 不加 js-base64 依赖,用原生 atob 解码。
- chat↔terminal 零 Go 耦合:DeleteSession 是前端发起,removeSession 里直接调 KillSessionTerminals,无需 TermKiller 接口注入。

前端无成熟 React xterm 封装库(最活跃的 Qovery/react-xtermjs 也未 React-19 认证、包名不稳),故自封装 ~40 行 useTerminal hook(§5.3 自研仅在无成熟方案时)。

## 坑(踩到记下)
- **macOS 上 `pty.Start` + `Setpgid` 组合 EPERM**:pty 自身经 controlling-tty 处理 session,再叠加 Setpgid 冲突。修法:去掉 Setpgid;交互式 shell 自身会 setpgid 成为组长,`kill(-pgid)` + 关 ptmx(内核向 controlling session 发 SIGHUP,终端模拟器标准清理路径)即可按组回收。Go 单测已覆盖。
- **go build 报 `fork/exec /bin/zsh: operation not permitted`**:隔离确认是 pty+Setpgid 组合触发,不是 exec 通用问题。

## 改了哪些文件
新增:
- `internal/terminal/service.go`:TerminalService(Wails3 service),Start/Write/Resize/Kill/KillSessionTerminals + readLoop + killAll + ServiceShutdown 兜底。事件 terminal:data/terminal:exit 单名 + body 带 id 派发(对齐 chat:event)。
- `internal/terminal/service_test.go`:真 PTY + 普通命令(非 harness,§5.1)测 lifecycle/KillSession/Shutdown/退出后 Write/Resize 不 panic/echo 数据通路。
- `frontend/src/hooks/useTerminal.ts`:单 xterm 实例封装(创建/销毁、onData→Write、onResize→Resize 防抖、ResizeObserver→fit、订阅 terminal:data/exit、base64 解码、主题色匹配 app)。
- `frontend/src/components/TerminalPanel.tsx`:终端 unit(tab 条 + xterm 区)。单击切换/hover ×/中键 kill/右键菜单(改名/Kill)/+ 新建/收起面板。
- `frontend/src/lib/terminalTypes.ts`:TerminalTab + 事件 payload 类型(命名导出,遵守 ts-no-return-type)。

修改:
- `main.go`:注册 TerminalService。
- `App.tsx`:main 面板改纵向 Group(chat-area + terminal-area collapsible,collapse/expand 保持 Panel ID 稳定不变式);⌘J/Ctrl+J toggle;per-session termTabsBySession/activeTermBySession;removeSession 加 KillSessionTerminals + 清 term 状态;移除 closeSession(用户要求去掉关闭 X);termCwd 经 ref 绕开 activeSession 声明顺序。
- `ChatView.tsx`:header 右上角 X 关闭按钮 → 终端 toggle(SquareTerminal + react-tooltip md-tip);Props onCloseSession → onToggleTerminal。
- `index.css` + `main.tsx`:xterm.css import + 终端面板/tab/右键菜单样式(滚动容器用子 margin 不用 gap)。
- `go.mod/go.sum`:`+ creack/pty v1.1.24`。`frontend/package.json`:`+ @xterm/xterm@6 @xterm/addon-fit@0.11`。
- bindings 由 `wails3 gen bindings` 自动生成(frontend/bindings/,gitignored 中间产物,零手写)。

## 验证
- `go build . ./internal/...` 过、`go vet ./internal/terminal/` 干净。
- `go test ./internal/terminal/` 过(含真 PTY:Start/Kill/KillSessionTerminals/Shutdown/退出后 stale op 不 panic/echo 数据通路)。
- `bun run build:dev`(tsc + vite)过,405 模块。
- 独立二进制内嵌 dist 启动 8s:Wails/AssetServer/TerminalService 注册无 panic。
- 注:GUI 点击级 E2E 需人工(无法驱动原生 webview);后端行为已由真 PTY 测试覆盖。

## 下一步(可选,非阻塞)
- 终端 scrollback 跨 session 切换不保留(xterm 随 TerminalView 卸载而 dispose;shell 后端仍活,切回见新输出)。要保留需 lift xterm 实例到全局 registry + re-attach,留 v2。
- split 分屏、tab 拖拽重排、shell profile 下拉(VSCode 锦上添花项,v2)。
- Windows:creack/pty 不支持,需切 ConPTY 库(aymanbagabas/go-pty 或 build-tag 组合),届时再引入 io.Reader/Writer 抽象。

## Review 修复(认真通审后)
- **bug1(用户报)**:点 toggle icon 每次新建终端。修:加 effect,panel 打开且当前 session 无 tab 时自动建一个;有则只展开。
- **bug2(用户报)**:输入框不见 + 聊天不能滚。根因:`.chat-view` 用 `flex:1` 但被包进 Panel(非 flex 父)不生效。修:`.chat-view` 改 `height:100% + min-height:0`;`.main-vertical` 加 `flex:1 + min-height:0` 撑满 flex 父 `.main`。
- **切 tab 不 focus**:active 变化时新 active 的 xterm 没获焦,敲键无反应。修:useTerminal handle 加 `focus`,TerminalView effect 监听 active → fit + focus。
- selectTerminalTab 缩进异常修正。

## Review 修复 第二轮(用户报)
- **bug3(用户报)**:打开就默认展开 + 空「点+新建」面板。根因:terminal-area Panel 在 selectedSessionId 为 null 时不挂载(三元 false 分支),用户选 session 后 Panel 才首次挂载,此时 termPanelOpen 仍 false 但 collapse/expand effect 依赖 [termPanelOpen] 不触发 → Panel 保持默认展开 260px。修:Panel 的 panelRef 改用回调 ref(termPanelRefCb),挂载拿到 handle 当下若 !termPanelOpenRef.current 立即 collapse。
- **bug4(用户报)**:终端夺走 Composer 输入框光标。根因:useTerminal mount 时无条件 term.focus(),TerminalView 切 active 也 focus(),每次打开/切 tab 都把焦点从 Composer 抢到 xterm。修:去掉 mount 时 term.focus();active effect 只 fit 不 focus;改容器 onClick 才 focus(用户点终端区才获焦,不主动抢 Composer)。

## Review 修复 第三轮(用户报,结构性)
- **bug5(用户报)**:terminal-area 初始就有高度一直可见。根因:collapsible Panel 默认展开,回调 ref 的 collapse 时机不可靠(挂载/layout 竞态)。彻底改法:放弃 collapsible + collapse/expand 模式。
- **bug6(用户报)**:切 session 时不同 session 的终端面板状态不独立(session A 开着,切 B 也显示开)。根因:`termPanelOpen` 是全局单值,不是 per-session。
- 一起重做:**`termOpenBySession` per-session 开关状态** + **terminal-area Panel 条件渲染**(仅当该 session open 时才渲染 Separator+Panel,否则 chat-area 独占)。main-vertical Group 未启用 layout 持久化(无 autoSaveId/useDefaultLayout),Panel 增删不影响持久化,不变式不适用此 Group。去掉 collapsible/panelRef/collapsedSize/回调 ref 全套。toggle/closeTerminalTab/createTerminal 全改 per-session。removeSession 清理 termOpenBySession。
- TDZ:toggle 引用 createTerminal,故 createTerminal 移到 toggle 之前定义。
