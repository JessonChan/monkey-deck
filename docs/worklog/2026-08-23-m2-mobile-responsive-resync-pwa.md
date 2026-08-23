# 2026-08-23 M2 移动端可用性:响应式抽屉 + 触屏 tooltip + 对话框降级 + resync hook + PWA

## 起因

接替前任程序员继续 M2(AGENTS.md §3.1)。前任留下未提交 WIP(manifest/icons/index.html/App.tsx/index.css),覆盖了 M2 五个子项的雏形。本次任务:补缺口、修 WIP 中的真 bug、按 M2 硬约束(桌面 UI 零修改)完成验收、原子提交。

## 继承 WIP 的内容(已验证后提交)

- ≤768px 媒询:侧栏变 fixed 抽屉、modal/settings/new-session 卡片降级、resize 分隔条隐藏。
- coarse pointer 检测 + react-tooltip `openOnClick` + `delayShow:0`(库 6.0.8 实证支持)。
- `remote:resync` 前端监听(重拉 ListProjects/ListHarnesses/refreshSessions)。
- PWA:manifest.webmanifest + 192/512 图标 + index.html manifest/apple-touch-icon 链接 + viewport-fit=cover。

## 本次修的真 bug(全部 E2E 实证)

1. **drawer-scrim 桌面泄漏**:`display:none` 只写在 ≤768px 媒询内 → 桌面端空 `<button>` 以 UA 默认样式渲染,违反「桌面 UI 零修改」。修:基线 `.drawer-scrim { display:none }` 移出媒询。
2. **抽屉初始态竞态(设计层重写)**:WIP 靠挂载期 `sidebarPanelRef.collapse()` 收起抽屉——实测被 react-resizable-panels 的 deferred 初始布局静默覆盖(attr 停在 "false"、面板 18% 展开、scrim 显示);同 effect 里右侧面板的 collapse 却生效(不对称,库内部时序,不再深挖)。修:抽屉可见性改**显式 `drawerOpen` state**(默认 false)+ `.app[data-md-drawer]` 属性驱动 CSS,rail toggle 在 ≤768px 分支走 state、>768px 走原 imperative 路径。竞态免疫且更少代码;抽屉内导航(选项目/session/新建/加项目/设置)自动收抽屉。
3. **manifest/icons 401**:浏览器对 `<link rel=manifest>` / apple-touch-icon 的子资源抓取按规范**不带 credentials**,授权 cookie 不随行 → 手机「添加到主屏幕」被 401 挡住。修:`internal/remote` 鉴权中间件豁免 `/manifest.webmanifest` 与 `/icons/` 前缀(纯公开元数据,binding 面鉴权不变)。
4. **PickFiles 回形针远程坏交互**:`ChatService.PickFiles` 在桌面宿主弹原生对话框,手机点按无可见反馈。修:`window.__mdRemote`(custom.js 注入)下隐藏入口(`lib/remote.ts`);图片/音频本就走 DOM file input,远程可用。手机→宿主上传(embeddedContext 内联 Resource,后端 Attachment kind:"resource" 已就绪)留 M2.5+。
5. **右面板 toggle 在移动端产生 54px 死条**:右面板非 fixed、在 flex 流内,展开即挤聊天区到 minSize。修:≤768px 隐藏 `.panel-toggle.right`(文件树/diff/editor 是桌面密度 UI)。
6. **`.app` 高度**:100vh 在 iOS Safari 越过 URL bar 遮挡 composer → ≤768px 用 100dvh。settings 卡片 100vw/100dvh 与 overlay padding 冲突溢出 → 改贴合 padding 盒(370×824@(10,10) 实测)。

## 关键实证方法(可复用)

- **桌面零修改验收**:HEAD 构建 vs WIP 构建(server 二进制,同一 db 拷贝,1440×900,无 session 与 session 打开两态)像素级 diff = **0**(PIL ImageChops,bbox=None)。
- **移动端 E2E**:Puppeteer 390×844 + CDP `Emulation.setEmulatedMedia`(pointer:coarse——Puppeteer 自带 `emulateMediaFeatures` 不支持 `pointer`,必须走 CDP)。抽屉初始收起/rail 开(带 scrim)/scrim 点关/点已选项目不关(仅展开,正确)/点他项目自动关/tooltip 点按出现/paperclip 隐藏,全部通过。
- **resync 增量验证**:idle 基线 0 绑定调用 → 主世界注入 `window._wails.dispatchWailsEvent({name:'remote:resync'})` → ListProjects+1 / ListHarnesses+1 / ListSessions×23(每项目重拉)。
- **真实产品路径**:桌面二进制(`MD_REMOTE_ENABLED=1 PORT=9254 TOKEN=…` + XDG 隔离)+ 浏览器 `/auth?token=` 换 cookie 直连——custom.js 的 `__mdRemote` 标记与 WS 桥全链路工作。

## 踩坑记录(重要,防再踩)

- **omp browser 的 `page.evaluate` 跑在隔离 world**:页面主世界的 `window.*` 全局(`__mdRemote`/`_wails`)从 evaluate 读永远是 undefined,一度误判 custom.js 未执行、runtime global 丢失。判别法:注入 `<script>`(主世界执行)写 `document.documentElement.dataset` (DOM 跨 world 共享)再从 evaluate 读。**所有 window 全局断言必须走主世界 script 注入。**
- `evaluateOnNewDocument` 在该环境 reload 后偶发不生效,别依赖它做跨导航 instrumentation。
- react-resizable-panels 挂载期 imperative 调用不可靠(deferred 初始布局会覆盖);挂载后的调用正常。凡是「初始布局」需求,用显式 state,别跟库抢挂载时序。
- `PUT N.=M:` 编辑范围错一行会吞相邻行(本次两次:compose-tools div、McpChip import),tsc/语法探针会兜住,修回即可。

## 改动文件

- `frontend/src/App.tsx`(drawerOpen 状态机、rail toggle 分支、抽屉导航自动收、coarsePointer tooltip、resync 监听、data-md-drawer 属性)
- `frontend/src/index.css`(M2 媒询块:抽屉/scrim/对话框降级/dvh/safe-area/右 toggle 隐藏;scrim 基线 display:none)
- `frontend/src/components/Composer.tsx` + `frontend/src/lib/remote.ts`(远程隐藏回形针 + isRemoteClient)
- `frontend/index.html`、`frontend/public/manifest.webmanifest`、`frontend/public/icons/`(PWA)
- `internal/remote/server.go`(manifest/icons 鉴权豁免)

## 验证汇总

- `bunx tsc --noEmit` 过;`bun test` 224 pass / 5 fail(5 个全为 HEAD 既有 NewSessionModal 基线,零新增);`go test ./internal/remote/ ./internal/chat/` 过;双构建(desktop / -tags server)过。
- 桌面像素 diff = 0(两态);769px 边界:移动布局关闭、rail 走桌面路径。
- 未做:真机(iOS Safari / Android Chrome)实测——浏览器仿真已过,真机属用户侧动作;AGENTS.md M2 状态保持「进行中」注明差距。

## 下一步

- 真机实测(iPhone Safari 同 Wi-Fi 直连 `http://<mac>:9254/auth?token=…`,验证抽屉手感/软键盘/滚动);若有问题回写到 M2。
- M2.5 Capacitor 薄壳(触发条件:M2 完成 && 真机验证后有安装 APP 需求):server URL 模式 + 扫码配对 + token 入钥匙串。
- 手机→宿主文件上传(embeddedContext 内联 Resource 通道已就绪,前端未接)。

## 分支与提交

main,6 个原子提交:responsive / resync-hook / pwa / remote-manifest-auth-fix / paperclip-remote-hide / docs(本条)。
