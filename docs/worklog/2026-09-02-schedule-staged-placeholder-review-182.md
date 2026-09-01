# #182 审卡落档:Schedule staged 常驻占位 前端面(REJECT——移动端 EN 占位文案溢出)

- 日期:2026-09-02
- 任务:Task #28950(review #28949)
- 关联:#182(需求)、Task #28949(实现,commit `0095ae2` + worklog `58d7037`)
- 基线:main 顶端 `4a7aec9`;区间 `4a7aec9..58d7037`(两提交即评审对象)
- 结论:**REJECT**(打回 coder,单点修复;其余面全部达标)

## 评审范围与改动面

`0095ae2` 六文件:`QueuePanel.tsx`(槽行/Reset 恒渲染 + placeholder 分支)、`index.css`
(桌面 16px / ≤768px 22px 两条 `.placeholder` min-height)、`en.json`/`zh.json`(各 +1 key
`queue.schedulePendingEmpty`,同步落 432 行)、trio 测试重锚 + 新增 placeholder mount 测试
(218 行)。`58d7037` 仅 worklog。staged/Save/Reset 数据流零改动,符合 XXS 承诺。

## 清单逐条核验(diff 级)

1. **常驻语义正确**(`QueuePanel.tsx:496-523`):外层 `stagedVisible &&` 已删,槽行在
   `schedulingId === item.id` 行内恒渲染,空态走 `.placeholder` 分支(纯展示:无 ✕、
   无 tooltip);`stagedVisible` 两处消费(L477 Reset visibility、L497 槽行分支)均真实
   生效,非「类型补丁」死字段。
2. **Reset 恒占位正确**(`QueuePanel.tsx:470-480`):恒为 actions 行最后孩子,空态
   `style={{visibility:"hidden"}}`——位宽保留、出命中测试与 a11y 树,aria-label 随隐。
   首点预设零位移(#144 不变量正确扩展到首点);移动端 `.queue-btn` 40px 槽位与 staged
   态同形,空/staged 两态 actions 行几何恒定,正是本卡意图。
3. **Save 收起照旧**:整条编辑行(含常驻槽)卸载,未编辑项不加高;新测试第 1/2 用例
   分别钉死「Save 后全卸载」与「全局恰 1 个常驻槽」。
4. **i18n 同步**:en/zh 同 key 同层级(locales leaf-parity 测试在套件内守护);文案
   语义对齐;新增注释全英文(§3.7)。
5. **门禁复验**:`bunx tsc --noEmit` exit 0;`bun test --isolate` **541 pass / 0 fail**
   (76 files,7884 expect)——与 worklog 声称一致。环境备注:本评审 worktree 需先
   `bun install` + `wails3 generate bindings -clean=true -ts -i`(gitignored 生成物),
   与 #184/#180 审卡踩坑一致,非代码缺陷。不带 `--isolate` 裸跑有 16 个跨文件全局
   mock 污染失败(clipboard/App 布局等既有文件,与本改动无关),门禁以 `--isolate` 为准。
6. **后端零改动**:binding 无签名变化,`make bindings` 产物可再生成;tsc 无
   bindings 缺失错误。

## 测试断言质量(锚定值,非字段存在)

- 文案断言锚定 key 原文(`textContent === "queue.schedulePendingEmpty"`),readout 断言
  `contain "schedulePending:mins=5"`;visibility 断言锚定 `style.visibility` 字符串;
  高度断言锚定恒定值(fake flow model)。重锚后的 trio 断言未放松原不变量(预设 rect
  恒定保留)。
- 已知盲区(测试头注释自曝):happy-dom 无布局,`min-height` CSS 漂移抓不到——
  本次由评审以真实引擎补测(见下)。

## 阻塞发现(打回原因):EN 占位文案移动端溢出 footer

**现象(真实 Chromium 实测,复现页含完整 CSS 链)**:占位 span 继承共享类
`.queue-schedule-pending` 的 `white-space: nowrap; flex-shrink: 0`;EN 文案
"Pick a preset or a time to see the schedule preview here"(57 字符)在 10px mono 下
**实测 337.1px**。≤768px 可用宽度链:viewport − `.queue-panel` 56px − `.queue-item`
padding/border 24px = **375px 手机仅 295px 预算** → 溢出 42px;iPhone SE(320px)
预算 240px → 溢出 97px。溢出沿 `.queue-item`(无 clip)上探,`.chat-footer` 因
`overflow-y: auto` 计算出 `overflow-x: auto`(index.css:1331)→ 复现页实测
`footer.scrollWidth 378 > clientWidth 375`,**footer 出现横向滚动**。

改动前空态什么都不渲染,无此问题——**这是本改动新引入的移动端回归**,而「像素稳定/
零跳动」正是本卡的唯一验收点(§4.7 三端验收:移动端是第一等级的脸;coder worklog
自认未做浏览器实测)。ZH 文案 160px 无恙;桌面(≥769px 窗口预算 ≫337px)无恙。

**修复要求(二选一或并用,均在既定改动面 locales/index.css 内)**:
1. 缩短 EN 文案至 ≤40 字符(≤240px,覆盖 320px 最窄机);EN 文案系本轮新拟,无用户
   定稿约束。
2. `.queue-schedule-pending.placeholder` 加收口兜底:`min-width: 0; overflow: hidden;`
   (`display: block` 覆写以便 ellipsis 生效;min-height 16/22px 等高契约不受影响)——
   防任何 locale 未来超长。
推荐 1+2 并用:文案完整可读 + 结构性兜底。修复后须补真实引擎 ≤768px 三宽度
(320/375/768)验证 + 桌面回归确认,回写 worklog 三端小节。

## 非阻塞 nit(不打回)

- `stagedVisible`(L104)与 `staging`(L97)仅差 `schedulingId` 项,行内语义等价;
  两 flag 并存可读性尚可,KISS 收敛可后置。
- 桌面 16px/触屏 22px min-height 与 ✕ 构成(3px/6px padding + 10px 字形)吻合,
  评审已在真实引擎核对等高数学成立;但该契约无自动化守护,后续若动 ✕ padding 需同步。

## 改了哪些文件

- 新增:`docs/worklog/2026-09-02-schedule-staged-placeholder-review-182.md`(本文件,
  单文件单提交)

## 下一步

- 打回 coder:按「阻塞发现」修复(文案 + 收口),补 ≤768px 真实验证,重走
  coder→fe-reviewer;修复面预期 XXS。
