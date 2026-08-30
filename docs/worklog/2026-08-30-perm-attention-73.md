# 2026-08-30 权限弹窗 sticky 常驻 + 声音 + 超时默认 deny 接线(#73 / Task #28418)

## 起因

父 issue #28417 四点拍板定版:①PermissionCard 移出时间线流 → composer 上方 sticky
常驻,时间线留可点击占位行;②权限超时默认改 deny + Settings 暴露 allow/deny 开关;
③权限到达 playNotifySound 恰一次(尊重 notifySound 开关);④dock badge/attention
卡内调研 wails3 alpha2.106,不可行则降级不引 objc 桥。

现状问题:权限卡渲染在 `cv-tail`(滚动容器内的时间线尾部),历史一长就被滚出视野,
「响应前永在视野」不成立;超时降级默认 allow(没人点就放行,对写/执行类操作偏危险);
权限到达无声音提示。

## 根因 / 设计

- **sticky 常贵的布局不变量**:卡从滚动容器(`.chat-body` 内 `.cv-tail`)移出,成为
  `.chat-body` 与 `<footer class="chat-footer">` 之间的 **flex 兄弟区**
  (`.permission-dock`)——不靠 `position: sticky` hack,布局结构天然保证「时间线滚多远
  卡都在视野」。时间线尾部留一枚虚线占位行(`.perm-placeholder`,「权限待确认」),
  点击 `scrollIntoView + focus` sticky 卡。视觉复用 `.permission-card` 家族原样
  (dock 只补水平 padding + focus 描边),不另起样式体系。
- **超时策略默认翻转**:`defaultPermTimeoutPolicy` `"allow"` → `"deny"`(拒绝比放行
  安全——没人裁决时不该让 agent 未经确认执行写/执行类操作);空串仍视作 allow
  (零值安全:直接 `&Handler{}` 构造的单测默认放行,不误拒)。
- **设置通路(照既有 settings KV 模式,对齐 `check_harness_updates` 三件套)**:
  settings 键 `permission_timeout_policy`,service 层 `normalizePermTimeoutPolicy`
  归一(空/未知回 deny)→ `Get/SetPermissionTimeoutPolicy` 导出方法(前端开关 +
  持久化)→ `startLive` 装配 `chat.Handler.SetPermissionRecovery(acp.DefaultPermRetries,
  s.permissionTimeoutPolicySetting())`——retries 保持既有默认(`DefaultPermRetries=1`,
  新导出常量),policy 按设置。装配期注入,活跃 session 不热更:新会话生效、重启后
  全部生效(与拍板一致)。
- **声音恰一次(主键归并,§5.3 不变量)**:harness 超时重发会再次广播**同一 prompt id**
  的 `chat:permission` 事件;`notifyPermissionOnce(id)` 以 seen-id 集合归并——只有首次
  到达(= 进入 pending)响一次,重发静默;开关关闭时到达也登记(中途开开关不补响,
  「首次到达」判定不被开关改变)。App.tsx 的 `chat:permission` 处理器内、popout 过滤
  之后调用(popout session 主窗口不响,与权限卡不双弹同一道过滤)。

## ④ dock badge/attention 调研结论(降级不实现)

wails3 **v3.0.0-alpha2.106**(go.mod 实际版本)无 macOS dock badge / attention API:

- `grep -ri badge pkg/application/` → 唯一命中 `mobile_features_ios.m`(iOS 移动端
  特性,非 macOS dock);
- `requestUserAttention` / `dockBadge` / `setBadge` / `requestAttention` 全仓 **0 命中**;
- 唯一 attention 类 API `WebviewWindow.Flash(bool)` 是 **Windows-only** 任务栏闪烁,
  macOS 实现为显式 no-op(`webview_window_darwin.go:1273` "Not supported on macOS")。

结论:引入 dock badge 需自写 objc 桥(NSApp dockBadge / requestUserAttention Cgo 封装),
按拍板**不引桥、降级 1+2(+3 声音)**:桌面端注意力兜底 = sticky 卡永在视野 + 到达
提示音;PWA 端已有 `appBadge.ts`(navigator.setAppBadge)不受影响。

## 改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `internal/acp/handler.go` | `defaultPermTimeoutPolicy` → `"deny"`;`defaultPermRetries` 导出为 `DefaultPermRetries`(chat 装配引用);相关注释同步 |
| `internal/chat/chat.go` | settings 键 + `normalizePermTimeoutPolicy` + `Get/SetPermissionTimeoutPolicy`(绑定层);`startLive` 装配调 `SetPermissionRecovery` |
| `internal/acp/handler_recovery_test.go` | +`TestPermissionTimeoutDefaultsToDeny`(出厂默认 deny + retries 默认 2 轮)、`TestPermissionWiredDefaultsDeny`(装配形态锁定) |
| `internal/chat/perm_timeout_policy_test.go` | 新建:默认 deny / Set 持久化 / 同库重建(重启)保持 / 非法输入归一 / nil store 安全 / 归一函数形状 |
| `frontend/src/components/ChatView.tsx` | 卡移出 cv-tail → `.permission-dock`(footer 上方);cv-tail 占位行;`permissionDockRef` + `focusPermissionCard`;卡根 `tabIndex={-1}` |
| `frontend/src/index.css` | `.permission-dock` + `.perm-placeholder` 样式(复用 permission-card 家族) |
| `frontend/src/lib/notifySound.ts` | +`notifyPermissionOnce(id)`(seen-id 归并 + 开关门) |
| `frontend/src/App.tsx` | `chat:permission` 处理器接 `notifyPermissionOnce(e.data.id)`(popout 过滤内) |
| `frontend/src/components/PermissionSettings.tsx` | 权限 pane +超时策略开关(复用 `settings-row` 家族;乐观更新失败回滚;`data-testid="settings-perm-timeout-allow"`) |
| `frontend/src/i18n/locales/{zh,en}.json` | `chat.permPendingPlaceholder` + `settings.perm.timeout{Title,Desc,Tip}`(两侧同步) |
| `frontend/src/components/ChatView.permission-sticky.mount.test.tsx` | 新建:sticky 在滚动容器外且硬滚动后节点不变 / 占位行存在且 cv-tail 无卡 / 点占位聚焦卡 / 无权限不渲染 |
| `frontend/src/lib/notifySound.test.ts` | 新建:恰一次 / 新 id 再响 / 开关关不响且到达已登记 / 空 id 忽略(假 AudioContext 计真实 createGain 次数) |

## 接线证明

- **超时策略**:设置 UI(`PermissionSettings` 开关)→ `ChatService.SetPermissionTimeoutPolicy`
  → `settings` KV(`permission_timeout_policy`)→(新会话/重启)`startLive` →
  `chat.Handler.SetPermissionRecovery(acp.DefaultPermRetries, s.permissionTimeoutPolicySetting())`
  → `RequestPermission` 预算耗尽走 deny 分支(`pickRejectOption` → reject 选项,无
  reject 则 cancelled)。链路两端被测试夹住:`TestPermissionTimeoutPolicySetting`
  (持久化/归一/重启)+ `TestPermissionWiredDefaultsDeny`(该装配入参下的 handler 行为)。
- **声音**:`chat:permission` 事件 → App.tsx(popout 过滤内)→ `notifyPermissionOnce(id)`
  → seen 集合首见 + `isNotifySoundEnabled()` → `playNotifySound()`;测试用假
  AudioContext 计 `createGain`(每次真实播放恰一次)。
- **绑定重生成**:`make bindings`(wails3 alpha2.106)已跑,`chatservice.ts` 含新方法,
  `tsc` 通过。

## 验证(验收 gate 全绿)

- `go build ./...` ✅(仅环境性 ld macOS 版本号 warning,与本次无关)
- `go vet ./...` ✅
- `go test ./... -count=1` ✅ 15 包全 ok,0 FAIL(含既有 `TestPermissionTimeoutDegradeDeny`
  等 handler 权限用例零回归)
- `bun test --isolate` ✅ **469 pass / 0 fail**(64 文件;含 `locales.test` zh/en key
  集合一致、既有 `ChatView.permission-hint.mount.test`(#143)零回归、新增 sticky 4 例 +
  声音门 4 例)
- `bun run build:dev`(tsc + vite)✅

三端说明:本次改动主体是布局/交互/设置面,桌面 GUI、远程浏览器、PWA 共用同一 React
树。占位行/开关均为常规 DOM + 既有 CSS 家族,无 hover 专属交互依赖(tooltip 走
react-tooltip,触屏点按等价);`notifyPermissionOnce` 在 App 全局事件层,三端事件通道
(Wails event / WS)同语义。未做像素级 diff(非「桌面零修改」类验收,桌面布局改动本身
即需求);浏览器/PWA 端回归由全量 bun test 布局 mount 用例覆盖。

## 下一步 / OPEN

- fe-review(reviewer 通过后停 completed-ready,不关 issue,硬纪律)。
- 桌面 dock badge 若后续 wails3 alpha 支持原生 API,可在其上补 badge(当前零代码占位)。
