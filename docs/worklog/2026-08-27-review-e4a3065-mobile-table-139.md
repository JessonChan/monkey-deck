# 2026-08-27 — Review e4a3065 #139 移动端表格策略:BLOCKED,P1×1(user-markdown 表面气泡胀破)(Task #24910)

## 结论

**不 PASS,勿关 MON-447。** agent 气泡表面完全达标;user markdown 表面存在本变更新引入的 **P1 回归**:含表格的用户消息气泡被表格 max-content 撑到 461px、越过 `.bubble-user-wrap` 的 76%(254px)上限,且无任何滚动出口。改动方向正确(C3 组合),需补一条 user 表面定宽规则后复审。

## 五个审查点

1. **断点内联 ✔**:纯追加 +23/-0(`frontend/src/index.css`,MQ 块内 3283–3305);块自 2960 开、3306 闭,MQ 内无其他 `.md-table-wrap`/table 选择器。1280px 实测零渗透:`display:table`、`thMinW:0px`、auto 挤压值与改前同形(minTdW 29–41px)。桌面像素基线成立。
2. **验收@390 ⚠ 半过**:agent 面 ✔✔——block 化生效、`thMinW:"66px"`/minTdW=66、宽表**在表格自身**横滚(tScroll 397 > tClient 303)、misalign=0、white-space 保持 normal、docLeak=0。user 面 ✘——见 P1。
3. **偏离依据 ✔ 成立**:CSS2.1 §17.5.2.1 fixed 算法只按首行 width 定列、min-width 仅 auto 算法参与(fixed 无视下限的说法正确);C3(display:block+width:max-content+max-width:100%+overflow-x:auto)即 GitHub markdown-body 量产组合,WebKit 主战场验证充分。
4. **回归面**:
   - 少列表@320px(iPhone SE):short3 tw=199 ≤ 可用 233,**无多余横滚** ✔;列宽下限不引入代价。
   - break-word 继承链:cell 层显式 `word-break:break-word` 与 bubble 原继承值相同,只是钉死,无副作用 ✔。
   - 长 URL 列:塌至 66px 后经 break-word 字符级竖排换行(高瘦但可读),P3 观察,非阻塞。
   - **user 表面胀破(P1)**:见下。
5. **worklog 一致性 ⚠**:机制/取舍/三端口径基本属实,但其「a/u ×5 形态 minCol=66、misalign=0」断言锚点太弱——minWidth 计算值与对齐检查在表体胀破时照样全绿,恰好漏掉容器包含性;cod er 探针未对 user 面断言「表格不越过 wrap 宽」,典型的断言锚定字段存在而非行为边界。

## P1:user-markdown 表面气泡胀破(复现实测)

探针:真实 index.css + 真实类名 DOM 链(`.row.row-user{justify-end}` → `.bubble-user-wrap{flex-col,align-items:flex-end,max-width:76%}` → `.bubble-user` → `.bubble-user-markdown` → `.md-table-wrap`)headless Chromium:

- 改前(BASE 内联模拟):u6 表格被 shrink-to-fit 压到 **254**(受 76% 上限约束;挤压 bug 存在但被包住,minTdW=42)。
- 改后:**tw=wClient=wScroll=461**,wrap 随内容一起长到 461,无内部滚动(scrollsH=false),仅靠聊天区滚动容器裁剪;docLeak=0 是裁剪假象。

**根因**:`max-width:100%` 是百分比约束,intrinsic sizing(测 max-content)阶段被忽略;`.bubble-agent-wrap{flex:1;min-width:0}` 给了 agent 面确定宽度所以没事,user 面 `.bubble-user-wrap`(column flex + align-items:flex-end)的子项(.bubble-user / markdown)走 fit-content 交叉轴尺寸,表格的 max-content(≥列数×66px 下限抬升)沿链上顶,没有任何定宽祖先能钳住它。AgentMarkdown 经 TableWrapper 双 surface 同源(#136 mount 测试证实 `.bubble-user-markdown .md-table-wrap` 是真实路径),故真实用户消息必现。

**建议修法(已在 390px 探针中验证有效)**:MQ 内给含表的 user 气泡建立确定交叉宽再让滚动在表内接管——
```css
.bubble-user-wrap .bubble-user:has(.md-table-wrap) { align-self: stretch; }
```
实测:markdown 变定宽后 u6 收敛回 254、tScroll 397>clientWidth、内部横滚恢复、misalign/下限不变;`:has` 只命中含表消息,短文本气泡不受影响(M2 硬约束面)。另可顺带评估 agent 侧同类风险面是否需要 `min-width:0`(现有 flex:1+min-width:0 已覆盖)。

## 复核方式

browser 工具 + file:// 加载仓库真实 index.css,复刻 ChatView 行 DOM;A/B 用显式内联旧值模拟 BASE(清空式 reset 会落回活动级联,首轮作废重测);320/390/1280 三视口逐项量化;未启动 wails3 dev/iOS 真机(与 coder 同口径留待桌面冒烟 + 用户侧真机)。改动本身未动代码,worktree 干净。

## 下一步

1. coder 补 user 表面定宽规则 + 把「表格 offsetWidth ≤ wrap clientWidth 或表格自身 scrollsH」写进 #136 mount 测试的断言锚(防复发);
2. 重提评审后由 orchestrator 关 MON-447;
3. P3:URL 列窄排观察、渐变滑动提示(issue 备选)继续挂 OPEN。
