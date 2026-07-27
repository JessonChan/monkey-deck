# 2026-07-27 HarnessSettings 能力矩阵收进按钮(ChartBar + popover)

## 起因

Task #23440。Task #23416 已在 HarnessSettings 每行下方常驻渲染一行能力矩阵 chip
(`CapabilityChips`,9 位 ✓/✗ wrap)。问题:harness 行本就密(名 / id / 安装徽标 / 命令 /
版本 / 升级按钮),chip 行常驻 + wrap 让行高变化、视觉重;能力位是「按需查看」的详情,
不必常驻。本 task 把它收进一个 ChartBar 触发按钮,popover 展开。

## 核实能力矩阵已落地(先做)

`frontend/src/components/HarnessSettings.tsx` 已有完整实现:
- `CAP_BITS` 常量(9 位)、`caps` state + `reloadCaps()` + `chat:harness-capabilities` 订阅。
- `HarnessRow` 收 `cap` prop、`CapabilityChips` 三态(probing / failed / chip 行)。
- 后端 `ListHarnessCapabilities` / `ProbeCapabilities` / 事件齐全(worklog 2026-07-26-capability-matrix-*)。
→ 直接做「收进」,无需补能力矩阵本身。

## 形态选式(coder 判断,§5.3 / §4.6)

- **popover(非 collapsible)**:collapsible 展开会撑高本行、挤压相邻 harness 行;popover
  浮在之上不顶布局,信息按需查看。Radix `@radix-ui/react-popover` 已在 Composer 用(§5.3
  references 优先 / 成熟库优先),三端已验证(§4.6)。
- **触发按钮位置**:`harness-row-acts`(与升级按钮同行),信息查看型操作归一处,行高恒定。
- **ChartBar 图标(非 Info)**:lucide-react `ChartBar`(已核实导出存在),「矩阵 / 指标」语义
  比通用 `Info` 更贴(task 提示「ChartBar/Info」二选一,选 ChartBar)。

## 三态(尊重数据源 / 不误判,与原 CapabilityChips 一致)

- `cap undefined`(后端探测未就绪)→ 禁用按钮 + spinner,tooltip「能力检测中…」。
- `cap.probeErr` 非空(探测失败)→ 禁用按钮 + AlertCircle(红),tooltip 含 ProbeErr(§1.6)。
- 就绪 → ChartBar 按钮,点击 popover 向左展开(`side="left"`,触发钮在行右侧)完整 chip 行。
  chip 三态不变:declared 位 ✓/✗;observed 位(emitsUsage/emitsPlan)undefined = 中性「未观测」。

## 改法

### A. HarnessSettings.tsx(改)

- import 增 `* as Popover`(`@radix-ui/react-popover`)+ `ChartBar`(lucide-react)。
- `HarnessRow`:`harness-row-main` 内的 `<CapabilityChips>` 删除(改注释说明已收进);
  `harness-row-acts` 首项(升级按钮之前)加 `<CapabilityMatrixButton cap harnessId />`。
- 新增 `CapabilityMatrixButton`:三态分支(probing / failed / 就绪),就绪态 `Popover.Root`
  + `Trigger`(ChartBar 按钮)+ `Portal`/`Content`(`side="left"` + Arrow + 标题 + `CapabilityChips`)。
- `CapabilityChips` 瘦身:删除 probing/failed 分支(已由按钮承担),只渲染 chip 行;
  `cap` 入参由 `CapabilityMatrix | undefined` 收紧为 `CapabilityMatrix`(调用方保证就绪)。

### B. i18n(zh.json + en.json)

- `capability` 块新增 `matrixTitle`(popover 标题「能力矩阵」)+ `matrixBtnTip`(触发钮 tooltip)。

### C. index.css(改)

- 删 `.harness-cap.probing` / `.harness-cap.failed`(旧常驻 chip 行的检测态样式,不再用)。
- `.harness-cap` 去掉 `margin-top`(原常驻行间距,popover 内不需要)。
- 新增 `.harness-cap-trigger`(紧凑图标钮 26×26)+ `.probing` / `.failed` 变体。
- 新增 `.harness-cap-popover`(Radix Content:向左浮,padding/阴影/箭头)+ pop-in 动画 + 标题样式。

## 改了哪些文件

- `frontend/src/components/HarnessSettings.tsx`(改:Popover/ChartBar import + 删内联 chip +
  新增 CapabilityMatrixButton + CapabilityChips 瘦身)
- `frontend/src/i18n/locales/zh.json`(改:capability.matrixTitle / matrixBtnTip)
- `frontend/src/i18n/locales/en.json`(改:同上)
- `frontend/src/index.css`(改:harness-cap-trigger / popover 样式,删旧 probing/failed 行样式)

## 验证

- `npm run build`(tsc + vite):零 TS 错误(ChartBar 导出已核实存在)。
- `bun test --isolate`:139 pass / 0 fail(含既有 HarnessUpdateAwareness 9 例,无回归;
  该测试 mock ListHarnesses 返 [],不渲染 HarnessRow,不受影响)。
- `go build ./...` / `go vet ./...`:clean(未改后端)。
- testid 兼容:probing(`harness-cap-probing-${id}`)/ failed(`harness-cap-failed-${id}`)/
  chip(`harness-cap-${id}` + `-${bit.key}`)testid 全保留(从旧 chip 行迁到新按钮 / popover 内),
  未来可测。新增 `harness-cap-trigger-${id}` / `harness-cap-popover-${id}`。

## 下一步

- 若后续要让 emitsUsage / emitsPlan 真填值:开后端 `withProbe=true`(当前默认 false,零 token)。
- model-select / mode / effort 入口显隐门控可统一从 matrix 取(替换零散 SupportsImage 单点判定)。
