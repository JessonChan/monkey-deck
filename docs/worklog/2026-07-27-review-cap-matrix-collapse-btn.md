# 2026-07-27 Review #23440 能力矩阵收进 ChartBar 按钮 + popover

## 起因

Task #23442:frontend reviewer 角色 review Task #23440(`feat(harness): 能力矩阵收进
ChartBar 触发按钮 + popover`,commit `e35806c` + worklog `2a5b2f4`)。本条记 review 结论与
唯一一处落地修改。

## review 验证项(逐条对着 anti-pattern checklist 走)

- **构建 / 测试**:`wails3 generate bindings` 补 bindings → `bun run build` 零 TS 错;
  `bun test --isolate` 139 pass / 0 fail。
- **消费链路(「类型补丁」反模式重点,§5.3)**:
  - `CapabilityMatrixButton` 的 `cap` / `harnessId` 两 prop 逐跳肉眼确认真实消费:
    `!cap`→probing 早返回;`cap.probeErr`→failed 早返回(tooltip 用上);就绪态 `cap` 透传
    给 `CapabilityChips`。`harnessId` 流到 5 处 testid(probing/failed/trigger/popover + 下传)。
  - `CapabilityChips` 入参由 `CapabilityMatrix | undefined` 收紧为 `CapabilityMatrix`,
    唯一调用方(CapabilityMatrixButton 就绪分支)经两次早返回天然 narrow,**无第二调用方**
    (grep 确认),收紧安全、无 orphan 类型。
- **i18n 双语同步**:`capability.matrixTitle` / `matrixBtnTip` zh/en 都在;回引的 `probing` /
  `probeFailedTip` / `supported` / `notSupported` / `notObserved` 及 per-bit key 双语齐全。
- **CSS 变量**:新样式 `--bg` / `--elev` / `--elev-2` / `--sep` / `--sep-strong` / `--hover` /
  `--text(-2/-3)` / `--red` / `--r-md` / `--shadow-pop` 全部在 `:root` 定义。z-index 沿用
  `cfg-popover-content`「Radix 默认」范式(与 Composer 一致,非新引入问题)。
- **依赖 / icon**:`@radix-ui/react-popover` 已在 package.json(Composer 在用);`ChartBar`
  是 lucide-react 合法具名导出(查 d.ts + 运行时 `typeof === 'object'`)。
- **可访问性(§4.2/§4.5)**:三态 testid 全留(probing/failed/trigger/popover);触发钮是 `<button>`
  键盘可达;Radix popover 默认 Esc 关闭;tooltip 走统一 `react-tooltip`(md-tip),无原生 title。

## 唯一落地修改

`HarnessSettings.tsx:383` 注释与代码不符:注释写「禁用 + spinner + ChartBar」,但 probing 分支
只渲染 `<RefreshCw className="spin">`,并无 ChartBar。代码是对的(spinner 表「进行中」UX 合理),
注释撒谎。改成「禁用 + spinner(tooltip 提示『能力检测中…』)」。注释 / 文档撒谎是维护隐患,
reviewer 顺手纠。

## 非阻塞观察(记 OPEN,不改)

- **测试空白**:`CapabilityMatrixButton` 三态分支 + popover 渲染无单测(既有
  `HarnessUpdateAwareness` mock `ListHarnesses` 返 `[]`,根本不渲染 HarnessRow)。但本次是
  UI 外壳搬迁(chip 行 → 按钮 + popover),`CapabilityChips` 的 ✓/✗/unknown 状态机逻辑未变、
  搬迁前也未覆盖,回归风险低。后续若给能力矩阵补「真值流到 chip」的回归测试(锚定值,§5.3),
  顺带覆盖三态即可,不阻塞本 PR。
- **trigger 同时挂 tooltip + 是 popover 触发钮**:popover 开启时 hover 触发钮仍会弹 tooltip,
  极端情况下 tooltip(z-index 70)可能压在 popover 之上。Radix 默认 z-index 范式下的既有现象
  (cfg-popover-content 同款),非本 PR 引入,留待统一处理。

## 改了哪些文件

- `frontend/src/components/HarnessSettings.tsx`(改:probing 分支注释纠误)
- `docs/worklog/2026-07-27-review-cap-matrix-collapse-btn.md`(新增:本条)

## 验证

- `bun run build`:零 TS 错。
- `bun test --isolate`:139 pass / 0 fail。

## 结论

**PASS**。Task #23440 代码层面正确,消费链路干净,无类型补丁 / orphan 字段;i18n / CSS / 依赖 /
可访问性齐备。仅注释纠误一处落地改动。

## 下一步

- 能力矩阵三态 + chip 真值流的回归测试(见「非阻塞观察」),可下个 task 顺手做。
