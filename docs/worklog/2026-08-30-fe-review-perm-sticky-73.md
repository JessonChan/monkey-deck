# 2026-08-30 fe-review 复审 #28418 权限 sticky+声音+超时策略开关(前端面)——APPROVE

## 起因

审 #28418(0710caf 后端 + 1581106 前端,worklog c2dfb3d),对父 issue #28417 规格五点
反向实证(基线 main=c2dfb3d,本分支 agent/fe-reviewer/1b819233)。

## 结论:**APPROVE**(0 × P0/P1/P2,3 × P3 备注,不阻塞)

## 五点规格反向实证(从定义点追到消费端,非顺作者叙事)

**① sticky dock 布局不变量** ✅
- 卡确实移出滚动流:`.chat-body`(ChatView.tsx:788,`overflow-y:auto`)内 `cv-tail`
  只剩占位行;`permission-dock`(ChatView.tsx:909)是 `.chat-body` 与
  `chat-footer`(:913)之间的 flex 兄弟区;`.chat-view` 是 `flex-direction: column`
  (index.css:476)——布局结构保证「响应前永在视野」,无 `position: sticky` hack。
- 占位行 `data-testid="permission-placeholder"`(button,:837)onClick →
  `focusPermissionCard`(:622):`scrollIntoView({block:"nearest"})` + `focus()`;
  卡根 `tabIndex={-1}`(PermissionCard,:1757)可聚焦,focus 描边
  `.permission-dock .permission-card:focus`(index.css:1211)。
- CSS 复用 permission-card 家族(index.css:1209-1221,`--amber`/`--r-sm` 同族 token,
  dock 只补水平 padding + focus 描边)。
- mount 测试断言锚定值非字段存在:`body.contains(dock) === false`、硬滚动后
  `toBe(card)` **节点同一性**、点击后 `document.activeElement === card`、无权限双 null。

**② 超时策略开关** ✅
- `PermissionSettings.tsx:46-59`:乐观更新→失败回滚+报错;初始拉取 `v === "allow"`
  映射(其余含空/未知视图都落 deny,与后端 normalize 对齐);`role="switch"` +
  `aria-checked` + `data-testid="settings-perm-timeout-allow"`。
- i18n zh/en 两侧同步:zh.json/en.json:220 `chat.permPendingPlaceholder` +
  :705-707 `settings.perm.timeout{Title,Desc,Tip}`(文案含「关闭(默认)拒绝」)。
- 持久化走 settings KV `permission_timeout_policy` 既有通路;重启生效由后端
  `startLive` 装配保证(chat.go:1686)。

**③ 到达提示音恰一次** ✅
- `notifySound.ts:72-78`:seen-id 集合首见判定 + `isNotifySoundEnabled()` 门;
  **开关关闭也登记**(测试实证 perm-d:关→静音;中途开→同 id 重发仍静音;新 id 正常响);
  空 id 忽略。
- App.tsx:612 在 `chat:permission` 处理器 **popout 过滤内**(:609 同一守卫,
  popout session 主窗口不响,与权限卡不双弹一致)。
- 测试断言真实发声路径:假 AudioContext 计 `createGain` 次数(非仅返回值)。

**④ worklog 调研结论核实** ✅(本机独立验证,非复述)
- go.mod 实为 `wails/v3 v3.0.0-alpha2.106`;module cache 源码 grep:`badge` 仅命中
  `mobile_features_ios.m`(iOS 移动特性,非 macOS dock);
  `requestUserAttention|dockBadge|setBadge|requestAttention` 全仓 0 命中;
  `webview_window_darwin.go:1273-1275` Flash 显式 no-op("Not supported on macOS")。
  降级不引 objc 桥的结论成立。

**⑤ bindings 与后端一致性** ✅
- 本 worktree 全新 `make bindings`(wails3 alpha2.106)重生成成功:
  `GetPermissionTimeoutPolicy(): $CancellablePromise<string>`(ByID 1295100764)、
  `SetPermissionTimeoutPolicy(policy: string): $CancellablePromise<void>`
  (ByID 2342019584)——与前端消费(`v === "allow"` / `next ? "allow" : "deny"`)
  及后端 0710caf 签名逐字对齐。后端语义(默认 deny/装配/持久化)不在本卡范围。

## 独立重跑(非复述 gate)

- `bun install` + `make bindings` 后全新跑:`bun run test` ✅ **469 pass / 0 fail**
  (64 文件,7611 expect)——与 worklog 声称逐字一致(stderr 里 minSize/maxSize/
  collapsible 等 React DOM prop warning 为 Sidebar 既有噪音,与本改动无关)。
- `bun run build`(tsc + vite production)✅ 1.07s(chunk >500kB warning 为既有提示)。

## 负向回绑实验(两例,scratch 跑完即删,未入库)

1. **响应后移除**(规格①「响应后 dock 与占位行均应移除」,现有 4 例只锁无权限挂载态,
   未锁**转换态**):mount 有权限 → 重渲染 permission=null → dock 与占位行**双双移除**
   ✅(二者同键 `props.permission`,移除原子)。
2. **开关失败回滚**(commit 声称乐观更新失败回滚,无测试覆盖):mock
   `SetPermissionTimeoutPolicy` reject → 点击后 `set:allow` 已发、`aria-checked`
   保持 `"false"`、错误文案上屏;后端恢复后再点 → `aria-checked` 翻 `"true"` 且
   持久 ✅。

## P3 备注(不阻塞,建议后续收编)

1. 实验一(响应后移除转换态)值得收编进 `ChatView.permission-sticky.mount.test.tsx`
   锁回归——当前测试只锁「无权限不渲染」,没锁「有→无转换」。
2. `PermissionSettings` 开关无专属测试文件(回滚行为本轮仅 scratch 实证)。
3. 提示音无 `document.hidden` 门(与 `appBadge.bump()` 的 hidden 门不同)——规格③
   只要求「恰一次 + 开关门」,实现即规格,非偏差;若后续嫌前台可见时也响可加
   visibility 门,记 OPEN 不动代码。

## 三端说明(§4.7)

改动为常规 DOM + 既有 CSS 家族 + App 全局事件层:桌面 GUI(bindings 直调)本轮
bindings 重生成 + mount 测试实证;远程浏览器/PWA 同一 React 树,事件通道
(Wails event / WS)同语义,占位行/开关无 hover 专属依赖(tooltip 走 react-tooltip,
触屏点按等价);`bun run build` 过 = 三端共享产物可构建。真机/浏览器端无专属分支
改动,未做像素 diff(非「桌面零修改」类验收,桌面布局改动本身即需求)。

## 验证

- 五点规格逐条反向实证(见上),gate 与声称一致(469/0 + build ✅)。
- 负向回绑实验 2/2 过(scratch 已删,工作区干净)。
- 本 worklog 单独 commit(docs 与代码分离,§6.2);不 push,不关 issue,停 completed-ready。

## 下一步 / OPEN

- P3 三条(测试收编 ×2、visibility 门 OPEN)留给后续 task,不在本卡扩大范围。
- 后端语义面(默认 deny、装配、持久化测试)由后端审卡另行覆盖。
