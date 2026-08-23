# 2026-08-23 PWA 移动端体验增强(六件套)

## 起因

用户在 Android 真机装了 M2 的 PWA 后反馈"跟原生 app 没区别",追问还能加哪些 PWA 特性。
讨论后拍板六项(用户明确跳过 manifest `screenshots`),要求:体验更好、对整体架构和桌面端零影响。
全部为 manifest 字段 + 前端守卫调用 + ≤768px 条件逻辑,不动后端、不动协议面、桌面 webview no-op(M2 硬约束)。

## 做了什么(每项一个原子 commit)

1. **`fb916de` Composer 手机输入属性**:`autoCapitalize/autoCorrect/spellCheck` 全关 + `enterKeyHint="send"`(与桌面 Enter=发送一致)。
   绑定模块级 `coarsePointer`(同 App.tsx 既有模式)——桌面打字行为(含 spellcheck 波浪线)零改动。
2. **`0732b64` manifest shortcuts + `?action=` 启动引导**:`shortcuts`(New Session / Switch Project / Settings,英文,与 manifest 既有英文文案一致)
   → 长按图标快捷方式。App 启动等 projects 加载后解析 `?action=` 派发导航,`replaceState` 清参防刷新重触发。**只做静态**:
   Chrome 对 manifest 缓存激进(WebAPK 懒更新),动态"最近项目"会陈旧误导。`lib/launchAction.ts` + 测试。
3. **`063c9cd` Android 返回手势 back-stack**:此前全仓无任何 `popstate/pushState`,standalone PWA 里返回手势 = 直接退出 app,
   抽屉/弹窗开着也全丢。`lib/backStack.ts`(可注入 env 的纯逻辑)+ `hooks/useBackLayer.ts`:开层 pushState、返回手势关顶层、
   UI 关闭(scrim/Esc/按钮)走同一 remover 消费自己的历史条目——两条路径收敛到同一清理,history 与 UI 不漂移。
   push 全部 ≤768px 门控;无属主 popstate 放行默认行为(栈空 = 退出,即预期终点)。接了 5 层:抽屉/设置/新建会话/关标签/删 worktree。
4. **`3bc9f3f` 应用图标角标**:`lib/appBadge.ts`。`document.hidden` 时:自然回合结束(`detail` 以 `stopReason=` 开头,
   与提示音同一数据源区分,§5.3)或权限请求到达 → `setAppBadge` 计数;`visibilitychange` 回前台清零。
   standalone display-mode + API 存在双门控,桌面/普通标签页完全 inert。诚实定位:无 push(M4+)前的 best-effort,
   Chrome 冻结后台页后无法更新,覆盖"切走几分钟"场景。
5. **`b071d6b` 安装引导横幅**:`lib/installPrompt.ts` 捕获 `beforeinstallprompt`,`components/InstallBanner.tsx`
   顶部浮卡一键安装;iOS Safari 不触发该事件 → 降级"分享 → 添加到主屏幕"手动指引。已安装(standalone)或"暂不"(localStorage)后不再出现。
6. **`b4060e4` 消息级分享**:MessageActions 加 Share2 按钮 → `navigator.share({ text })`,取消(AbortError)静默。
   桌面 Chrome 也有该 API,故 CSS 门控 `.msg-share-btn` 基线 display:none、≤768px 才 inline-flex。
7. **`50ee108` 横幅 CSS 修复**(实测发现的 bug):banner z 70 盖过抽屉(z 60),≤768px 下抽屉顶部项目行点不了
   → 降 z 50,让 scrim(55)/抽屉(60)整体盖住 banner。

## 明确不做(守住 KISS / §7)

- Service Worker / 离线缓存:瘦客户端离线无意义;缓存旧前端 JS 对上新版后端 bindings 反而错配。无 SW 是特性。
- share_target(注册系统分享目标):需 SW + POST 端点,价值/成本比差。
- Web Push:§7 明确 M4+,零设计。
- 动态 manifest shortcuts:manifest 缓存陈旧问题。

## 改了哪些文件

- 新增:`frontend/src/lib/{launchAction,backStack,appBadge,installPrompt}.ts` + 各自测试、`frontend/src/hooks/useBackLayer.ts`、`frontend/src/components/InstallBanner.tsx`
- 修改:`frontend/public/manifest.webmanifest`(shortcuts)、`frontend/src/components/Composer.tsx`(输入属性)、`frontend/src/components/ChatView.tsx`(分享按钮)、`frontend/src/App.tsx`(back-layer×5、badge×3 处接线、深链引导、横幅渲染)、`frontend/src/index.css`(banner/share 的桌面隐藏 + 移动样式)、`frontend/src/i18n/locales/{zh,en}.json`(pwa.* + chat.share*)

## 验证

- 单测:`backStack` 7 用例(返回关顶层/UI 关闭消费自身条目/popstate 吞掉/桌面 inert/重复 id/空栈/dispose)、`appBadge` 3、`launchAction` 3、locales 校验 2,全过。
- 全量 `bun test --isolate`:240 过 / **5 失败为存量问题**(`NewSessionModal.mount.test`:组件已发 `mcpServerIDs: []` 但测试期望缺失该字段;已用 `git stash` 在基线复现确认与本次无关,未动)。
- **server 模式真浏览器双视口实证**(`go build -tags server`,127.0.0.1 显式 IPv4——localhost 在本机解析到 ::1 撞了别的进程):
  - 桌面 1280px:banner `display:none`、scrim 隐藏、会话消息 share 按钮在 DOM 但 0 可见、composer 无新属性(enterKeyHint=null)。
  - 移动 390px:banner y=48 可见可关(localStorage=1);真实点击开抽屉→`page.goBack()`(=返回手势)抽屉关闭且页面留存;设置弹层同理;
    `/?action=settings` 打开设置且 URL 被清;会话内 share 6/6 可见;touch 模拟下 composer 四属性全部生效。
  - z 修复回归:抽屉打开后项目行 `elementFromPoint` 命中 `project-main`(不再被 banner 挡)。

## 踩坑

- **多 server 实例并发**:验证时发现两个孤儿 `monkey-deck-server`(上午遗留)与新实例并发,session 行 aria 全 `[disabled]`、
  点击无反应——§5.5"桌面 app 与 server 二进制绝不并发"的场景。kill 孤儿后立即恢复。其中一个被用户会话 supervise(exit 0,即被 kill 的优雅退出)。
- **编辑事故**:调 z-index 时误把 `top:` 声明行替换掉,fixed 元素落到静态位置(恰在视口底缘 844px),靠 getBoundingClientRect 定位修复;净提交 diff 只剩 z 70→50。
- **headless Chromium 的 `(pointer: coarse)`**:改 viewport 不改变 pointer 类型,须 `page.emulate({ hasTouch: true })` + 重载(模块级 const 只评估一次)才能验证移动属性。
- **React 19 合成点击**:`dispatchEvent(new MouseEvent)` 在本项目 React 树上不触发 onClick,浏览器验证一律用真实 CDP click(aria-ref/text 选择器)。

## 下一步

- 真机(Android)复测:安装后长按图标 shortcuts、返回手势、图标角标(需后台回合结束场景)。
- 存量失败:NewSessionModal 5 个用例与 `mcpServerIDs` 契约不同步,待该功能负责人补期望值。
