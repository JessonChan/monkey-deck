# 2026-09-01 复制 Markdown 源(SelectionToolbar Copy,issue #177)

## 起因

Task #28930(实现 #177)。issue 原始形态是「表格加复制按钮,从 AST 重建 GFM」;实现前 orchestrator 探针实证了更优路径:**react-markdown@9.1.0(`passNode: true`)把 hast `node.position.{start,end}.offset` 原样传给自定义组件,且该 offset 对传给渲染器的原始 markdown 串字节级有效**(p/strong/li/table/code 全过)。于是方案升级为通用的「选区 → 原始 markdown 源」机制,不再重建:表格、围栏代码、列表、引用等全部类型一次性覆盖,且复制出的是**逐字节的原始源**(零规范化损失)。约束:SelectionToolbar `run(text)` API 不动。

## 设计 / 根因

- **位置锚**:ChatView 的 components map 对核心元素集(p、h1–h6、li、ul、ol、blockquote、table、td、th、pre、code、strong、em、del、a)把 `node.position` 写成 DOM 属性 `data-md-s`/`data-md-e`(`lib/markdownSource.ts` 导出 `mdSourceProps`)。包装器组件统一从 props 里解构出 `node` 再 spread(顺带修掉既有代码把 `node` 对象漏到 DOM `<a>/<table>/<th>` 上的 passNode 泄漏);ResizableTable/HeadCell 在自身根元素补挂(根 = `.md-table-wrap` div / `<th>`)。
- **源串定位**:`markdownSourceFromSelection(raw: string)` 在点击时刻读 `window.getSelection()`(依赖 SelectionToolbar「先 run 后清选区」的既有时序不变量,#168 已实证),解析规则:
  1. 每个选区边界向上找**最近的带锚祖先**;找不到(tool 卡片、thought、纯文本气泡、mermaid/math 块)→ 返回空,调用方回退纯文本;
  2. 两边界分属不同 `data-md-msg` 消息根 → 空(一条源串表示不了跨消息);
  3. 存在**公共带锚祖先**(同一表格/引用/行内加粗等)→ 用它的 span——跨单元格选中得到整张表的源(正是 #177 诉求),不是残缺行片段;
  4. 否则两边各膨胀到**块级**带锚祖先(跳过 inline 标签)取并集——块间空行随切片一起带走,粘出去仍是合法 markdown;
  5. 结尾 `end` 对 raw.length 做钳制(流式 caret " ▋" 追加在源串尾部,offset 合法但可能越界)、去尾部换行。
- **消息根标识**:`.bubble-agent` / `.bubble-user-wrap` 挂 `data-md-msg={item.id}`;Copy 动作在 ChatView 里经 `mdItemsRef`(ref 稳定模式,不进 actions memo 依赖)反查 item,再用 `mdSourceOfItem(item)` 取**与渲染完全一致的源串**——流式 agent 消息渲染时追加 caret,offset 是对这个拼接串有效的;该拼接逻辑收敛为单一函数(§5.3 一套表示),ChatRow 渲染与 copy 查询共用。
- **Copy 接线**:`selectionActions` 的 copy 动作改为 `copyTextQuiet(markdownSourceFromSelection(raw) || text)`——有锚还原源,无锚(工具卡/纯文本区)保持旧行为复制纯文本。`run(text)` 签名原样,SelectionToolbar.tsx 零 diff。

## 决策 / 取舍

- **`math` 锚未加**:remark-math v6 不产生 `math` tagName(行内/块级都是 `code.language-math`),components map 里加 `math` 是死键(§5.3 删无用代码)。但 math 块/行内经 MathBlock/MathInline 渲染,根上**未挂锚**——选区内 math 回退纯文本,**并非**「经 code/pre 路径覆盖」(初稿此句有误,review #28931 勘误;挂锚留 OPEN)。
- **Mermaid/MathBlock 根不锚**:PreRenderer 只把 pre 的 span 传给 CodeBox(围栏代码选中 → 复制完整 ``` 围栏);mermaid/math 需要改任务面之外的文件,本次不做,选区回退纯文本(记 OPEN)。
- **部分选中语义**:「包含两边界的最内带锚元素」优先,跨块才膨胀到块级并集——同段内选中加粗短语得 `**粗体**`,跨段得整段;行为可预测,不追求 Typora 级的子块精确切片(需要文本节点级 offset 映射,hast text node 不经组件,成本不成比例)。
- **tableCell span 含管道**:mdast 语义(单元格 "A" 覆盖 `"| A "`),字节级正确但非独立合法 markdown;整表复制是主诉求,单元格碎片可接受。

## 改了哪些文件

- `frontend/src/lib/markdownSource.ts`(新):`mdSourceProps` + `markdownSourceFromSelection` + `MdComponentProps` 类型。
- `frontend/src/components/ChatView.tsx`:import;components map 增 h1–h6/ul/ol/blockquote/strong/em/del(`makeAnchored` 工厂,模块级稳定标识)并给 pre/code/a/p/li/td 接锚;`mdSourceOfItem` 统一源串拼接;`.bubble-agent`/`.bubble-user-wrap` 挂 `data-md-msg`;`mdItemsRef` + `rawSourceOfSelection` + Copy 动作改写(tipKey 换 `selectionToolbar.copyMdTip`)。
- `frontend/src/components/ResizableTable.tsx`:ResizableTable/HeadCell 解构 `node`、根元素挂锚(`node` 不再漏进 DOM 属性)。
- `frontend/src/i18n/locales/zh.json` / `en.json`:`selectionToolbar.copyMdTip` 新键(编辑器选区工具栏仍用 `copyTip`,不受影响)。
- 测试:`frontend/src/lib/markdownSource.test.ts`(新,16 用例)、`frontend/src/components/ChatView.mdsource.mount.test.tsx`(新,5 用例)。

## 验证

- **新单测 16 例**(lib,合成 DOM + 选区 stub):最近锚、公共祖先(列表)、块级并集(空行随行/inline 膨胀)、反向选区归一、跨消息拒绝、无锚拒绝、collapsed、getSelection 缺失、流式越界钳制、尾换行修剪、`mdSourceProps` 边界(s==e、e<s、缺 position)。
- **新 mount 测试 5 例**(真实 react-markdown 管线 + 真实 Selection + 真实 SelectionToolbar 点击):核心元素 data-md-s/e 字节有效(含 `.md-table-wrap`=整表、th/td 含管道切片、`.code-box`=完整围栏、li=含 `- ` 标记);跨单元格选中 → 整表源;工具栏 Copy → 剪贴板收到 `**bold**`;code box 内选中 → 剪贴板收到围栏源;纯文本气泡回退纯文本。
- **全量**:`bun test --isolate` 548 pass / 0 fail(74 文件);`npx tsc --noEmit` 干净;`npm run build` 成功;`go build ./...` / `go vet ./...` 干净(Go 零改动)。
- **三端(§4.7/§5.6)**:本改动无 CSS/布局/组件结构变化——`data-*` 属性对渲染惰性;copy 行为由标准 Selection API 驱动,mount 测试在 Chromium 引擎外的 happy-dom 实证通过,逻辑与平台无关(`isRemoteClient`/`coarsePointer` 分支未触及)。桌面 GUI / 远程浏览器 / PWA 三端共用同一份组件与逻辑,预期零差异;**三端人工冒烟未做**(记 OPEN,无预期风险)。

## 下一步 / OPEN

- Mermaid/math 块如需「选区复制围栏源」:给 MathBlock/MermaidRenderer 根部透传锚(扩及 ChatView 之外两文件,届时单独任务)。
- 三端人工冒烟(桌面 webview / 远程浏览器 / PWA 各点一次选区复制),预期与自动化结论一致。
- 跨消息选区目前整体回退纯文本(刻意,单串不可表示);若未来有诉求再做按消息分段拼接。
