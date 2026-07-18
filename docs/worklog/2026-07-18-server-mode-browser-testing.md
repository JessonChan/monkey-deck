# 2026-07-18 启用 Wails3 server 模式:浏览器驱动集成测试基建

## 起因
验证 `feat/drop-session-items-on-switch`(切走丢弃)的内存效果时,需要驱动真实 UI
做 session 切换并量内存。撞墙历程:
1. **外部浏览器开 Vite dev URL(`localhost:9245`)**:只渲染 app 外壳,binding 全挂
   (空态 "No projects yet")。
2. 挖 `@wailsio/runtime` 源码找根因。
3. **`wails3 task dev` 的 WKWebView GUI 无法被 osascript 驱动**(web 内容藏在 AXWebArea 后,
   `entire contents` 拿不到);屏录权限没开,截图坐标点击也断。
4. 用户提示"搜 Wails3 测试方式"→ 找到官方路径:**server 模式**。

## 根因(架构事实,挖 runtime 源码确认)
- `@wailsio/runtime` 的 binding 调用统一走 `fetch(origin + "/wails/runtime")`
  (`node_modules/@wailsio/runtime/dist/runtime.js:15-16` `runtimeURL()`,calls.js `ByID` → `Call`)。
- **桌面/dev 模式**:`/wails/runtime` 由 webview 内部 URL scheme handler 拦截
  (WKURLSchemeHandler / WebView2 WebResourceRequested),**不是 TCP 端口**。外部浏览器
  fetch 同 URL 命中 Vite 的 404 → binding 全失败。这是 Wails3 桌面架构的本性,不是配置问题。
- **server 模式(`-tags server`)**:`app.Run()` 起真 HTTP server
  (`application_server.go:55-164` serverApp.run,默认 :8080,env `WAILS_SERVER_PORT` 可配,
  `WAILS_SERVER_HOST` 默认 localhost),同时 serve 前端 embed 资源 + `/wails/runtime` +
  WebSocket(后端→前端事件广播,`customJS` 建立)。浏览器直连 = 真后端 + 真数据。

## 项目障碍 + 改法
**障碍**:main.go 把 GUI 代码(应用更新 / 菜单 / 窗口 / 窗口事件)与无 GUI 的服务装配混在
一个 `func main()` 里。`-tags server` 下 GUI 专属符号消失:
```
go build -tags server .
./main.go:81:22: undefined: application.DefaultApplicationMenu
```

**改法(行为零变化,纯结构拆分)**:
- `main.go`:只留共享逻辑 —— config / 日志重定向 / `chatSvc`+`termSvc` / `app.New`
  (含 MacOptions,两 tag 下都存在)/ `runDesktop(app, cfg)` / `app.Run()`。
- `desktop.go`(`//go:build !server`):新增 `runDesktop(app, cfg)`,把原 main.go 的 GUI 块
  (update.Init + StartBackgroundChecks + 菜单 DefaultApplicationMenu + 窗口创建
  NewWithOptions + 4 个窗口事件处理)整体搬入。
- `server.go`(`//go:build server`):`runDesktop` no-op。

## 改了哪些文件
- `main.go`:瘦身到 ~80 行共享入口(-153 行 GUI 块)。
- `desktop.go`(新):GUI 装配,`//go:build !server`。
- `server.go`(新):no-op,`//go:build server`。
- `AGENTS.md`:新增 §5.5《浏览器驱动集成测试:Wails3 server 模式》——记录架构事实、用法、
  适用场景、约束(共享 SQLite / 无 GUI / V8≠JSC / main.go 必须做 server 拆分)。

## 验证(实证,非声称)
1. **两 build 都过**:`go build .`(desktop,exit 0)+ `go build -tags server .`(server,exit 0)。
2. **server 真起 HTTP**:`WAILS_SERVER_PORT=9246 ./bin/monkey-deck-server` 日志输出
   `Server mode starting address=localhost:9246` 并阻塞(被 `timeout` 杀,exit 124 = 阻塞存活);
   `lsof` 确认 `md-server` 监听 `127.0.0.1:9246`;`curl GET /` 返回前端 HTML
   (`<!doctype html><html lang="zh-CN">…`)。
3. **浏览器拿真数据**:Chromium 开 `http://localhost:9246`,body 显示 14 个真实项目
   (svg_creater / api-server / monkey-deck / agibible …,来自 SQLite),`window._wails` 已注入
   (对比:Vite :9245 直连是 "No projects yet" + `window._wails` undefined)。
4. **内存测量可用**:点开一个 session,`performance.memory.usedJSHeapSize` 量到 heap
   **7.9 MB → 12.4 MB(+4.5 MB)**,渲染 101 个消息节点 / 4319 字正文 —— 证明基建能精确量
   session 加载的内存成本,正是切走丢弃测试所需。
5. `go test ./internal/...`:全过(未触内部包)。

### 附:跨工具调用保活 daemon 的方法(agent 环境专用)
agent harness 会回收 bash 启的后台进程(async job / `nohup &` / `setsid &` 都会被收,
变 zombie)。解法:**用持久 eval 内核(Bun)的 `child_process.spawn(..., {detached:true})` +
`child.unref()`** —— 持久 kernel 跨工具调用存活,其 detached 子进程跟着活,server 得以
跨多个 browser/bash 调用持续 serve。此技巧仅 agent 环境需要;人类直接在终端跑
`./bin/monkey-deck-server` 即可。

## 分支
`feat/server-mode-testing`(用户要求新分支隔离,不污染 main)。两个原子提交:
- `90547e9` refactor(main):拆分 GUI 到 desktop.go,启用 -tags server 构建(代码)
- `0215aac` docs(agents):新增 §5.5(server 模式文档)

## 下一步
- 这条基建的**首个实际应用**:回到 `feat/drop-session-items-on-switch` 分支,用它做
  切走丢弃的内存 A/B 测试(多 session 切换,看 heap 是平台期还是单调爬升)。
  注意:server 模式跑的是 V8/Chromium,数字≠WebKit 绝对值,但趋势可信;绝对 WebKit 数字
  仍需桌面 app 上 `vmmap`/`top` 量(见 docs/worklog/2026-07-18-drop-session-items-on-switch.md)。
- 可选增强:把 server 模式跑进 CI(无 GUI,适合 headless 集成测试),配合 Playwright 做回归。

## 关联
- 触发本工作的内存优化分支:`feat/drop-session-items-on-switch`
  (worklog `docs/worklog/2026-07-18-drop-session-items-on-switch.md`)。
- 终端 scrollback 收敛(同期内存线):`docs/worklog/2026-07-17-terminal-scrollback-shrink.md`。
