# Review #28951 — #182 staged 占位溢出修复(前端面) ✅ APPROVE

- **日期**: 2026-09-02
- **角色**: fe-reviewer
- **对象**: `99d314e`(`fix(frontend): clamp schedule staged placeholder against mobile overflow (#182)`),对上轮 review #28950(见 `2026-09-02-schedule-staged-placeholder-review-182.md`)唯一阻塞项(EN 占位文案 337px 溢出 320px 行预算 → `.chat-footer` 横向滚动条)的修复。

## 起因

上轮 review REJECT:常驻空态占位引入移动端回归——EN 占位文案 57 字符在 mono 10px 下 ~337px,超出 320px 视口的行预算(320−56 面板 padding−24 item chrome=240px),`.chat-footer`(`overflow-y:auto` 隐式计算 `overflow-x:auto`)出现横向滚动条。coder 按反馈做两段式修复:缩文案 + CSS 结构性 clamp + 文案预算回归测试。

## 审查范围与方法

按「类型补丁」反相追踪:从每个新增物(文案 key、`.placeholder` clamp、`line-height` 移动端规则、预算测试)的定义点出发逐个确认真实消费端,再在真实 Chromium 里用**真组件 DOM + 真 index.css** 复测几何(happy-dom 无布局引擎,矩形模型锁不住真实 CSS,必须实测)。探测方法:bun test 内 mock `react-i18next` 挂真 `en.json`/`zh.json` 资源,挂载真 `QueuePanel` 点开 Schedule 行序列化 DOM(空态 + chip 态),嵌入真 `index.css` 的静态页,浏览器按 320/375/768/1280 逐场景量测;另构造 90 字符超长占位验证 clamp 结构性兜底。

## 逐项验证

1. **文案缩窄(上轮阻塞项)**:`en.json` `schedulePendingEmpty` → "Pick a preset or a time to preview"(34 字符)。实测 320px 下占位 `scrollWidth`=202px < 可用 213px,**不触发 clamp、footer overflow=0**;ZH 16 字 159px 同样富余。375/768 同结论。
2. **CSS 结构性 clamp**(`index.css:1803-1814`):`display:block`(text-overflow 对 flex 匿名文本项无效,须块化)+ `flex-shrink:1`/`min-width:0`(覆盖共享 chip 类的 `flex-shrink:0`)+ `overflow:hidden` + `text-overflow:ellipsis`,`white-space:nowrap` 继承自共享类。90 字符注入实测:span 523px→ellipsis 收进 213px,**footer overflow=0**,回归路径被结构性封死。宽度链完整:`.queue-item-edit`(`flex:1;min-width:0;flex-wrap:wrap`)→ `.queue-schedule-staged-row`(`flex-basis:100%;min-width:0`)→ clamp span。
3. **零跳变契约保持**(#144 不变量):实测占位↔chip 等高——≤768px 均 22px(`min-height:22px; line-height:22px` 居中 10px 字形),桌面均 16px;chip 与占位 swap 前后 row 高恒定(22/16)。chip 自身 `line-height` 14.5px 但高度由 ✕ 按钮撑到同值,几何一致。
4. **i18n 双语同步**:en/zh 均有 `queue.schedulePendingEmpty`;既有 leaf key 集合一致性测试仍在跑。新预算测试锚定阈值(EN≤40 latin / ZH≤24 CJK ≈ 240px 预算),当前值 34/16 留有余量——是「锚定值」断言(上限阈值),非字段存在性断言。
5. **组件正确性**(`QueuePanel.tsx`):`stagedVisible` 三元保持;空态渲染 `queue-schedule-pending-placeholder`(display-only,无 ✕ 无 tooltip,符合规格);Reset 常驻 + `visibility:hidden`(宽度保留、脱离 hit-testing 与 a11y 树/Tab 序);Save 仍整行收起,非编辑项不加高(mount 测试钉住)。无新增 `title` 属性(§4.5 约束不破)。
6. **测试**:4 个触及测试文件 `bun test --isolate` 28 pass 0 fail;占位 mount 测试断言锚定值(textContent 精确 key、高度常量、`style.visibility` 精确字符串)。

## 三端覆盖(§4.7)

后端无改动,binding 不涉。前端改动=纯 CSS 基线属性(display/flex/overflow/text-overflow/line-height/min-height,无实验特性,WebKit/WebView2/Chromium 行为一致)+ 文案。本轮在 Chromium 实测 320–1280 响应式全带宽(覆盖远程浏览器与 PWA 断点语义);桌面 GUI(WebKit)走同一 CSS 路径,无平台分叉属性,低风险判定;`isRemoteClient()` 守卫与 WS 事件流不涉。像素级桌面 diff 不适用(占位行本行为新增产物,上轮已核桌面零跳变语义)。

## 环境备注(非本 diff 问题)

worktree 未装 `node_modules` 且未生成 `frontend/bindings`(wails3 codegen),`tsc --noEmit` 报 3 条 bindings 缺失——`bun install` 后仅剩该 3 条,均指向本次未触及的文件(`filePanelCache.ts`/`termRegistry.ts`/`chatservice-mock.ts`),属 worktree 引导态,不构成阻塞;触及面经 bun test 编译执行全绿。

## 结论

**APPROVE**。上轮唯一阻塞项已修复且有真实浏览器几何证据;结构性 clamp 把同类回归封死;测试锚定到位。按流程停 completed-ready:不 push、不关 issue。

## 下一步

- coder 流程侧收尾(completed-ready 状态流转)。
- 超长 clamp 场景已有结构兜底 + 预算测试双保险,无需追加动作。
