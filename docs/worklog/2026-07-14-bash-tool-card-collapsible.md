# bash 工具输出卡片化(折叠+分层,仅 bash)

## 起因
Task #15075。工具调用原先统一用「通用 ToolCard」渲染:输入/输出两段 `<pre>`(白底等宽),
长输出靠 `.tool-pre` 的 `max-height:280px` 限高滚动,行内 `white-space: pre-wrap` 会自动折行——
对 bash 的终端输出体验不好(长行被折断、命令与输出混在一起不直观)。需要把 **bash 工具单独**
做成终端风卡片:头(名+状态/exit+折叠 toggle)+ 体(命令行 + 折叠输出区),长输出首尾+省略默认折叠,
等宽保留换行、横向滚动不撑破布局。edit/grep/glob 留给后续 issue,本 task 不碰。

## 设计取舍
- **范围严格限定 bash**:用 ACP `ToolKindExecute="execute"` 判定(命令执行类工具的协议标准 kind,
  opencode 的 bash 工具即此 kind)。`ToolCard` 改为纯分派层(不持 hook),`kind==="execute"` 走
  `BashToolCard`,其余走 `GenericToolCard`(原逻辑原样搬过去,零行为改动)。
  - 分派层不持有 hook:避免「早返回分支 hook 顺序不一致」违反 React Rules of Hooks。
- **可复用折叠件 `CollapsibleText`**:把「长文本首尾+省略折叠 / 展开全文双向滚动」抽成独立组件
  (形态沿用本项目 Composer / 用户气泡的长文本折叠先例,见 `2026-07-14-composer-long-text-collapse.md`)。
  本 task 只接入 bash 输出,grep/glob/edit 输出后续可直接复用(§5.3 references 优先参考自家先例)。
  - 短文本(行 ≤ 24 且字符 ≤ 1000):直接等宽 `<pre>`,横向滚动,保留换行。
  - 长文本:默认折叠(首 8 行 + 省略条「⋯ N 行已折叠(点击展开)⋯」+ 末 6 行);展开后完整 `<pre>`
    (`max-height:320px` 纵向滚动 + 横向滚动)。阈值/首尾行数可配。
- **横向滚动不撑破布局(§4.4)**:bash 命令行 / 输出 `<pre>` 一律 `white-space: pre` + `overflow-x: auto`
  (不 wrap),长行横向滚动而非折行;折叠预览的每行 `text-overflow: ellipsis` 截断。
- **绝不对用户裸露结构化格式(§4.4)**:命令用 `extractBashCommand` 从 rawInput 抽 `command/cmd/line`
  (兜底 argv 数组拼回),输出复用已有 `extractToolText`(抽 `output` 主文本 + exit/truncated 元信息),
  找不到才回退。绝不把 `{...}` JSON 抛给用户。
- **头部「状态/耗时」**:status 徽章复用原 `TOOL_STATUS_MAP`;exit code 作独立徽章(0=绿/非0=红)。
  耗时(duration)数据模型里没有(后端未追踪 tool 耗时),纯前端 task 无法凭空造,故以 exit code 代替
  (对 bash 而言 exit 比 duration 更有信息量)。
- **零新依赖**:复用 `lucide-react`(`Terminal` 图标,确认存在)+ 已有 `react-tooltip`(`data-tooltip-id="md-tip"`)。
- **连续工具组兼容**:bash 卡片同样可用于 `ToolGroup`(连续 ≥2 个 tool 折叠组)内部——className 含
  `tool-card`,继承 `.tool-group .tool-card { padding:0; max-width:none }`。

## 改了哪些文件
- `frontend/src/components/CollapsibleText.tsx`(新增):可复用折叠文本块。
  - props:`text` + 阈值(`longLineThreshold/longCharThreshold/headLines/tailLines`)+ `className/previewClassName/preClassName`
    + `copyable/extra/lineUnit/testId`。
  - 短/长两态:长态 meta 行(行·字符计数 + 复制 + 展开/收起 toggle)+ 折叠预览/全文 pre。
- `frontend/src/components/ChatView.tsx`:
  - import 加 `CollapsibleText`、lucide `Terminal`。
  - `ToolCard` 改纯分派层(无 hook):`kind==="execute"` → `BashToolCard`,否则 `GenericToolCard`。
  - `GenericToolCard`:原 `ToolCard` 通用逻辑原样搬入(输入/输出两段 pre),零行为改动。
  - `BashToolCard`:头(`Terminal`/spinner + 名 + exit 徽章 + 状态)+ 体(`.bash-cmd` 命令行 + `.bash-out` 折叠输出)。
  - `exitCls(exit)`、`extractBashCommand(raw)` 辅助函数。
- `frontend/src/index.css`:
  - `.bash-exit/-ok/-fail`、`.bash-cmd/-head/-prompt/-label/-pre`、`.bash-out/-note`、`.bash-out-ctext` 覆盖。
  - `.ctext/-meta/-count/-actions/-toggle/-pre/-preview/-preview-pre/-preview-line/-preview-divider`(可复用折叠件样式)。
  - 命令/输出 `<pre>` 统一 `white-space:pre; overflow-x:auto; tab-size:4`,终端深底色 `#131316`。

## 验证
- `make bindings`(bindings 不入库,dev/build 前生成)→ `cd frontend && bun run build`(tsc + vite production)通过,
  无类型/编译错误(仅预存在的 chunk>500kB 警告,与本次改动无关)。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿(无 Go 改动,仅回归;
  acp/chat/config/fsview/harness/store/terminal/titlegen/ui/update/worktree 全 ok)。
- `git status` 仅 `ChatView.tsx` / `index.css` / 新增 `CollapsibleText.tsx` 三个源文件;
  bindings/dist/node_modules 均被 gitignore;AGENTS.md / RAK 运行时文件未动。

## 下一步
- 手动在 wails3 dev 验证:bash 命令(单行/多行)命令行横向滚动;短输出直接展示;长输出默认折叠
  (首尾+省略条)、点展开全文可双向滚动、点收起回折;exit 0/非0 徽章配色;复制命令/输出;
  bash 在 ToolGroup 内连续出现时仍正常。
- 后续 issue:edit/grep/glob 的 I/O 卡片化(复用 `CollapsibleText`);bash 输出 ANSI 颜色码渲染(当前原样输出,
  如 `\x1b[...m` 会以字面量显示,opencode 多数场景已 strip,暂不处理)。
