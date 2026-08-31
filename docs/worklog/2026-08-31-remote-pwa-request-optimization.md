# 2026-08-31 性能:远程/PWA 请求提速全量落地(R1-R8 + O1-O4 + N1)

## 起因

用户观察到远程浏览器/PWA 下每个操作都触发一串 HTTP 请求(§1.8 设计使然:每个 binding
调用 = 一次 fetch POST)。前两轮调研(omp reviewer + codebuddy 两轮 ACP 评审,driver 复用
/tmp/cbreview,评审原文 /tmp/mdplan/{r1,r2}.out)确认了在不改架构(不造第二套 API、WS 断线
只重连不补发、桌面零回归)前提下的优化方案组,用户拍板全量实施。

## 关键事实基线(评审实证,行号为当时 HEAD)

- openSession 最多 10 个串行 await(其中 4 个 ref 守卫仅首次);重开已开过的 = 6 个。
- `SessionDiff` 是死流量:结果只喂 ChatView 一个从未解构的 prop;后端 worktree 路径
  6 个 git 子进程。三处调用(openSession/turn-end/merge 后)全白费。
- resync 风暴 = 11+N+P 请求(1 项目=13);custom.js `readyState > 1` 判断在 CONNECTING 态
  会双发(visibilitychange 立即 dispatch + onopen 再 dispatch)。
- 冷启动对每个 session 发一个 `IsSessionWindowPopped`(S 个请求),远程端 100% 白费
  (远程无 popout,window.go 无 GUI 即 no-op);3 项目×60 session = 68 请求冷启动。
- wails alpha2.106 asset handler 无 Cache-Control/ETag/压缩(上游代码被注释);
  首屏实为 ~1.8MB(entry JS 1.61MB + CSS,懒 chunk 不算)。
- popout 窗口无 WS(custom.js 在 webview 404),不触发 resync;多标签页才是 N 倍风暴。

## 改动(12 个原子 commit,顺序即提交序)

| commit | 内容 |
|---|---|
| 6bfd39a | **O1**:远程/popout 跳过 popout reconcile S 扇出(App.tsx) |
| 2ac0ea6 | **N1**:custom.js 401 逃生门(WS close → 探 /health,401 → reload 落配对页) |
| 8bc8af9 | **R1 前端**:删 SessionDiff 三处调用 + 死 state + 死 prop + 10 测试文件 |
| 7d99bc8 | **R1 后端**:退役 SessionDiff binding + gen bindings + 4 个 binding 名列表测试 |
| 842e326 | **R6**:`internal/remote/assetcache.go` 缓存头 + 条件 gzip(9 个单测) |
| 2ae65d9 | **R8**:docs/remote-deploy.md 补 HTTP/2 收益说明 |
| 0754729 | **R3 根因**:custom.js `readyState > 1` → `!== 1`(每次唤醒恰一次 resync) |
| 1b5362c | **R3 前端**:resync 300ms 去抖 + 首连跳过列表刷新 + O3(去重 status pull) |
| 0b608dd | **R4**:gitByProject 增量缓存(true 永久 / false 每次重探 / merge 不替换) |
| 00bc2c4 | **changesBySession**:sessionChanges 全局单值 → per-session map |
| a191d49 | **R2+R5**:openSession 并行化(唯一未 catch 的 LoadMessagesPage 保持 reject 语义)+ 手机端门控 |
| a42c9fe | **R5 回补**:单 effect 盯 4 个门控输入,重开时补拉;turn-end 同谓词门控 |
| 2e62ac1 | **O2**:popout 跳过 P×ListSessions |
| 77aed80 | **O4**:终端击键 30ms 合并写入(镜像 resize 防抖模式) |
| d59d7a2 | 远程端隐藏 popout 右键菜单项(保留 popout 标记点:信息非动作) |
| (本条) | AGENTS.md §7 登记 SW DROP + 本 worklog |

### R5 门控谓词(评审对辩终版)

`shouldPullGit() = !mdViewport || rightDrawerOpen || !rightCollapsed`,全读 ref。
真值表关键行:**桌面 >768px 恒拉**(哪怕面板收起——Composer 分支芯片还亮着,门控会空白芯片,
刻意保守侧);手机 ≤768px 且右抽屉关才跳过(此时 SidePanel 两 tab 屏幕外 + 芯片 display:none)。
`WorktreeKind` 不进门控(纯 DB 读 0 exec,喂可见的合并按钮门控)。回补 effect 盯
[mdViewport, rightDrawerOpen, rightCollapsed, selectedSessionId] 四输入。

### R4 缓存策略(评审修正后的前提)

「项目 git 上下文进程期不变」是**假前提**(agent 会 git init/clone)。采用:true 永久缓存
(git 项目是常态,探测最贵)、**false 每次重探**(false→true 是唯一真实翻转方向)、
merge 不整体替换(替换会抹掉本次跳过的条目)。STRICT IsGitProject(worktree 门控)
不走此缓存,语义不串。

### R6 不变量(承重,违反=僵尸壳)

- `index.html` / `/` / `/wails/custom.js` **永不长缓存**(no-cache)——升级后手机必须能拿到新壳。
- hash 资产 `/assets/*`:`private, max-age=31536000, immutable`(文件名即版本)。
- manifest/icons:`private, max-age=86400`。
- gzip 白名单:text + ttf/otf(未压缩字体容器);不压 woff2/png;≥1KB;Range 请求跳过;
  `Vary: Accept-Encoding` 必发。包装层在 `internal/chat/remote.go` Assets 入参处
  (transport 内侧),`/wails/runtime` 结构性不经过——webview 通道零改动。

## 验证

- **单测/gate**:每 commit 后 `tsc --noEmit` + `bun test --isolate`(524/524 全绿)+
  `go test ./...`(全过);R6 新增 9 个 assetcache 单测(缓存头矩阵/gzip 白名单/Range/
  非 200/round-trip)。custom.js 变更用 node `new Function()` 语法校验。
- **三端矩阵(§4.7/§5.6)**:
  - 桌面 GUI:R1/R3/R4/O1/O2 为纯请求层改动,>768px 渲染与交互零变化(tsc+全量 mount 测试
    过 = 组件树不变);R2 改变到达顺序但全部写 per-session map(构造上不串);R5 桌面恒拉
    (谓词保守侧),`wails3 dev` 冒烟打开/切 session/SCM 面板/分支芯片正常。
  - 远程浏览器:server 模式 curl 实证 R6 响应头(Cache-Control/Content-Encoding/Vary/Range);
    注意 **server 模式的 custom.js 是 wails 自带版,`__mdRemote` 不置位**——O1/菜单隐藏等
    `isRemoteClient()` 守卫必须 `MD_REMOTE_ENABLED=1` 真路径验证(评审指出的验证陷阱)。
  - PWA ≤768:R5 门控生效路径(抽屉开 → 回补)+ O4 击键合并;**待真机实测**(iOS standalone
    长缓存行为 + 触屏手感,与 M2 遗留同批)。
- **收益账(手机端,1 项目/20 session)**:冷启动 binding 24→4;openSession 10 波→2-3 波
  (抽屉关时 git 拉取跳过);resync 13 请求/12 exec→~5/0,双发→单发;二次加载 ~1.8MB→~0;
  终端输入每击键 1 POST→30ms 合并。

## 下一步

- `MD_REMOTE_ENABLED=1` 真路径三端冒烟(尤其 isRemoteClient 守卫激活态)。
- iOS 真机:standalone 长缓存 + R5 抽屉回补手感(与 M2 遗留合并验)。
- IST v4 实现时:chat:bg 节流必须 per-sessionId;`SessionBgStates()` 只进 resync handler 一次,
  不进 openSession;「抽屉打开时补拉 SessionChanges + epoch 期 SCM 按钮被后端拒」记入其回归清单。
- OPEN(评审登记,未修):custom.js 无应用层心跳,OPEN-but-dead 半开连接依赖
  visibilitychange 的无条件 reconcile 兜底——KISS 取舍,已知边界。
