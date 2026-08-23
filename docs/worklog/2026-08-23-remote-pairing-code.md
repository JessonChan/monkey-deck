# 2026-08-23 远程配对制:一次性配对码取代 token-in-URL

## 起因

用户规划公网暴露(公网机 + Caddy 反代),追问安全模型:token 在 GET 链接里,「拿到链接的人就能访问」——属实,长效凭证躺在 URL 里,链接经聊天工具/历史记录泄露 = 永久钥匙泄露。讨论收敛(mTLS 嫌侵入、basic auth 手机端无法持久、Caddy forward_auth 要多跑服务):**把泄露面做没**——一次性配对码,即用户提出的「token 初次访问配一个配对码」模型的落地版,关键细化:**URL 里只允许出现配对码,长效 token 永不进 URL**。

## 设计

- **配对码**:6 位数字,10 分钟有效、**单次使用**、错 5 次作废,新码生成即替换旧码(crypto/rand)。桌面设置页生成(只有能碰桌面的人能看码 = 授权语义)。
- **`/pair?code=`**:验证通过 → 发 365 天 HttpOnly SameSite=Strict cookie(值=长效 token,与 M1 相同)→ 302 `/`。失败:浏览器得 HTML 错误页,原生客户端得纯 401。
- **未认证浏览器访问 `/`**:不再裸 401,而是返回内联配对登录页(自包含深色表单,无资产依赖;`Accept: text/html` 判定,curl 仍 401)——手机不用输 URL,打开域名即见配对页。
- **`/auth?token=` 移除**(clean cutover):绑定/测试/设置页 URL 全部迁移。长效 token 保留两处合法用途:`Authorization: Bearer`(原生/CI)与设置页展示/复制;Regenerate = 全设备失效的 kill switch 不变。
- **设置页**:「配对新设备」按钮 → QR(react-qr-code,MIT,`base/pair?code=`)+ 大号配对码 + 秒级倒计时 + 过期提示。GetRemoteInfo 的 URLs 改为无 token 基址。

## 改动文件

- `internal/remote/pairing.go`(新:pairingState/handlePair/登录页/错误页 HTML)
- `internal/remote/server.go`(`/auth`→`/pair`,auth 中间件浏览器分支,Server.pairing 字段)
- `internal/remote/server_test.go`(TestPairingLifecycle/TestPairingLoginPage,替换 TestAuthEndpointExchange)
- `internal/chat/remote.go`(GenerateRemotePairingCode 绑定,GetRemoteInfo 无 token URL)+ `remote_test.go` 断言更新
- `frontend/src/components/RemoteSettingsPane.tsx`(配对段:按钮/QR/倒计时)、`index.css`、i18n en/zh
- `AGENTS.md` §1.8 配对硬约束条 + §3.1 M2.5 措辞
- bindings 再生成(注意:`wails3 generate bindings` 裸命令产出 **.js**(JSDoc),旧 .ts 被替换;tsc/vite 兼容实测通过)

## 验证

- 后端单测:`go test ./internal/remote/ ./internal/chat/` 全过(生命周期:换 cookie→复用 401→5 次错猜烧码→浏览器 HTML/原生 401 分流→未认证 `/` 登录页)。
- 真实 app E2E(9260):binding wire 生成码 `["290362",...]`;**干净 browser context**:未认证 `/` → 配对表单 ✓;错码 → HTML 错误页 ✓;对码 → 302 → 23 项目 app ✓;复用 → 401 ✓;设置页:配对框 + 6 位码 + QR SVG + 倒计时 599s ✓;连接地址无 token ✓。
- 坑:E2E 页面共享 cookie jar,`browser.newPage()` 非隔离——未认证断言必须 `createBrowserContext()` 开干净上下文,否则旧 cookie 让「配对页」假失败。

## 安全边界(诚实声明)

- 配对码防「链接泄露」;不防「码被旁窥」(10 分钟窗口)与「设备沦陷」(沦陷则 cookie 直接可偷)。
- 公网部署仍须 Caddy TLS 反代;`/pair` 建议反代层限速(码 5 次错猜自烧是应用层兜底)。
- 6 位码 = 10^6 空间,配合单次 + 5 次 + 10min,在线爆破期望不可行;若要更强可改 8 位(改一行)。

## 下一步

- M3:公网通路文档化(Caddyfile + launchd/autossh 隧道保活 + /pair 限速示例)。
- 真机扫码配对实测(相机 → /pair → cookie → PWA 安装)。

## 追加:配对逻辑正交化(commit 4f7a0cc)

用户 review:QR 编 `/pair?code=xxx` = 「10 分钟版 token-in-URL」,扫码即进,泄二维码/URL 即泄秘密,配对码形同虚设。**正解:QR 只载地址(到哪去),码只经手输(证明授权),两通道正交。** 配对表单同步改 POST(码走请求体,不进 URL/历史;提交后地址栏干净,E2E 实证)。GET /pair?code= 保留供测试/程序化路径。

## 追加二:配对升级 2-of-2(sid + code)

用户再 review:QR 纯地址后,6 位码成了唯一秘密——瞄到码即可在基址配对。升级为两通道 2-of-2:配对 attempt 携带 128 位 sid;QR/复制链接 = `/pair?sid=…`(高熵,数字捕获才可能泄);码只在该 sid 的输码页有效;无 sid 的 `/` 变纯说明页(无输码框)。泄链接(无码)进不去;瞄码(无 sid)无处输;两者同屏全泄才致命(与之前一致,不可防)。GET /pair?code= 移除(码彻底不进 URL);E2E:基址无输码框、sid 页输错码报错、对码配对且 URL 无 code。

## 追加三:PWA 修复——maskable 图标 + 未配对死路恢复

用户实测:①splash 图标是难看的矩形;②**独立 PWA 窗口无地址栏,未配对启动卡死在说明页**(贴不了链接、输不了码)。
- 图标:原图内容半径 1.25× 安全区,Android 不做圆形 mask 才显示成方框。生成 maskable 变体(画作缩至 78% 合成满幅深底)+ manifest 声明 `purpose: "maskable"`(192/512)。
- 死路:未配对根页改为**粘贴配对链接/sid 恢复入口**——内联 JS 解析 `sid=<32hex>` 或裸 sid 跳转 sid 输码页,全程不出 PWA 窗口;2-of-2 不变(此页无秘密,只解析用户提供的)。E2E:无效输入报错不跳 ✓ 粘贴完整链接→sid 页→输码→进 app ✓。

## 追加四:PWA 重开要求重配对(root cause)+ 配对页扫码

**用户报告**:已配对过,重开 PWA 又要配对。排查:服务端会话存活且在被刷新(ListSessions lastSeen 1m ago)→ 会话未丢,是**客户端 cookie 未随请求发出**。根因:`SameSite=Strict` 在「无同站发起上下文的首航导航」(启动器冷启动已安装 PWA / 经相机等应用链接进入)会被丢弃。修:session cookie 改 **Lax**——仍拦截跨站 POST 携带,而我们 binding 面全是同源 fetch,CSRF 面不变。curl 实证 Set-Cookie: SameSite=Lax; Max-Age=31536000。

**配对页扫码**(用户提议,32 位 sid 手输太长):根页加「扫描二维码」按钮——`BarcodeDetector` + `getUserMedia`(后置摄像头,300ms 轮询);扫到后**只取 sid 在当前 origin 内跳转**(不跳 QR 里的完整 URL,避免跨 origin 飞出 PWA 窗口);iOS 等不支持引擎自动隐藏按钮,粘贴路径保留。需 HTTPS(相机权限要求安全上下文)。
