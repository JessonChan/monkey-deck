# 2026-07-27 删 NewSessionModal 的 NsCapabilitySummary 组件

## 起因

Task #23439:NewSessionModal 删 `NsCapabilitySummary` 组件 + 引用(先核实是否存在,
orchestrator 备注「main 零命中可能只在 goose-exp/coder 分支」)。

## 核实结果

`NsCapabilitySummary` **在 main 与当前分支都存在**(task 备注的猜测不成立):
- `frontend/src/components/NewSessionModal.tsx`:组件定义 + 在 harness 列表项内渲染。
- `docs/worklog/2026-07-26-capability-matrix-ui.md`:历史日志提及(只读归档,不动)。

该组件在 NewSessionModal 内显示 model + usage 两位精简能力摘要,**与
HarnessSettings(HarnessPane)的完整能力矩阵功能重叠**;弹窗本应轻量,能力详情
留给设置面板,NewSessionModal 不再二次展示。

## 改法

- **NewSessionModal.tsx**:
  - 删 `NsCapabilitySummary` 函数定义。
  - 删 `<NsCapabilitySummary cap={cap} harnessId={h.id} />` 渲染。
  - 删随之失效的 `const cap = harnessCapabilities?.[h.id];`、`harnessCapabilities?` prop、
    `CapabilityMatrix` 类型 import。
  - 列表 `harnesses.map` 由 `{... return (...)}` 简化为 `(...) => (...)`(无需中间变量)。
- **App.tsx**:删 `<NewSessionModal>` 的 `harnessCapabilities={harnessCapabilities}` 透传。
  - `harnessCapabilities` state **保留**:Sidebar(能力徽标)、HarnessSettings 仍在用。
- **index.css**:删 `.ns-cap-summary` / `.ns-cap-bit{yes,no,unknown}` 死样式
  (全项目仅 NsCapabilitySummary 引用,组件删后即孤儿)。

i18n key(`capability.model` / `capability.usage` / `*.Tip` / `supported` /
`notSupported` / `notObserved`)**保留**:HarnessSettings 通过 `t(\`capability.${bit.key}\`)`
动态复用,删了会炸。

## 改了哪些文件

- `frontend/src/components/NewSessionModal.tsx`(删组件 + prop + import + 渲染)
- `frontend/src/App.tsx`(删一处 prop 透传)
- `frontend/src/index.css`(删 6 行死样式)
- `docs/worklog/2026-07-27-remove-ns-capability-summary.md`(本条)

## 验证

- `wails3 generate bindings`(生成 frontend/bindings/,gitignored)。
- `cd frontend && bun install && bun run build`:✓ 通过(tsc + vite production build,
  仅 chunk size 提示,无关)。
- `go build ./... && go vet ./...`:✓ 通过(仅 macOS SDK 版本 linker warning,预存在、无关)。
- `git grep NsCapabilitySummary`:源码零命中,仅 worklog 历史条目(§0.3 只读归档)。

## 下一步

无。NewSessionModal 回归「纯选择 harness + worktree」轻量形态;能力详情统一入口
为 HarnessSettings / Sidebar 徽标。
