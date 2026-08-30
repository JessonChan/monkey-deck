# 2026-08-31 复审 #28439:编辑器选区引用/复制来源尾注前端面(#168 / Task #28440)——APPROVE

## 结论

**APPROVE**。任务规格 D1-D8 逐条反向实证全通(消费端逐点通电,非顺叙述),改动面恰为
声称的 3 文件,gate 与提交声称逐字一致(`bun test --isolate` **490 pass / 0 fail** ×
66 文件 / 7678 expect、`bunx tsc --noEmit` 0 错——均在本 worktree 独立复跑,非转抄)。
停 completed-ready 等人复核,不 push 不关 issue。

## 规格逐条实证(反向追踪)

- **D1 编辑器侧拼装**:尾注在 EditorPane 两个 run 闭包内、进 `onQuoteRef.current?.()`
  **之前**拼好(EditorPane.tsx:138/:146);App.tsx 在 `12c1909^..053ad9c` 全程零 diff
  (`git diff --stat` 恰 3 文件:EditorPane.tsx + 新测试 + worklog),`quoteToComposer`
  逐行 `> ` 前缀机制原样(App.tsx:1205)→ 尾注自然成为 blockquote 块内末行。
- **D2 格式**:单行 `path:N`、跨行 `path:N-M`;`selectionLineRange` 显式升序归一
  (EditorPane.tsx:58-59,拖拽方向无关,有反向拖拽用例锚定 `2-3`);path 取
  `filePathRef.current` 原样相对路径零转换;em-dash 硬编码不做 i18n——i18n 面零新增键
  (zh/en locale 双侧核过,`common.copy`/`selectionToolbar.copyTip`/`quoteToChat(+Tip)`
  全为既有)。
- **D3 仅编辑器入口**:diff 范围即证明——ChatView 选区工具栏动作原样(ChatView.tsx:241-242
  copy 无尾注、quote 原文透传),工具卡/@mention 体系零波及。
- **D4 API 未动**:SelectionToolbar.tsx 零 diff → `SelectionAction.run(text: string)`
  签名原样;行号解析在 run 闭包内自查(调 `withSourceFootnote` → `window.getSelection()`
  点击时刻现读),不依赖 toolbar 传参扩展。
- **D5 data-line 锚点**:anchor/focus 节点各自 `closest("[data-line]")`(EditorPane.tsx:51),
  属性值 `Number` 整数 + ≥1 校验;CodeViewer 行元素 `data-line={ln}` 既有(CodeViewer.tsx:205,
  本次零改动)。**运行时存活实证**:SelectionToolbar `a.run(sel.text)` 先于
  `removeAllRanges()`(SelectionToolbar.tsx:116-121)——解析时选区必在,这是本功能
  通电的承重时序,已读源确认。
- **D6 Copy/Quote 同路径**:两动作 run 体都调同一个 `withSourceFootnote(text,
  filePathRef.current)`,复制 payload 用例与引用 payload 用例断言同构锚定串。
- **D7 块内末行**:尾注以 `\n` 追加在选区文本之后 → App 逐行前缀后为 `— path:N-M` 行,
  是 quote 块最后一行;用例断言完整 payload(`toEqual([\`${text}\n— ${PATH}:2\`])`)。
- **D8 测试**:4 条 mount 测试全部**锚定值断言**(完整 payload 逐字节),零「字段存在」式
  弱断言;真流程驱动(真实 DOM 选区 setBaseAndExtent → selectionchange → 真实工具栏按钮
  点击),仅 shim 布局引擎与 clipboard/binding 边界。降级用例显式:选区锚在语言角标
  (无 data-line 祖先)→ 纯文本无尾注无 `—`、不报错。

## 异常退化核实

`selectionLineRange` 任一端点解析失败返回 null → `withSourceFootnote` 原文返回 →
行为与 #168 前逐字节一致。code path 无 throw 面(`Number` + `isInteger` 守卫畸形属性),
用例覆盖。

## 类型补丁反模式检查(消费端逐点通电)

- `filePathRef`:定义(:128)→ 两处 run 时读取(:138/:146)→ 用例切换路径场景由
  `file={{ path: PATH }}` prop 直灌,断言 payload 内路径值。通电。
- `withSourceFootnote`/`selectionLineRange`:模块级助手,唯一消费点就是两个 run 闭包,
  无悬空导出。
- `useCopyFeedback` 无孤儿化:选区 Copy 改走 `copyTextQuiet`(对齐 ChatView 选区复制
  形态)后,`copied/failed/copyFn` 仍被编辑器头部整体复制按钮消费(EditorPane.tsx:365-367、
  533-536),非死代码。

## 验证(本 worktree 独立复跑)

- 新 worktree 缺 `node_modules`/`frontend/bindings`(生成物不入库):`bun install` +
  `wails3 generate bindings`(wails3 v3.0.0-beta.3,297 packages/2 services/128 methods)
  后复跑。
- `bun test --isolate`:**490 pass / 0 fail**(基线 486 + 新增 4,与声称逐字一致);
  `bunx tsc --noEmit`:exit 0。go 门不复跑(Go 零改动,纯前端面评审)。
- 夹带检查:`git diff --stat 12c1909^ 053ad9c` 恰 3 文件 351 insertions / 1 deletion,
  与两 commit 声明一致;`git status` 干净无未预期落盘。

## 非阻塞备注

1. 尾注正确性**依赖 SelectionToolbar「先 run 后清选区」的跨文件时序不变量**——若日后
   有人把 `removeAllRanges()` 提到 `a.run()` 之前,尾注会静默退化为无尾注(不报错)。
   现有 4 条锚定值用例可当场抓死该回归(D8 断言含尾注串),风险已有测试兜底,无需改动。
2. 「补 Copy 动作」是 #168 顺带交付(此前编辑器选区工具栏仅 Quote):与 D6/D8 要求一致,
   ChatView 形态对齐,复用既有 i18n 键,判定在范围内非夹带。
3. worklog(053ad9c)另声称 `npm run build` 通过;任务 gate 只要 bun test+tsc,两者已
   独立复跑一致,build 项未重复复跑(tsc 即其类型门,无矛盾证据)。
