# 2026-07-26 前端 UI:HarnessSettings 能力矩阵列 + NewSessionModal 能力摘要

## 起因

Task #23416。Task #23414/#23415 已落地能力矩阵后端(`ProbeCapabilities` /
`ListHarnessCapabilities` / `chat:harness-capabilities` 事件 / `CapabilityMatrix` 类型含
prompt* / config* / sessionList / emitsUsage / emitsPlan 等位)与 App.tsx 接线
(state `harnessCapabilities` + Sidebar prop),但 **HarnessSettings(HarnessPane)与
NewSessionModal 没展示** 能力矩阵 —— issue DoD 的「UI 直观展示有的 harness 没模型选择 /
没 token 用量」未达成。本 task 做展示。

## 数据源选式(coder 判断,§5.3 复用)

两处各自选式,均贴近现有范式:

- **HarnessPane 自己拉**(不靠 App prop 下传):HarnessPane 由设置中心面板
  (`SettingsPanel`)承载,不在 App 直接渲染链上,prop-drilling 要穿两层(App →
  SettingsPanel → HarnessPane)。镜像它现有的「自己调 ListHarnesses」范式 +
  App.tsx:349-352 的「订阅 `chat:harness-capabilities` 重拉」范式,HarnessPane
  自己调 `ListHarnessCapabilities` + 订阅事件。与 App 那份 `harnessCapabilities`
  state 并行存在(数据源单一 = 后端;前端两份只读快照无写冲突,KISS)。
- **NewSessionModal 走 prop**(不自己拉):NewSessionModal 本就是 App 直接渲染,
  prop 已通(`harnesses` 等)。App 透传 `harnessCapabilities` 一行即可,少一次重复拉。
  issue 提示也倾向此选式。

## 能力位展示形态(coder 判断)

- **HarnessSettings:一行紧凑 chip 行**(非 grid、非 panel):HarnessRow 已较密
  (名 / id / 安装徽标 / 命令 / 版本 / 升级按钮),grid 会纵向撑高挤压;chip 行可
  wrap、信息密度高、三端一致(§4.6)。复用现有 HarnessRow 结构(§5.3),不另起
  panel。展示 9 位:`image / audio / embeddedContext / model / mode / effort /
  sessionList / usage / plan`。`resourceLink` 协议恒真,无区分度,不展示。
- **NewSessionModal:精简摘要**(非完整 grid):issue 核心诉求是「模型选择」+
  「token 用量」两项,弹窗本就轻量,只显示 `model(configModel)` + `usage(emitsUsage)`
  两个 chip,完整矩阵在 HarnessSettings 看。

## 三态判定(尊重数据源,不误判)

- **declared 位**(prompt* / config* / sessionList):来自 Initialize/NewSession 声明,
  确定 ✓(true)/ ✗(false)。
- **observed 位**(emitsUsage / emitsPlan):来自 noop Prompt 行为观测,
  `withProbe=false` 默认 **undefined** → 渲染中性「未观测」态(虚线边框 + ·),**不误判
  为 ✗**。否则在默认零 token 探测下 usage/plan 永远显示 ✗,误导用户「不支持用量上报」。
- **未就绪态**:`cap undefined`(harnessId 不在 map / 后端探测未跑完)→ HarnessSettings
  显示「能力检测中…」(带 spinner);`cap.probeErr` 非空 → 显示「上次检测失败」(带
  tooltip 含错误串)。NewSessionModal 未就绪 / 失败 → **不显示摘要**(不阻塞选择)。

## 改法

### A. HarnessSettings.tsx(改)

- 顶部新增 `CAP_BITS` 常量(`field` + i18n `key`),9 位。
- HarnessPane 新增 state `caps: Record<string, CapabilityMatrix | undefined>`,
  `reloadCaps()`(调 `ListHarnessCapabilities`,失败静默),`useEffect` 启动拉一次 +
  订阅 `chat:harness-capabilities` 重拉(cleanup 卸载订阅)。镜像 App.tsx 范式。
- `HarnessRow` 新增 `cap` prop,在 `harness-row-meta` 与 `harness-path` 之间渲染
  `<CapabilityChips cap={cap} harnessId={h.id} />`。
- 新增 `CapabilityChips` 组件:三态(un就绪 / 失败 / chip 行),每 chip 配 react-tooltip
  (`md-tip`,§4.5)说明 `<label>: <支持/不支持/未观测>\n<人话解释>`(§4.4)。

### B. NewSessionModal.tsx(改)

- Props 新增可选 `harnessCapabilities`。
- harness 列表项在 name 后、command 前渲染 `<NsCapabilitySummary cap={cap} />`。
- 新增 `NsCapabilitySummary` 组件:未就绪 / 失败 → 返回 null;否则渲染 model + usage
  两个 chip(三态同上),配 tooltip。

### C. App.tsx(改)

- `<NewSessionModal>` 透传 `harnessCapabilities={harnessCapabilities}`(已存在 state)。

### D. i18n(zh.json + en.json)

- 新增共享顶层 `capability` 块:`probing / probeFailed / probeFailedTip /
  supported / notSupported / notObserved` + 9 位的 `<key>` 与 `<key>Tip`(人话,§4.4)。
  HarnessSettings 与 NewSessionModal 复用同一块(单一事实来源)。

### E. index.css(改)

- `.harness-cap` / `.harness-cap-chip.{yes,no,unknown}` / `.harness-cap.probing|failed`。
- `.ns-cap-summary` / `.ns-cap-bit.{yes,no,unknown}`。
- 复用既有 `.spin` 动画(去重,§5.3 Less is More)。

## 改了哪些文件

- `frontend/src/components/HarnessSettings.tsx`(改:Events/类型 import + caps state +
  reloadCaps + 订阅 + HarnessRow 传 cap + CapabilityChips 组件)
- `frontend/src/components/NewSessionModal.tsx`(改:CapabilityMatrix 类型 import +
  Props 增 harnessCapabilities + NsCapabilitySummary 组件 + 列表项渲染)
- `frontend/src/App.tsx`(改:NewSessionModal 透传 harnessCapabilities)
- `frontend/src/i18n/locales/zh.json`(改:新增 capability 块)
- `frontend/src/i18n/locales/en.json`(改:新增 capability 块)
- `frontend/src/index.css`(改:harness-cap-* / ns-cap-* 样式)

## 验证

- `npm run build`(tsc + vite):零 TS 错误。
- `bun test --isolate`:130 pass / 0 fail(含既有 HarnessUpdateAwareness 9 例,无回归)。
- `go build ./...` / `go vet ./...`:clean(仅 pre-existing macOS 链接器版本警告)。
- `go test ./internal/...`:全绿(未改后端,无回归)。
- `wails3 task build`:全过(gen bindings + 前端 build + Go production build,产出
  bin/monkey-deck)。
- 不回归:harness 发现 / 版本检测 / 升级 / 选择 / 图片附件 / 发消息 代码路径均未改。

## 下一步

- 若需 emitsUsage / emitsPlan 真实填值:再开后端 `withProbe=true` 路径(当前默认 false,
  零 token),否则这两位永远显示「未观测」中性态。
- model-select / mode / effort 入口的显隐门控可统一从 matrix 取(替换当前零散的
  `SupportsImage` 单点判定),后续 task。
