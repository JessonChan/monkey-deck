# 2026-07-27 Review #23439:删 NewSessionModal NsCapabilitySummary 后遗留的死链

## 起因

Task #23441(本审查):Review #23439(删 NewSessionModal 的 `NsCapabilitySummary` 组件 + 引用)。

#23439 的显式 diff 正确、编译通过、CSS / 组件 / import 都删干净了。但它的工作日志里有
一条**保留判断**需要复核:

> `harnessCapabilities` state **保留**:Sidebar(能力徽标)、HarnessSettings 仍在用。

按 reviewer playbook「类型补丁」反模式(字段加了/留了但全链路没人消费是最高频漏报源),
**不能顺着作者叙事走**,要从字段定义点出发逐跳肉眼确认"真的被读取/渲染"。

## 根因:两条保留理由都假,App 的 `harnessCapabilities` 链已死

逐条反向追踪(用 `rg`,锚定真实消费而非"字段存在"):

1. **"HarnessSettings 仍在用" —— 假。** `HarnessSettings.tsx`(`HarnessPane`)有自己的
   `caps` state(L53)+ 自己调 `ListHarnessCapabilities()`(L88)+ 自己订阅
   `chat:harness-capabilities`。它**根本不收 App 的 prop**(不在 App 直接渲染链上,由设置中心
   承载)。其 L35 旧注释白纸黑字写「与 App 那份 harnessCapabilities state **并行存在**(两处各自拉)」
   ——「并行存在」=各自独立,不是共享。作者把"并行"误读成"消费"。

2. **"Sidebar(能力徽标)" —— 假(死 prop)。** `Sidebar.tsx` 在 Props 接口声明了
   `harnessCapabilities?: ...`(原 L45),但**全文件 493 行零读取**:`props: Props` 整体传入,
   既无 `props.harnessCapabilities`,也无解构。该 prop 注释自称「Task 3 据此按能力位门控 UI」,
   是面向未实现 Task 3 的前瞻脚手架,从未接线。

**结论**:#23439 删掉 `NsCapabilitySummary` 之前,App 的 `harnessCapabilities` state 有**唯一真实
消费者**(`NsCapabilitySummary`)。#23439 删掉它之后,这条链瞬间全死:

```
App.tsx L73  state 声明
App.tsx L349 启动 ListHarnessCapabilities() 拉取
App.tsx L350 订阅 chat:harness-capabilities 事件重拉
App.tsx L485 offHarnessCaps() 清理
App.tsx L1273 harnessCapabilities={...} 透传 Sidebar  ← Sidebar 忽略
```

即:App 维护 state、做网络拉取、挂事件订阅、驱动重渲,其值**永远到不了任何渲染输出**。
违反 AGENTS.md §5.3「Less is More / 删掉后功能不变的代码就该删」。这正是「类型补丁」反模式
的变体:作者叙述「state 保留,有人用」就停手了,没逐跳验证下游真实消费。

## 改法

把 #23439 没扫干净的死链一起删掉,让重构真正完整(纯删除,行为不变):

- **App.tsx**(5 处):
  - 删 `CapabilityMatrix` import(L18,删 state 后即孤儿)。
  - 删 `harnessCapabilities` state + 其上 3 行注释(L70-73)。
  - 删启动拉取 + `chat:harness-capabilities` 订阅 + `offHarnessCaps`(L347-352)+ cleanup
    里的 `offHarnessCaps();`(L485)。
  - 删 `<Sidebar>` 的 `harnessCapabilities={harnessCapabilities}` 透传(L1273)。
- **Sidebar.tsx**:删死 prop `harnessCapabilities?` + 其上注释 + `CapabilityMatrix` import
  (删 prop 后即孤儿)。
- **HarnessSettings.tsx**:订正 L32-35 旧注释(原写「与 App 那份 state 并行存在」已不成立;
  改为「本 pane 是前端能力矩阵的唯一消费者」,避免误导下一个读者)。

**i18n 不动**:`capability.model/usage/modelTip/usageTip/supported/notSupported/notObserved`
仍被 HarnessSettings 经 `t(\`capability.${bit.key}\`)` / `t(\`capability.${bit.key}Tip\`)`
动态复用(`CAP_BITS` 含 model/usage),zh/en 两份 locale 均在。#23439 的这条判断正确,保留。

**Sidebar 死 prop 是 #23439 之前就存在的前瞻脚手架**(Task 3),非本 PR 引入;但 #23439 删掉
唯一真实消费者使其彻底失去存在的理由,且留着它会诱导下个人误以为"已接线"(正是 #23439 工作日志
掉的坑)。YAGNI + §5.3 一并删;真到 Task 3 落地时,实现者会重新加 prop **并真接线**,反而更安全。

## 改了哪些文件

- `frontend/src/App.tsx`(删 import / state / 订阅 / cleanup / prop 透传)
- `frontend/src/components/Sidebar.tsx`(删死 prop + 孤儿 import)
- `frontend/src/components/HarnessSettings.tsx`(订正过时注释)
- `docs/worklog/2026-07-27-review-23439-dead-capability-chain.md`(本条)

## 验证

- `wails3 generate bindings`:✓(bindings gitignored,不入库)。
- `cd frontend && bun install && bun run build`(tsc + vite production):✓ 通过
  (仅预存在的 chunk size 提示,无关;index chunk 1311.31→1311.14 kB,与删死代码一致)。
- `rg harnessCapabilities frontend/src/`:源码零命中(仅本 worklog 历史条目)。
- `rg CapabilityMatrix frontend/src/App.tsx frontend/src/components/Sidebar.tsx`:零命中
  (HarnessSettings 仍正常用,它是唯一消费者)。
- i18n 键 zh/en 两份均在,且 HarnessSettings 动态消费,未误删。

## 下一步

无。NewSessionModal 回归轻量选择形态;前端能力矩阵统一为 HarnessPane 单一消费者、单一数据源,
不再有 App↔Sidebar 的死 prop 链。若将来 Task 3(per-harness 能力徽标 / model-select 门控)真要落地,
在 Sidebar 重新加 prop **并在 Sidebar 内真消费**(渲染徽标 / 门控显隐),别再留空声明。
