# #182 Schedule staged 槽常驻占位(展开期恒渲染,首点预设零跳动)

日期:2026-09-02
状态:完成(代码 + 测试)

## 起因

QueuePanel 定时编辑行(#130 系列)的 staged 槽行与显式 Reset 按钮都是**条件渲染**(`stagedVisible && …`):行刚展开时两者都不存在,首次点预设才插入。插入瞬间引起布局跳动(readout 行凭空出现、Reset 按钮把行高撑开),与 #144「预设按钮 rect 恒定」的不变量只在「第二次及以后的点击」上成立——**首次点击**恰恰是跳动的。

## 改法(仅渲染条件,staged/Save/Reset 业务逻辑零改动)

`frontend/src/components/QueuePanel.tsx`:

1. **staged 槽行恒渲染**:删掉外层 `stagedVisible &&`,槽行(`queue-schedule-staged-row`)在编辑行展开期间始终存在;行内改 `stagedVisible ?` 分支——staged 时渲染现有 readout(`queue-schedule-pending`,含 ✕),否则渲染同形制占位 `queue-schedule-pending.placeholder`,文案 `t("queue.schedulePendingEmpty")`,纯展示(无 ✕、无 tooltip、无交互)。
2. **Reset 按钮恒渲染**:删掉 `stagedVisible &&`,按钮始终是 actions 行最后一个孩子;空态加 `style={{ visibility: "hidden" }}` 占位——位宽恒定、不参与命中测试与 a11y 树,preset 按钮从第一次点击起就零位移(#144 不变量扩展到首点)。
3. **Save 收起照旧**:`saveSchedule` 仍 `setSchedulingId(null)`,整条编辑行(连同常驻槽)卸载——常驻仅限编辑行展开期间,未编辑的队列项不加高。数据流(`presetSchedule`/`resetStagedTime`/`resetStaging`/Save 复验)一字未动。

CSS(`frontend/src/index.css`):

- 新增 `.queue-schedule-pending.placeholder`:继承 chip 的同形制盒(mono 10px inline-flex),仅覆写声音——`color: var(--text-3)` 淡色 + `font-weight: 400`——并钉 `min-height: 16px`(chip 高度由 ✕ 按钮决定:10px 字形 + 2×3px padding),readout 换进换出行高不变。
- ≤768px 断点补 `min-height: 22px`(触屏 ✕ padding 6px,chip 22px),移动端同享零跳动契约。

i18n:`queue.schedulePendingEmpty` zh「选择预设或时间后此处显示定时预览」/ en "Pick a preset or a time to see the schedule preview here",两文件同步(locales.test.ts 的 leaf key 集合一致断言守护)。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/components/QueuePanel.tsx` | 槽行/Reset 恒渲染 + placeholder 分支;`stagedVisible` 语义注释更新 |
| `frontend/src/index.css` | `.queue-schedule-pending.placeholder` 桌面 + ≤768px 两条规则 |
| `frontend/src/i18n/locales/zh.json` / `en.json` | `queue.schedulePendingEmpty` |
| `frontend/src/components/QueuePanel.schedule-trio.mount.test.tsx` | #144/#145/#146 断言更新到常驻语义(详见下) |
| `frontend/src/components/QueuePanel.schedule-staged-placeholder.mount.test.tsx` | 新增:#182 专属 mount 测试 |

## 测试

新增 `QueuePanel.schedule-staged-placeholder.mount.test.tsx`(scaffolding 同 trio 测试:happy-dom + fake flow model `getBoundingClientRect` + fake i18n):

1. **展开即占位**:打开 Schedule 行 → 槽行存在、`queue-schedule-pending-placeholder` 文案为 key、无 live readout、placeholder 无 ✕;点预设 + Save 提交后整行(含常驻槽)卸载、`onSchedule` 恰一次。
2. **只占一行**:两个队列项、仅一行处于 schedule 态时,`queue-schedule-staged-row` 全局恰 1 个——未编辑项不加高。
3. **首点零跳动(#144 扩展)**:占位态记录槽/内部 span 的 rect 高 → 首次点预设 readout 切入(`schedulePending:mins=5`)、高度恒定 → 继续累加、Reset 回占位,高度全程恒定(fake model 按共享类 `.queue-schedule-pending` 给恒定高;槽若被重新条件渲染会塌缩成 0 被断言抓住)。
4. **Reset 占位态 hidden、staged 后可点**:空态 `style.visibility === "hidden"`;点预设后可见;点 Reset 清 staged、`onSchedule` 零调用、行保持展开、回占位、Reset 复隐。

既有 trio 测试(#144/#145/#146)断言随常驻语义更新(意图不变、不变量不放松):

- #144 不变量测试:Reset 点击后原「staged-row 为 null」改为「staged-row 持在、placeholder 回归、无 live readout」;预设 rect 恒定断言原样保留。
- #145/#146 显式 Reset 测试:空态原「Reset/staged-row 为 null」改为「Reset 在场但 visibility:hidden、槽行持在、placeholder 在场」;Reset 后同样改断言为常驻语义;staged 清空、不提交、输入框回弹默认值、预设重新基于 now 等原有断言全部保留。

## 验证

- 门禁:`bun test --isolate` 全绿(541 pass / 0 fail,76 文件);`bunx tsc` 零错误。
- 后端零改动(binding 无签名变化,`make bindings` 产物与库内一致)。
- 红线自查:staged/Save/Reset 业务逻辑与数据流未动;#144/#145/#146 布局不变量保持且扩展到首点。

三端说明(§4.7):改动落在 ≤768px 断点内外的共享组件样式与渲染条件——桌面 GUI(>768px)布局形制不变,变化仅是「展开编辑行时槽行/Reset 恒在场」(占位态淡色提示 + 隐形 Reset 位),三张脸共享同一份 React 前端,渲染条件分支一致;远程浏览器与 PWA 端无 `isRemoteClient()` 守卫、无事件通道改动,PWA 的 22px min-height 已由 ≤768px 规则覆盖。本次未做真机/浏览器实测(纯 mount 测试 + 类型门禁),M2 响应式断点未触碰。

## 下一步

- 无遗留。#182 可关闭(由 orchestrator 处置)。
