# 2026-08-30 复审 #28434:formatHuman 层级树渲染前端面(#169 / Task #28435)——APPROVE

## 结论

**APPROVE**。D1-D8 逐条反向实证全通,改动面恰为声称的 4 文件,gate 与提交声称逐字一致
(bun test --isolate **486 pass / 0 fail** × 65 文件、`bunx tsc` 干净、`npm run build` 通过——
均在本 worktree 独立复跑,非转抄)。停 completed-ready 等人复核,不 push 不关 issue。

## 规格逐条实证(反向追踪,非顺叙述)

- **D1 树化范围**:diff 锚定——`summarizeToolPayload` 全函数仅 ⑧ 分支一行语义变化
  (`formatHuman(raw)` → `formatHuman(raw, t)`);①-⑦ 命中分支、`ARRAY_FIELDS`/
  `BODY_KEYS`/`joinTextBlocks`/`summarizeArray` 逐字节零改动(summarizeArray 仅内联
  截断三元换 `clipLine`,语义不变且有既有 200-截断用例锚定)。preview 仍单行。
- **D2 树形**:`TREE_INDENT="  "`+`TREE_PREFIX="└─ "`;level-0 裸排(toolPayload.ts:74)。
  兼容性有锚定值用例锁死:⑧-flat `status: ok\ncount: 3` 与旧实现逐字节一致。
- **D3 深度 4**:`TREE_DEPTH_MAX=4`,record entry 在 `level+1 > 4` 时 `formatInline`
  压平且不截断(toolPayload.ts:210-212);深嵌套用例锚定 `…└─ l5: l6: deep` 恰在第 4 层。
- **D4 数组**:≤8 全树化 / >8 前 3 + `t(chat.itemsMore,{count:len-3})`(:169-174);
  12 项/2 项/键下缩进三形态均有锚定串。
- **D5 行宽**:`clipLine` 与 preview 共享 `PREVIEW_LINE_MAX=200`,截后恰 200 字符以 `…`
  结尾(用例锚定长度与尾字符);根字符串豁免(是正文不是树行,有断言)。
- **D6 防环**:formatHuman(flattenTree 数组/record 两分支)与 formatInline 均持
  **路径** WeakSet,try/finally 进出对称——只有真祖先环触发 ↻,DAG 复用同对象不误伤
  (add/delete 对称读过,无污染泄漏)。record/array/formatInline 三态用例齐。
- **D7 空形态**:嵌套 null/`""`/`{}`/`[]` → `key: (空)`;`chat.emptyValue` zh=`(空)`/
  en=`(empty)` 两 locale 同步落盘(紧挨 itemsMore,双文件各 +1 行);**顶层 `{}`/`[]`
  仍返 `""`**,NO_STRUCTURE 开放形态门不破(用例显式锚定)。
- **D8 测试**:新增五组(规格要四组,超配)+ 既有 ⑧-flat/括号断言兼容保留;
  全部 `toBe` 锚定值断言,无「字段存在」式弱断言。

## 类型补丁反模式检查(消费端逐点通电)

- `chat.emptyValue` 定义点(locales ×2)→ 消费点 `emptyValueLabel`(:128)→
  flattenTree 四处渲染(:145/:158/:190/:206)→ 空节点用例断言渲染值 `(空)`。全链路通电。
- `formatHuman` 新增可选 `t`:三个 ChatView 调用点零改动且**无 t 路径只可能见到
  空/标量根**——逐调用点核过:非空数组 summarize 必非空(joinTextBlocks ?? summarizeArray
  双非空),record 经 ⑧ 必 truthy(非空 record 必产行),故 `s.summary ?? formatHuman(raw)`
  的无 t 兜底在生产路径产不出 i18n 行;`(empty)`/`…and N more` 英文硬编码不可达。
- ChatView.tsx 零 diff(commit stat 仅 4 文件);`RawPayloadDisclosure`/`rawJsonText`
  复制契约零波及。
- 渲染面:多行树进既有 `.tool-pre`(white-space:pre-wrap + word-break,D3 压平超长行
  软换行不撑破)与 CollapsibleText(按 \n 分行折叠),零新组件零 CSS。

## 验证(本 worktree 独立复跑)

- 新 worktree 缺 `node_modules`/`frontend/bindings`(生成物不入库):`bun install --frozen-lockfile`
  + `wails3 generate bindings` 后全绿——7 个失败全是 `Cannot find module '../bindings/…'`
  环境噪声,与改动无关(与 coder worklog 记录的现象一致)。
- `bun test --isolate`:**486 pass / 0 fail**;`bunx tsc --noEmit`:0 错;`npm run build`:通过。
- go 门不复跑(Go 零改动,frontend 面评审)。

## 非阻塞备注

1. flattenTree :139 的 `level > TREE_DEPTH_MAX` 守卫实际不可达(record entry 在 :210
   已拦 `level+1 > 4`,数组项不升层)——防御性冗余,无害。
2. 数组边界 8/9 未显式用例(现有 12/2 两锚);代码 `> TREE_ARRAY_MAX` 语义清晰,可后续补。
3. 键下多行字符串的续行会各带同层 `└─` 前缀,视觉上似兄弟节点——罕见形态,规格未约束,
   可接受。
