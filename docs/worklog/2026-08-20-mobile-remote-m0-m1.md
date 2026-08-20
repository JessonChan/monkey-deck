# 2026-08-20 Mobile/Remote M0 验证 + M1 内嵌远程服务

## 起因
用户提出移动端方向:手机经某种 Relay 直连 Monkey Deck 看全部聊天历史并交互。讨论收敛为:
Relay 第一阶段可省掉,问题简化为「移动端浏览器能否直连 Monkey Deck 进程」。分四阶段:
M0 零代码验证 / M1 桌面进程内嵌远程 HTTP / M2 移动端可用性 / M3 远程通路(Tailscale/TLS/PWA) /
M4 relay+推送(显式推迟,见 AGENTS.md §7)。

## M0:零代码验证(全部通过)
- 构建 `-tags server` 二进制,`WAILS_SERVER_HOST=0.0.0.0 WAILS_SERVER_PORT=9250` 起服务。
- **curl 破解 binding wire 格式实调**:`POST /wails/runtime`,body
  `{"object":0,"method":0,"args":{"call-id":"x","methodID":<N>,"args":[...]}}` → ListProjects 返回全部真实项目。
  (methodID 来自生成 bindings `$Call.ByID` 的数字;`runtimeCallWithID` 见 runtime.js:84。)
- 浏览器驱动:`window._wails` 注入、19 项目渲染;挂钩 `dispatchWailsEvent` + curl 触发 `RefreshHarnesses`
  → 页面捕获 `chat:harnesses` —— **WS 事件流端到端实证**。
- LAN 绑定实证:`*:9250 LISTEN`,`http://192.168.31.251:9250` 可达(手机同 Wi-Fi 直连地址)。
- 附带发现:server 模式 serve 的 HTML 无 wails 脚本注入 —— `window._wails` 来自 vite 打进 bundle 的
  `@wailsio/runtime` 自初始化;binding wire 无状态(`call-id` 仅用于取消注册表),多客户端并发天然安全。

## M1 调研(源码级核证,不 fork wails)
四条公开 API 逐一核证(alpha2.106):
1. `application.Options.Transport`(:123)注入自建 `NewHTTPTransport()` → `application.New` 内部
   `Start(ctx, messageProcessor)` 接到已装配全部服务的分发器 —— 与默认 transport 等价,桌面 webview 零影响。
2. `HTTPTransport.Handler()` 公开中间件(transport_http.go:130),挂自有 TCP mux 即得 `/wails/runtime` ——
   同一实例同时服务 webview scheme 与 TCP。
3. `app.Event.On`/`Emit`(events.go:137-170):Emit 双 goroutine 并行扇出 On 监听器 + transport 层,桥接纯增量。
   前端订阅闭集 13 事件(chat×10 + terminal×3),与后端发射闭集一致。
4. custom.js 机制:bundled runtime 无条件 `loadOptionalScript('/wails/custom.js')`,404 静默跳过;
   桌面 asset 链对该路径固定 404(application.go:126)→ webview 不建 WS、我们的 mux 提供 → 浏览器建。
   自然分流阀,零条件判断。
- 无窗口容错:`processCallMethod` 的 `if window != nil`(messageprocessor_call.go:115)显式容忍浏览器客户端。

## M1 实现
- **AGENTS.md 先行**(§6.1):新增 §1.8 远程访问硬约束(复用协议面不自建 API/鉴权强制/默认关闭/
  build-tag 互斥/WS 只重连不补发/relay 推迟)+ §3.1 M0-M4 支线表 + §5.5 区分注记 + §7 relay 行。
- `internal/remote`(server.go/hub.go/customjs.go):
  - mux:`/health`(豁免) + `/auth?token=`(token 换 HttpOnly SameSite=Strict cookie,302 `/`) +
    `/wails/custom.js` + `/wails/events`(WS hub)+ `/`(transport.Handler() 包共享 asset handler)。
  - 鉴权中间件:cookie(`md_remote_token`)或 `Authorization: Bearer` 二选一,`subtle.ConstantTimeCompare`;
    仅 /health、/auth 豁免 —— binding 面 = agent 完整控制权,无鉴权暴露不可接受。
  - hub:`coder/websocket`(wails 既有间接依赖转直接);broadcast 每客户端独立 goroutine + 5s 超时,
    失败即弃;读循环用 `context.Background()`(**坑:r.Context() 在 ServeHTTP 返回即取消,连接瞬断**);
    CloseNow 免握手(**坑:Close() 握手等对端回应,空闲广播客户端永不回应,曾致测试挂 10s**)。
- chat 接线(remote.go):设置持久化**复用既有 settings KV 表**(0001 迁移,`GetSetting/SetSetting` ——
  曾新建 app_config 表后识别为重复造轮子,已删);bindings `GetRemoteInfo/SetRemoteEnabled/SetRemotePort/
  RegenerateRemoteToken`;`AttachEmbeddedRemote` 为**包级函数**(wails binding generator 按导出方法全量生成、
  无排除机制,方法会被误暴露);生命周期挂 ServiceStartup(maybeStart)/ServiceShutdown(先停远程再拆 session)。
- main:`Options.Transport` 注入 + `attachEmbeddedRemote` build-tag 拆分(desktop 接线 / server no-op,
  同 runDesktop 模式)——server 二进制自身 serve HTTP,禁止双服务。
- dev/CI 逃生口:`MD_REMOTE_ENABLED/PORT/TOKEN` 环境变量。

## E2E 实测(隔离环境:XDG_* 指临时目录 + 拷贝真实 db + env 强制开启)
- curl 矩阵全绿:/health 200;/ 401;错 token 401;对 token 302+Set-Cookie;cookie 页面 200;
  custom.js 含 resync;**binding ListProjects 经内嵌服务返回真实数据**。
- 浏览器:/auth 换 cookie 自动跳转、项目渲染、页面内 fetch 触发 RefreshHarnesses → 捕获 chat:harnesses。
- 设置页远程分类:开关/端口/令牌掩码/7 个连接地址。
- **E2E 揪出三个真 bug**(均已修,见 fix commit):
  1. 生成 bindings 字段是 Go 导出名(Enabled/URLs),pane 用小写永不生效;
  2. 关停服务响应在传输层丢失 → fetch 永不 resolve → 乐观补丁放 await 后不执行。改为点击瞬间补丁;
     开启方向失败回滚 + §4.4 人话提示(远程客户端的传输通道即被关的服务,架构上无法自救);
  3. useCallback 依赖数组 info.Enabled 在首渲染 null 即崩(hooks 早于守卫),optional chaining 修。

## 验证汇总
- go 全套 0 失败(remote 5 测试 + chat 4 测试新增);双构建(desktop/-tags server)过。
- 前端 tsc 过、bun test 维持基线 5 失败(NewSessionModal 既有,与本改动无关,stash 基线对比确认)。
- 干净环境 UI 全流程:开→7 地址/关→端口即闭+UI 即时翻转/远程开启尝试→回滚+人话提示。

## 下一步
- M2 移动端可用性:响应式布局(≤768px 抽屉侧栏)、tooltip 触屏等价物、PickFiles 等对话框降级;
  手机真机(iOS Safari / Android Chrome)按 §4.6 实测。
- M3:Tailscale 文档化 + 可选 TLS/PWA。
- 桌面 webview 内的设置页人工过一眼(远程分类在真机 app 上);远程客户端断线 resync 前端 hook
  (`remote:resync` 事件已发,前端监听属 M2)。

## 分支与提交
main,5 个原子提交:docs(agents §1.8) / feat(remote 后端) / refactor(Attach 包级函数) /
feat(frontend 设置页) / fix(E2E 三 bug)。
