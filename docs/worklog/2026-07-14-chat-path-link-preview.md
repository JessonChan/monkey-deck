# 对话中文件路径点击打开预览/定位(path:line)

## 起因
Task #15084。对话(agent markdown、用户消息、思考块、工具 I/O 输出)里经常出现文件路径
(`src/foo.ts`、`./bar.go:10`、`path:line`),用户只能复制到外部编辑器查看。要让这些路径
变成可点击,点击后在文件面板预览,有行号则定位/滚动到该行。

## 设计取舍
- **纯前端、零新依赖**:不引入 markdown-it-xxx / autolink 之类插件,自己写正则 + React
  组件。路径识别、链接化、覆盖层全在前端完成;复用既有 `ChatService.SessionReadFile`
  (FilePanel 的 openFile 已用)+ fsview 后端,后端零改动。
- **识别策略(收敛误伤,§4.4 不把噪声当路径)**:
  1. 末段必须带扩展名(字母开头 + 字母数字 1-8 位)—— 排除 `src/foo`、`node_modules`。
  2. 整体必须含 `/`(由前缀 `./` `../` `~/` `/` 或中间段提供)—— 排除裸单词 `foo.ts`、`e.g.`。
  3. 前导 lookbehind `(?<![\w./-])`:避免在更长 token 中部截断;同时天然跳过 `http(s)://`
     —— 协议段后的 `//` 的 `/` 会被前导边界阻断(外链走系统浏览器是后续 task,这里保证不误吞)。
  4. 后继 lookahead `(?![\w/])`:不吞掉更长路径 / 更长扩展名;`src/foo.tsx` 不会被截成 `.ts`。
  5. 可选 `:line[:col]`(行号 1-6 位数字),用于定位。
- **形态分层**:
  - **纯逻辑层**(`lib/filePath.ts`):`findPathSpans` / `splitByPaths`,无 React 依赖,
    bun test 单测覆盖(13 例:正例 + 误伤排除 + 扩展名边界 + 行末标点不吞入)。
  - **React 包装**(`components/PathLinkified.tsx`):把一段字符串渲染成「文本 + .path-link」
    交错;点击调 `onOpen(path, line?)`,由上层路由。
  - **预览覆盖层**(`components/FilePreviewOverlay.tsx`):加载 `SessionReadFile` 内容,
    按行渲染(`<div data-line>`),有 line 则高亮目标行 + scrollIntoView(center)。复用既有
    `.preview-overlay/.preview-card/.preview-head` CSS。
- **三处接入点(全覆盖)**:
  1. **agent markdown**(ReactMarkdown):自定义 `p` / `li` / `td` renderer(`makeTextLinkifyRenderer`),
     把文本 child 节点用 PathLinkified 包起来;`code` / `pre` / `a` 保持原样(不破坏代码语义)。
     用 `AgentMarkdown` 子组件封装,`useMemo` 缓存 components(避免每次 render 新建 renderer 导致
     ReactMarkdown 重解析)。
  2. **用户消息**(`UserBubble`):markdown 走 AgentMarkdown;mono / prose 走 PathLinkified。
  3. **思考块**(`ThoughtBlock`):thought-text 走 PathLinkified。
  4. **工具卡片**:`CollapsibleText` 新增可选 `onPath?: (path, line?) => void` —— 提供时把每行
     里的路径识别成 .path-link(与既有 `lineClassName` diff 染色可组合);短态/展开态/折叠预览态
     **三态一致**渲染。bash / edit(diff)/ read / search / generic 卡片均传 `onPath={openFilePreview}`。
     `GenericToolCard` 的 input/output `<pre>` 直接套 `<PathLinkified>`(行级识别)。
- **样式**:`.path-link` accent-2 色 + 点状下划线,hover 高亮,focus-visible 描边(键盘可达)。
  预览层加 `.preview-pre-lined` / `.preview-line` / `.preview-line-no` / `.preview-line-target`
  (黄色高亮 + 左侧色条)。
- **不改动 FilePanel**:FilePanel 树点击已有自己的预览(形态一致),无需统一;本 task 只做对话
  → 预览的入口。后续若要全局统一预览态可再重构。

## 改了哪些文件
- `frontend/src/lib/filePath.ts`(新):`PATH_RE` + `findPathSpans` + `splitByPaths`。
- `frontend/src/lib/filePath.test.ts`(新):13 例 bun test 回归。
- `frontend/src/components/PathLinkified.tsx`(新):字符串 → 文本 + .path-link 交错渲染。
- `frontend/src/components/FilePreviewOverlay.tsx`(新):加载 + 行号化 + 定位/高亮 + Esc 关闭。
- `frontend/src/components/CollapsibleText.tsx`:加 `onPath?` prop;`renderLine` 在 lineClassName
  之外额外做路径链接化,短/展开/折叠预览三态一致。
- `frontend/src/components/ChatView.tsx`:
  - 加 `previewTarget` state + `openFilePreview` / `closeFilePreview`,渲染 `<FilePreviewOverlay>`。
  - 主循环 / `ChatRow` / `ToolGroup` / `ToolCard` / `UserBubble` / `ThoughtBlock` / 各 ToolCard
    全部接收并下传 `onOpenFilePreview`。
  - 新增 `AgentMarkdown`(封装 ReactMarkdown + p/li/td renderer)+ `makeTextLinkifyRenderer`
    + `linkifyReactChildren` 辅助。
  - agent / user-markdown 改用 `<AgentMarkdown>`;user mono/prose 与 thought-text 用 PathLinkified;
    GenericToolCard 的 input/output `<pre>` 套 PathLinkified。
- `frontend/src/index.css`:`.path-link` / `.preview-pre-lined` / `.preview-line(-no/-text/-target)`
  / `.preview-error` / `.preview-loading` / `.diff-line .path-link` 等。

## 验证
- `wails3 generate bindings` 重新生成(bindings 不入库)。
- `cd frontend && bun run build`:tsc + vite production 构建通过(仅预存在 chunk>500kB 警告,
  与本次无关)。React 19 下 `React.createElement` + `React.ReactNode` 用法 OK(默认导入 React)。
- `cd frontend && bun test`:27 pass / 0 fail(streamMerge 14 + filePath 13,全绿)。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿
  (acp/chat/config/fsview/harness/store/terminal/titlegen/ui/update/worktree 全 ok;无 Go 改动)。
- `git status`:仅 7 个前端源文件(3 改 + 4 新);bindings / dist / node_modules / AGENTS.md /
  RAK 运行时文件均未动(.rak-env / opencode.json / .gitignore 已排除)。

## 下一步
- 手动 wails3 dev 验证:
  - agent 说「改了 src/foo.ts:42」→ 点击 → 预览弹出 + 第 42 行高亮居中。
  - bash 输出 `src/a.ts:1: error ...` 点击 → 预览定位第 1 行。
  - grep 结果 `path:line:content` 点击 → 预览定位。
  - edit diff 行内的路径(在 +/- 染色行里)仍可点击且样式可辨。
  - 用户长文本(日志)折叠态 / 展开态点击路径都能打开预览。
- 已知边界:绝对路径 `/abs/path.ts` 也会识别 —— 但 `SessionReadFile` 钉在 session cwd,
  绝对路径会被 safeJoin 拒(ErrEscapesRoot)→ 预览层显示「读取失败」。可接受(用户可见错误,
  不静默);若要优化可在 onOpen 里做一次「绝对路径 → 相对 cwd」换算。
- 外链(http/https)目前不被识别为文件路径(前导边界阻断),但仍以纯文本展示;「外链走系统浏览器」
  是独立 task,不在本 task 范围。
