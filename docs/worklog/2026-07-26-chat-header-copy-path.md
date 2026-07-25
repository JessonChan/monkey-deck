# 2026-07-26 ChatView 头部加「复制项目路径」按钮

## 起因

Task #23067。`ChatView` 头部已有「切换终端」按钮,但缺一个快速复制当前项目路径的入口。
用户想拿到 session 锚定的项目目录路径,此前只能去侧栏项目行右键 → 「Copy working directory」
(`Sidebar.tsx` ctx-menu),路径绕。头部紧挨 `projectName / sessionTitle`,在此放一个一键复制
按钮最顺手,也与其他 copy 入口(`MessageActions`、`CodeBox`、侧栏 copyWorkdir)形态一致。

## 改法

`ChatView.tsx` 主组件(`chat-header-actions` 内,terminal 按钮之前)新增一个 `icon-btn small`:

- **动作**:`navigator.clipboard.writeText(props.project.path)` —— 与侧栏 copyWorkdir 同一通道。
- **copied 反馈**:`copiedPath` state(1.5s 回落),复制后图标 `Copy → Check`、tooltip 文案切到
  「已复制」—— 镜像同文件 `MessageActions`(L802)的 `copyMessageTip ↔ messageCopiedTip` 双文案模式。
- **无 project 禁用**:`disabled={!props.project}`。空态(无选中项目)时按钮灰掉不可点;
  `copyPath` 内部再加一道 `if (!p) return` 兜底,防止 disabled 被绕过。
- **tooltip**:`react-tooltip`(`data-tooltip-id="md-tip"`,§4.5),不用原生 `title`。
- **i18n**:`chat.copyPathTip` / `chat.pathCopiedTip`(en + zh),放 `toggleTerminal` 之后聚类。

### 图标选择说明

任务名里的「FolderCopy」指动作语义(复制 folder 路径),非字面图标要求 —— `lucide-react@1.21.0`
**没有 `FolderCopy` 图标**(查 `node_modules/lucide-react/dist/lucide-react.d.ts` 的 `@name Folder*`
清单:Folder / FolderCheck / FolderOpen … 无 FolderCopy)。故沿用本文件 4 处既有 copy 按钮
(`CodeBox`、`copyIn`、`copyOut`、`copyCmd`)统一的 `Copy → Check` 图标,保证视觉/交互一致;
tooltip 文案已说清复制的是「项目路径」,语义无歧义。

### data-testid

`data-testid="copy-path-btn"`(§4.2)—— 文本选择器在多按钮头部易冲突,用 testid 稳。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - 新增 `copiedPath` state + `copyPath` useCallback(`props.project?.path` 依赖)。
  - `chat-header-actions`:status-badge 与 terminal 按钮之间插入复制路径按钮(disabled +
    tooltip + Copy↔Check + testid)。
- `frontend/src/i18n/locales/en.json`、`zh.json`:`chat.copyPathTip` / `chat.pathCopiedTip`。
- `docs/worklog/2026-07-26-chat-header-copy-path.md`:本条。

## 验证

- `bun install`(worktree 无 node_modules)。
- `wails3 generate bindings -ts`(bindings 不入库,补齐 .ts 才能跑 tsc;默认无 `-ts` 只出 .js +
  JSDoc,而 tsconfig 无 `allowJs`,tsc 解析不了)。
- `npm run build`(= `tsc && vite build --mode production`):**通过**(tsc 无错;仅既有 chunk
  体积告警,非本次引入)。
- 视觉/交互待实机:`wails3 dev` 看:(1) 有 project 时点按钮 → 剪贴板得 project.path、图标变 ✓、
  tooltip 变「项目路径已复制」、1.5s 回落;(2) 空态(无 project)按钮灰掉不可点;(3) 中英切语言
  tooltip 文案跟随。

## 下一步

- 实机抽验上述三项(macOS WebKit)。
- 若用户反馈路径复制需求扩展(如复制 worktreePath 而非 project.path),再按 session.worktreePath
  是否存在切换目标(当前 KISS:只复制 project.path,与侧栏 copyWorkdir 对齐)。
