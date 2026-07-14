# edit / grep / glob / read_file / write_file 工具卡片化(复用 J1 折叠件)

## 起因
Task #15082。J1(2026-07-14-bash-tool-card-collapsible.md)只把 `kind="execute"` 的 bash
做成了终端风卡片,并留下可复用的 `Collapsible`(头 + 折叠 toggle)+ `CollapsibleText`(长文本折叠)
两件套。其余工具(edit/apply_patch、grep/glob、read_file/write_file)仍走 `GenericToolCard`
(裸 input/output 两段 `<pre>`),既不直观(长 diff/长文件正文堆一块),也违背 §4.4
(把 rawInput `{path, old_string, new_string}` 这种结构化字段半裸呈现)。本 task 复用 J1 的
卡片框架,按 ACP `ToolKind` 给剩余工具定制卡片体。

## 设计取舍
- **分派按协议 `kind`,不按工具名**:前端只拿到协议 `kind`(read/edit/search/execute/…),
  拿不到具体工具名(grep vs glob、edit vs apply_patch vs write_file 在协议层都是 search/edit)。
  故 `ToolCard` 改为 `switch(kind)`:execute→`BashToolCard`、edit→`EditToolCard`、
  read→`ReadToolCard`、search→`SearchToolCard`、其余→`GenericToolCard`。
  分派层仍不持有 hook(React Rules of Hooks),与 J1 一致。
- **复用,不重写**:
  - 头部:`Collapsible`(J1 已有)+ 状态徽章 `TOOL_STATUS_MAP`(J1 已有)。
  - 长内容:`CollapsibleText`(J1 已有,自带「短直接渲染 / 长首尾+省略折叠 / 展开全文」三态)。
  - **唯一扩展**:`CollapsibleText` 加一个可选 `lineClassName?: (line, idx) => string` 回调。
    提供时把每行包进 `<div className=…>`,短/展开/折叠预览**三态一致**按行染色;不提供时维持
    原 `<pre>{text}</pre>` 行为(bash 零改动)。用于 edit 的 diff +/- 增删行高亮。**完全向后兼容**。
- **edit 卡片(`EditToolCard`)**:头(FilePen + 标题 + 路径徽章 + 状态)+ 体(目标文件 + 改动)。
  `extractEditParts` 归一 rawInput 成三种呈现:
  1. `patch` 字段(apply_patch)→ 原样 unified diff,`diffLineCls` 染色(+绿/−红/@@蓝)。
  2. `old_string`+`new_string`(opencode edit)→ 自构 `-`/`+` 前缀 diff(删除行段 + 新增行段,
     非最小化对齐,但诚实呈现增删,且复用同一套 +/- 染色)。
  3. 只有 `content`/`newText`(write_file 新写)→ 纯内容(不强加全绿底,大文件视觉过重)。
  改动头显示 `+N / −M` 增删统计(`countDiffLines`,忽略 `+++`/`---` 文件头)。失败时额外展 output。
- **read 卡片(`ReadToolCard`)**:头(FileText + 标题 + 路径徽章 + 状态)+ 体(目标文件 + 内容)。
  内容来自 rawOutput(`extractToolText`,兼容 `{content}`/`{output}` 等),长内容走 `CollapsibleText`。
  路径优先 rawInput.path,兜底 rawOutput(部分 harness 把 path 也放 output)。
- **search 卡片(`SearchToolCard`)**:头(Search + 标题 + pattern 徽章 + 结果数徽章 + 状态)
  + 体(模式 + 范围 + 结果列表)。grep 输出「路径:行:内容」、glob 输出路径列表,均原样走
  `CollapsibleText` 等宽呈现(不做进一步解析,形态无限,§5.3 不堆 if)。结果数 = 非空行数。
- **不裸露结构化格式(§4.4)**:路径、pattern 从 rawInput 抽具体字段(`extractFilePath`/
  `extractSearchPattern`/`pickStr`),绝不把 `{...}` JSON 抛给用户;路径用人话「目标文件:…」呈现。
- **横向滚动不撑破布局**:所有 `<pre>` 沿用 `white-space: pre; overflow-x: auto`(J1 既有),
  diff 行作为 block `<div>` 在 `<pre>` 内自然换行 + 背景填满行宽。
- **零新依赖**:复用 `lucide-react`(`FilePen`/`FileText`/`Search`,确认 v1.21.0 存在)+
  `react-tooltip`(`data-tooltip-id="md-tip"`)。无新库。
- **ToolGroup 兼容**:`ToolGroup` 内部仍 `<ToolCard item={t} />`,经新分派后 edit/read/search/
  bash 在组内各自走专用卡片,继承 `.tool-group .tool-card { padding:0; max-width:none }`。

## 改了哪些文件
- `frontend/src/components/CollapsibleText.tsx`:
  - 新增可选 `lineClassName?: (line, idx) => string`。
  - `renderPreBody`(useMemo):有回调时把每行包 `<div className={lineClassName(l,i)}>`(空行用
    ` ` 占位保留行高),短态/展开态 `<pre>` 均用 `{renderPreBody ?? text}`。
  - 折叠预览的 head/tail 行 className 追加 `lineClassName(l,idx)`(tail 用真实行号 `tailIdx`)。
  - 不传回调时行为字节级不变(bash 卡片不受影响)。
- `frontend/src/components/ChatView.tsx`:
  - import 加 `FilePen`、`FileText`、`Search`(lucide)。
  - `ToolCard` 由 `if(execute)→bash else→generic` 改为 `switch(kind)`(execute/edit/read/search/default)。
  - 新增 `EditToolCard` / `ReadToolCard` / `SearchToolCard`(均 Collapsible 头 + CollapsibleText 体)。
  - 新增辅助:`extractFilePath`、`extractSearchPattern`、`extractEditParts`、`pickStr`、
    `buildPlusMinusDiff`、`countDiffLines`、`diffLineCls`、`shortPath`、`countNonEmpty`。
  - 各卡 data-testid:`edit-target`/`edit-diff`/`edit-content`/`edit-output`、`read-target`/`read-content`、
    `search-pattern-row`/`search-results`(§4.2 测试友好)。
- `frontend/src/index.css`:
  - `.tool-badge/-pattern/-count`(头部路径/pattern/结果数徽章,mono、ellipsis、不撑破)。
  - `.file-tool-summary .tool-title { flex:0 1 auto }`(给徽章让位)。
  - `.file-target/-label/-path`、`.search-pattern-text`(目标文件 / 范围行)。
  - `.file-section/-head/-label/-meta`、`.file-empty`(卡片内分区)。
  - `.diff-line/-add/-del/-hunk`(增删行染色:block、红/绿/蓝底)、`.ctext-preview-line.diff-*`(预览态淡底)、
    `.diff-pre`、`.diff-stat/-add/-del`、`.file-content-pre`、`.search-results-pre`。

## 验证
- `make bindings`(bindings 不入库,dev/build 前生成)→ `cd frontend && bun run build`(tsc + vite production)
  通过,无类型/编译错误(仅预存在 chunk>500kB 警告,与本次改动无关)。
- `cd frontend && bun run test`:`streamMerge.test.ts` 14 pass / 0 fail(回归)。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿
  (acp/chat/config/fsview/harness/store/terminal/titlegen/ui/update/worktree 全 ok;无 Go 改动,仅回归)。
- `git status` 仅三个源文件:`CollapsibleText.tsx` / `ChatView.tsx` / `index.css`;
  bindings/dist/node_modules 均被 gitignore;AGENTS.md / RAK 运行时文件未动。

## 下一步
- 手动在 wails3 dev 验证:
  - edit:old/new 改动 − 红 / + 绿行染色、+N/−M 统计、长 diff 折叠/展开/预览三态染色一致;
    write_file 纯内容(无强绿底);apply_patch 的 `@@`/`+++`/`---` 染色正确;失败时 output 出现。
  - read_file:路径徽章 + 内容折叠;长文件默认折叠(首尾+省略)、展开可双向滚动。
  - grep:pattern 徽章 + 结果数 + 结果列表;glob 同卡(路径列表)。
  - 各卡在 ToolGroup(连续 ≥2 工具)内仍正常。
- 后续可选:edit 卡的 old/new 最小化 diff(目前是删除段+新增段,非行对齐);grep 结果按文件分组成树;
  这些是形态增强,当前实现已满足「不裸露 JSON + 增删高亮 + 长内容折叠」的硬约束。
