# 2026-08-27 — #139 P1:user 表面气泡胀破修复——align-self:stretch 收敛 + mount 测试行为边界锚(Task #24911)

## 起因

e4a3065(#139 移动端表格策略)复审 fe-reviewer #24910 **BLOCKED P1**:≤768px 含表格的用户消息气泡被表格 max-content 撑到 461px,越过 `.bubble-user-wrap` 76%(254px)上限,且无任何滚动出口。本条落地 review 建议的修法 + 断言防复发。

## 根因(承接 review 探针结论)

`max-width:100%` 属百分比约束,intrinsic sizing(测 max-content)阶段被忽略。user 面 DOM 链 `.row-user`(justify-end)→ `.bubble-user-wrap`(column flex + `align-items:flex-end` + `max-width:76%`)→ `.bubble-user` → `.bubble-user-markdown` → `.md-table-wrap`,交叉轴走 fit-content、无定宽祖先可钳制;表格的 max-content(≥6 列 × 66px 下限抬升)沿链上顶把整颗气泡一起撑爆。agent 面 `.bubble-agent-wrap{flex:1;min-width:0}` 有确定宽度所以同套规则下没事。

## 改法

1. **`frontend/src/index.css`**(M2 断点块内,`@media (max-width:768px)` 的 `.md-table-wrap th/td` 规则之后追加一条):

   ```css
   .bubble-user-wrap .bubble-user:has(.md-table-wrap) { align-self: stretch; }
   ```

   只命中**含表**的用户气泡:`:has` 不命中短文本气泡(M2 硬约束面零触碰);给 `.bubble-user` 建立确定交叉宽后,MQ 既有 `max-width:100% + overflow-x:auto` 即接管超额部分路由进表格自身横滚。桌面规则与 agent 面未动。
2. **`frontend/src/components/ChatView.table.mount.test.tsx`**(#136 mount 测试补 #139 行为边界锚):
   - 新增测试「user markdown table stays contained in the bubble (#139)」:真实布局需 webview,happy-dom 无排版引擎,故用与既有 offsetHeight/clientHeight mock 同形的手法补 clientWidth/scrollWidth/offsetWidth 轴 mock(`mockWidths` WeakMap,默认 0),对 user surface 断言 containment 契约:**`table.scrollWidth > wrap.clientWidth || table.offsetWidth <= wrap.clientWidth`**(溢出态 254/397 与贴合态 200 两组数字都验),防「只锚 min-width 字段值,misalign 全绿掩盖胀破」复发。
   - 同时钉住 CSS hook 依赖的 DOM 链 `.bubble-user-wrap .bubble-user .md-table-wrap`(类名改名会静默断开 `:has` 匹配,一并防)及 user 面「无裸 table」不变量(agent 面已有同款)。
3. 无 Go 改动,worktree 其余未动,P2/P3(URL 列窄排观察、滑动渐变提示)维持 OPEN 不在本任务范围。

## 验证

- **mount 测试**:`bun test src/components/ChatView.table.mount.test.tsx` → 4 pass / 0 fail(3 条既有 + 新增 1);全仓 `bun test` 360 pass / 32 fail,与本仓 BASE(stash 后实跑 359/32)逐一对照,**新增恰好 1 个通过、32 个失败为存量基线**(happy-dom/绑定类历史问题,与本改动无关)。
- **前端 build 门**:frontend 缺 node_modules/bindings,先 `bun install` + `wails3 generate bindings` 再 `bun run build`(tsc + vite production)→ 通过(chunk >500kB 警告为存量)。
- **Go 门**:`go build ./... && go vet ./...` → 干净(本次无 Go 改动,例行自检)。
- **390px 真引擎探针**(headless Chromium,file:// 加载仓库真实 index.css + 真实类名 DOM 链,u6 形态 = 6 列表):
  - `.bubble-user-wrap` 宽 **253.84 ≈ 254**(改前 461),`.bubble-user` 同宽,computed `align-self: stretch`(规则命中);
  - 表格在**自身**横滚恢复:`table.scrollWidth=397 > clientWidth=226`(列各钳 66px 下限,首行行宽 396 在 226 滚动盒内),同时满足「表格 offsetWidth ≤ wrap clientWidth」的另一支;
  - misalign=0、`display:block` 生效、文档级泄漏(docLeak)=false;
  - **短文本气泡不受影响**:107.2px(fit-content,未被 stretch 波及)。
- **1280px 桌面渗透检查**:同一 fixture 桌面视口 computed `align-self: auto`(MQ 未匹配)、表格 `display: table`(桌面规则原样)、气泡 fit-content(587.6px 随内容而非满行)、短气泡宽度与移动端逐字节一致。
- 三端口径(§4.7):本改动是纯 MQ 内 CSS 追加 + 测试文件,**后端/binding 无改动**;远程浏览器/PWA 共享同一份前端产物与样式表,M2 断点行为即上探针实测,PWA 真机手感仍按 M2 惯例留用户侧实测,不在本任务展开。

## 文件

- `frontend/src/index.css`(MQ 块内 +13 行注释 + 1 条规则)
- `frontend/src/components/ChatView.table.mount.test.tsx`(宽度轴 mock + #139 containment guard 测试)

## 下一步

1. orchestrator 转 fe-reviewer 复审,过后关 MON-447;
2. P2/P3 继续 OPEN:#139 的 URL 列窄排观察(TableWrapper 列塌至 66px 竖排换行可读性)、表格横向滑动的渐变提示(issue 备选);
3. 上游 e4a3065 与本条的复合效果已在 390px 探针中合并验证,无新增回归面。
