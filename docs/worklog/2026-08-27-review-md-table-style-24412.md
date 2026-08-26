# 2026-08-27 — Review #24411:#136 markdown 表格样式落地(Task #24412)

## 起因

复审 coder Task #24411(commit d76442f 实现 + 3fcd170 worklog):markdown 表格样式修复(#136 / issue #24409)。orchestrator 指定四项重点核查(A 覆盖面 / B 规格偏差 / C streaming remount 不变量 / D 横向滚动),其中 A 为最高优先。

## 结论:**APPROVE(修正后)**

四项逐一结论:

### A.【覆盖面】user markdown 面是否也吃到 `.md-table-wrap` → **PASS,无缺口**

反向追踪(`类型补丁`反模式的消费端验证):

- 全仓 `ReactMarkdown` **只有一个实例**:`AgentMarkdown`(ChatView.tsx:1767),其 `components` map 含 `table: TableWrapper`(:1762)。
- agent 面::893-894 `.bubble-agent` 内直接渲染 `<AgentMarkdown>`;
- user 面::1004-1006 `bubble-user-${renderKind}` 在 `renderKind === "markdown"` 分支渲染的也是**同一个** `<AgentMarkdown>`——orchestrator 怀疑的「只挂 AgentMarkdown、user 面走别的 renderer」不成立,不存在第二个 markdown 渲染器;
- 其余 user 文本分支(mono/prose/preview)按设计不产表格,无「规则存在但消费者缺失」。
- mount 测试(`ChatView.table.mount.test.tsx`,真实 react-markdown + remark-gfm 管线)以 `.bubble-user-markdown .md-table-wrap` 锚定断言双面结构。测试断言锚定值(wraps 数量、th/td 计数、裸表=包内表相等),符合断言规范。

CSS 侧 `.md-table-wrap` 规则全仓唯一定义(index.css:615-627),无双套规则、无冲突。

### B.【规格偏差】padding 与 vertical-align → **已在本任务收尾修正**

实现落了 `padding: 4px 10px`(钉死规格 8px)、缺 `vertical-align: top`。判定:

- `vertical-align` 缺失是实质缺口:默认 `middle` 使多行内容相邻单元格首行错位,长文本表格可见,属钉死规格明列项;
- padding 2px 属纯数值漂移,但既为「批准钉死值」,不默认豁免。

两处一行级修正(index.css:620-622):`padding: 4px 8px` + `vertical-align: top`。定级 P2(规格不符但无布局破坏);另记 P3 观察:`.md-table-wrap` 作为可滚动区域未加键盘可达性(tabindex/aria-label),触控板滚轮与移动端触摸不受影响,留待后续统一处理,非阻塞。

### C.【streaming remount 不变量】→ **PASS**

`TableWrapper` 定义在模块顶层(ChatView.tsx:1814-1820),`components` map 经 `useMemo([onOpenFilePreview, streaming])` 缓存;即使 map 因 `streaming` 翻转重建,`TableWrapper` 引用恒定 → react-markdown 按同元素类型 reconcile,table 流式期间零重挂。inline `pre` 箭头函数的身份漂移是该文件已知且有意的设计(mermaid 防闪烁注释 :209-214),不影响本改动。

### D.【横向滚动几何】→ **PASS(结构层)**

- agent 面:`.row`(flex)+ `.bubble-agent-wrap { flex:1; min-width:0 }`(:600)允许 flex item 收缩到内容宽以下 → 块级 `.md-table-wrap` 有确定宽,`overflow-x:auto` 内部滚动;
- user 面:`.bubble-user-wrap { max-width:76% }` 列向 flex(:520)把气泡钳在行宽 76%,max-width 对自动最小尺寸优先级更高 → 宽表的内在宽度溢出被 wrapper 吞掉转为横向滚动;长消息展开还有 `.bubble-user-long` 层限高滚动兜底;
- 未设置任何会把布局撑爆的 `width/min-width`;wrapper 只做滚动不带边框圆角,规避 WebKit collapsed border × border-radius 毛刺。
- 像素观感仍需桌面 webview 目视(coder worklog 已如实标注为 OPEN),结构约束无需运行时验证以外的环节。

## 本任务改动

- `frontend/src/index.css`:th/td 规格对齐(+vertical-align: top,padding 收敛回 4px 8px)

改的文件与验证:

```
frontend/src/index.css                      # B 修正(2 行)
docs/worklog/2026-08-27-review-md-table-style-24412.md   # 本条
```

验证:bun install + `wails3 generate bindings`(worktree 中间产物补齐)后 `bun test src/components/ChatView.table.mount.test.tsx` → **3 pass / 0 fail**(11 expect)。未跑重型构建(merge 时全量 393 pass 已由 #24411 给出,本任务仅 1 行 CSS 差异)。

三端说明(§4.7):修正仍是既有共享 CSS 块内的标准属性,三端引擎原生支持;桌面 GUI / 远程浏览器 / PWA 的目视复核随 #24411 既有的「桌面侧冒烟」OPEN 一并处理,本次修正未引入新的端差异风险。

## 下一步 / OPEN

- 桌面 webview 目视确认表格观感(边框深浅、表头底色、滚动手感),不满意再调 token;
- 键盘可达性(P3 观察)留待可交互元素 a11y 统一梳理时一并做。
