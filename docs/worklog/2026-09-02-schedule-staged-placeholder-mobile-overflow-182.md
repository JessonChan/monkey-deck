# #182 审卡修复:staged 占位移动端 EN 溢出(文案缩短 + CSS 收口兜底)

- 日期:2026-09-02
- 任务:Task #28951(打回修复,审卡为 Task #28950)
- 关联:#182(需求)、Task #28949(实现,commit `0095ae2`)、Task #28950(审卡 REJECT)
- 基线:`8f4b457`(审卡 worklog 顶端);修复 commit `99d314e`
- 结论:审卡「阻塞发现」两点全落(文案缩短 + 结构性收口),另加 locales 宽度预算回归测试;真实 Chromium 四宽度实测 + legacy 对照复现原 bug。

## 起因

审卡(Task #28950)实测发现:#182 常驻占位引入的 EN 文案 "Pick a preset or a time to see the schedule preview here"(57 字符,10px mono 实测 ~337px)在移动端溢出——320px 视口下行预算 240px(320 − 56 `.queue-panel` padding − 24 `.queue-item` chrome),溢出沿 `.queue-item`(无 clip)上探,`.chat-footer` 因 `overflow-y: auto` 计算出 `overflow-x: auto` → footer 横向滚动。改动前空态什么都不渲染,无此问题——是实现新引入的移动端回归。

## 改法(审卡建议 1+2 并用 + 测试固化)

1. **EN 文案缩短**(审卡修复要求 1):`queue.schedulePendingEmpty` → "Pick a preset or a time to preview"(34 字符 ≈ 200px,320px 预算 240px 内有余);ZH 文案(16 个全角字符 ≈ 160px)本就达标,不动。
2. **CSS 收口兜底**(审卡修复要求 2):`.queue-schedule-pending.placeholder` 加 `display: block; flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;`——`flex-shrink: 1` + `min-width: 0` 覆写芯片基类的 `flex-shrink: 0`(否则 flex 项永不收缩,仅 min-width 无效);`display: block` 使 `text-overflow` 生效(flex 容器的匿名文本项忽略 ellipsis);任何 locale 未来超长都省略号截断而非撑出横向滚动。`line-height: 16px`(≤768px 断点 `line-height: 22px`)把字形钉在与 inline-flex readout 芯片相同的居中位——placeholder↔readout 切换像素稳定(#144 零跳动契约),`min-height` 16/22px 等高规则原样保留。
3. **回归测试**:`locales.test.ts` 新增「320px 手机预算」用例——EN ≤40 字符 / ZH ≤24 字符(10px mono 下 240px 预算),把文案宽度契约固化;CSS 收口是结构兜底,本测试保证它永远不必被触发。happy-dom 无布局测不了像素溢出,宽度预算是其确定性代理;像素级行为由真实引擎验证补位(见下)。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/i18n/locales/en.json` | `queue.schedulePendingEmpty` 57→34 字符 |
| `frontend/src/index.css` | `.placeholder` 收口 5 属性 + line-height;≤768px 断点补 `line-height: 22px` |
| `frontend/src/i18n/locales.test.ts` | 新增文案宽度预算测试(1 用例 4 断言) |

QueuePanel.tsx 零改动;后端/binding 零改动(生成物与库内一致)。

## 验证(真实 Chromium,file:// 复现页加载真 `frontend/src/index.css` + 真 DOM 链 `.chat-footer > .queue-panel > .queue-item > .queue-item-edit > .queue-schedule-staged-row > span.placeholder`)

- **修复态四宽度**:320/375/768/1280 实测 `footer.scrollWidth − clientWidth = 0`(无横向滚动);placeholder 宽被钳在行预算内(240 @320、295 @375,与审卡预算数学逐像素吻合);`ph.scrollWidth 333 > clientWidth` 证明 ellipsis 在 320/375 真实截断;1280 桌面不钳不截断(332.8 < 1000 行宽)。
- **等高契约**:每一宽度 placeholder 高 == readout 芯片高(22/22/22/16px),#144 零跳动在真实引擎成立。
- **原 bug 复现对照**(legacy 注入还原 pre-clamp 规则 + 旧 57 字符文案):320px 实测 footer 溢出 **54px**、placeholder 撑满 332.8px——确认复现页能抓住原 bug、修复是收敛原因;375px 在本复现页字体度量下右缘 ~374.8px 贴边(审卡实测 337.1px 字宽时溢出,度量差异所致,320px 硬复现已足够定罪)。
- **门禁**:`bunx tsc --noEmit` exit 0;`bun test --isolate` **542 pass / 0 fail**(76 文件,7884 expect;基线 541 + 新增 1)。环境备注:本 worktree 需先 `bun install` + 仓库根目录 `wails3 generate bindings -clean=true -ts -i`(在 `frontend/` 子目录跑生成器会静默产出 `frontend/frontend/` 垃圾目录且不生成 bindings,已清理)。

## 三端说明(§4.7)

- **桌面 GUI(>768px)**:共享同一渲染分支与 CSS;1280 实测占位完整可读、不触发 ellipsis、等高 16px,>768px 布局形制不变(变化仅「展开编辑行时槽行/Reset 恒在场」,即 #182 既有语义)。
- **远程浏览器**:本次验证引擎即 Chromium(与远程浏览器同类),页面路径走真 index.css;无 `isRemoteClient()` 守卫、无事件通道改动。
- **PWA(≤768px)**:320/375/768 三宽度无 footer 横向滚动 + 等高 22px,触屏 ✕ 6px padding 的 22px 芯片契约未被收口规则破坏。
- 备注:量化实测在 headless Chromium;桌面 GUI 真宿主为 macOS WebKit,未逐一重测(溢出/钳制的方向性结论引擎无关,且审卡同法)。无真机改动诉求;软键盘/滚动手感类真机项不在本卡范围。

## 下一步

- 无遗留。重走 coder→fe-reviewer 流程,APPROVE 后 #182 可关闭(orchestrator 处置)。
