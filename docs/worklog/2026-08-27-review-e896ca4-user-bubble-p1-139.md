# 2026-08-27 — Review e896ca4 #139 P1 修复(user 表面气泡胀破):PASS,建议关 MON-447(Task #24912)

## 结论

**PASS。** e896ca4(MQ 内 `.bubble-user-wrap .bubble-user:has(.md-table-wrap){align-self:stretch}` + mount 测试行为边界锚)在 #24910 BLOCKED 口径下逐项复核通过,P1 关闭,建议 orchestrator 关 MON-447。未修改任何代码,worktree 干净。

## 四个复核点

### 1. P1 关闭性 ✔

结构面:diff 仅 +2 文件;index.css 单一 hunk(3306–3315,注释 + 1 条规则),位于 `@media (max-width:768px)` 块内(块 2960 开、3316 闭),该块是全文件唯一 768px 断点。无其他 MQ 外改动。

390px 真引擎探针(headless Chromium,file:// 加载仓库真实 index.css + 真实类名 DOM 链,u6=6 列表):

- `.bubble-user-wrap`/`.bubble-user` 均收敛 **253.84px** = 76% × 334 上限(与 coder 报告逐位一致;`#24910` 改后实测 461);
- computed `align-self: stretch`(规则真实命中,非字段存在);
- 表格**自身**横滚:`scrollWidth 397 > clientWidth 226`,`offsetWidth 226 ≤ wrap clientWidth`,两支判据同真;misalign=0、`display:block`、minCol=66(5.5em 下限完好)、cell white-space=normal、docLeak=false——包含是真实的内部滚动出口,非容器裁剪假象;
- 320px(iPhone SE)复核:wrap 200.63 = 0.76 × 264,同样收敛。

`bun test src/components/ChatView.table.mount.test.tsx` 独立复跑 **4 pass / 16 expect**(bindings 生成后);`bunx tsc --noEmit` 干净。

### 2. :has 边界 ✔

- 短文本无表气泡:computed `align-self: auto`(`:has` 未命中),宽度 fit-content(本探针 157.2px),390/1280 逐位一致,未被 stretch 波及(M2 硬约束面);
- **小表消息不受 stretch 视觉伤害**:`.bubble-user-wrap` 仍 shrink-to-fit(≤ cap),2 列小表气泡 161px < 253.84,stretch 只填满 wrap 已解析宽度,不会强撑到满 cap——上一轮担心的"小表气泡变全宽"不成立;
- agent 面:本 commit 未新增任何 agent 选择器;agent 面探针 390px(block、自滚 397>297、mis=0)与 1280px(display:table、自然宽、mis=0)均与 e4a3065 复审时基线同形。

### 3. 桌面零渗透 ✔

1280×800 实测:mq=false、`.bubble-user` computed `align-self: auto`、表格 `display: table`(MQ 块规则全部失活)、气泡 fit-content 524.2 随内容、短气泡 157.23 与移动端逐位一致、docLeak=false。

### 4. mount 测试质量 ✔(断言锚定行为边界)

新增测试「user markdown table stays contained in the bubble (#139)」三处锚点均为行为边界而非字段存在性:

- **DOM 链即选择器契约**:`.bubble-user-wrap .bubble-user .md-table-wrap` 全链 querySelector——CSS hook 依赖的类链改名会在此静默断开,现被钉死;另加 user 面「无裸 table」不变量(与 agent 面同款);
- **containment 判据双支都验**:溢出态显式注值 (scrollWidth 397, clientWidth 254) → 走 `scrollWidth > clientWidth` 支;贴合态 (200/254) → 走 `offsetWidth ≤ clientWidth` 支。断言的是 `#24910` 提出的判据本身,非"字段存在";
- WeakMap 按元素注值,无跨测试泄漏;既有 3 条测试不受宽度轴 mock 影响(4 pass 实证)。

残余局限(测试注释已自陈,不扣分):happy-dom 无排版引擎,宽度轴是 mock,删掉 CSS 规则本身不会让该测试变红——CSS 层防复发仍靠评审侧真引擎探针 + 本条记录的数值锚。mock 值域(397/254/200)取自真实探针实测,判据逻辑是被验证的对象。

## 必要性注记(非阻塞,记录事实)

本次会话用 CSSOM 注入 `align-self:auto` 覆盖(等特异性、文档序靠后)做同引擎 A/B:今日 headless Chromium 下**关掉该规则不复发 461 胀破**(390px wrap 仍 253.84、320px 仍 200.63,表格照常内滚)——与上轮探针实测不符,推断浏览器版本更新改变了 flex 百分比 max-width 在 intrinsic sizing 阶段的解析行为。含义:该规则在当前 Chromium 构建上属**跨引擎确定性加固**而非因果载重;但本项目目标引擎矩阵含 macOS WebKit / WebView2 / iOS Safari,M2 移动面恰恰跑在这些引擎上,规则语义(给含表 user 气泡建立确定交叉宽)是 spec 正确的包含性做法,实测零副作用(第 2 点),保留正确。若未来引擎演化致行为漂移,此规则保证下界。

## 复核方式

browser 工具 + file:// 加载 HEAD 真实 index.css + 真实类名 DOM 链(.row.row-user → .bubble-user-wrap → .bubble-user → .bubble-user-body.bubble-user-markdown → .md-table-wrap,agent 面 .row-agent → .bubble-agent-wrap → .bubble-agent);390/320/1280 三视口量化;规则开关用同特异性级联覆盖模拟(file:// 下 CSSOM 只读,SecurityError);bun test + tsc 本地复跑;未启 wails3 dev/真机(与本仓 M2 惯例一致,留用户侧)。评审零代码改动。

## 下一步

1. orchestrator 关 MON-447(#139 移动端表格策略整体收官;P2/P3:URL 列窄排竖排换行观察、表格横滑渐变提示,继续挂 issue 备选);
2. 无遗留阻塞项。
