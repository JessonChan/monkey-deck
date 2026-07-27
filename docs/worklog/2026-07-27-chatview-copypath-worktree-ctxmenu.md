# 2026-07-27 ChatView copyPath 优先 worktreePath + 对话区右键菜单

**类型**:feat(chat)

> Task #23430。两件小事一件提交:头部 copyPath 路径源修正 + 对话区补右键菜单(复用 Sidebar ctx-menu 范式)。

## 起因

1. **copyPath 路径源不对**:ChatView 头部「复制项目路径」按钮(`copyPath`)只读 `props.project?.path`。但本项目 session 走 git worktree 模型(§1.4):session 的真实工作目录是 `session.worktreePath`(在 `<dataDir>/worktrees/<session-id>`),与项目主目录是两个路径。worktree session 下复制到的是项目主目录、而非 agent 实际干活的 worktree 路径 —— 与 `App.tsx:1208` 的 `termCwdRef.current = activeSession?.worktreePath || selectedProject?.path`(worktree 优先)同一套语义缺口。

2. **对话区无右键菜单**:Sidebar 的项目 / session 行都有右键菜单(复制工作目录 / 在 Finder 打开 / …),但 ChatView 对话区(`.chat-body`)只有头部一个 copy 按钮,右键只出浏览器默认菜单,缺少「复制 / 打开当前工作目录」这类高频操作入口。

## 改法

### 1. copyPath 优先 worktreePath 降级 project.path

- 新增 `activePath = props.session?.worktreePath || props.project?.path || ""`,与 `App.tsx` 的 termCwd 同一套优先级(worktree 优先 → 项目目录)。
- `copyPath` 改为写 `activePath`;`useCallback` 依赖 `[activePath]`(随 session/project 切换自动更新)。
- 头部按钮 `disabled` 由 `!props.project` 改为 `!activePath`(语义对齐:无任何路径才禁用)。

### 2. 对话区右键菜单(复用 Sidebar ctx-menu 范式)

仓库无共享 ContextMenu 组件、无 ctx-menu 库;Sidebar / TerminalPanel 都是手滚 `useState<{x,y}>` + `position:fixed` + 全局 `mousedown`/`keydown`/`resize` 关闭 + `useLayoutEffect` 视口裁剪。`.ctx-menu`/`.ctx-item`/`.ctx-sep` CSS 已在 `index.css` 全局复用。本次按同一范式在 ChatView 内复制一份(与 Sidebar 平行,不抽公共组件 —— 重复 3 次再抽象,§5.3 KISS):

- `ctxMenu` state + `ctxMenuRef` + `openCtxMenu`(挂到 `.chat-body` 的 `onContextMenu`)。
- `useEffect`:菜单打开时注册 Esc / outside-mousedown / window-resize 关闭;关闭即摘监听。
- `useLayoutEffect`:按 `menuRef` 实测宽高 + pad=8 做视口裁剪,防溢出。
- 菜单项只放与工作目录相关的两项(与 Sidebar 项目菜单的路径项对齐,复用既有 i18n key,不新增):
  - 「复制工作目录」(`sidebar.copyWorkdir`)→ 复用 `copyPath()`(写 `activePath` + copied 反馈)。
  - 「在 Finder 打开」(`sidebar.revealInFinder`)→ `ChatService.RevealPath(activePath)`。
- 菜单容器 `onMouseDown stopPropagation`(与 Sidebar 一致):防止点菜单项时 outside-mousedown 先关菜单、导致 onClick 丢失。
- `openCtxMenu` 入口 `if (!activePath) return;`:无路径时不拦截、交给浏览器默认菜单(不强行弹空菜单)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - import 加 `FolderOpen`(lucide-react)。
  - 加 `activePath` 派生 + `copyPath` 改路径源 + 按钮 `disabled` 改条件。
  - 加 `ctxMenu` state + `openCtxMenu` + 关闭/裁剪两个 effect + 菜单 JSX。
  - `.chat-body` 加 `onContextMenu={openCtxMenu}`。
- 未新增 / 改 i18n key(复用 `sidebar.copyWorkdir` / `sidebar.revealInFinder`)。
- 未新增 CSS(复用 `index.css` 的 `.ctx-menu` / `.ctx-item`)。

## 验证

- `npm run build`(frontend = `tsc && vite build`,先 `wails3 generate bindings` 生成未入库 bindings):零 TS / 编译错误。
- `go build ./...` + `go vet ./...`:clean(仅有 macOS 版本号链接告警,与本改动无关)。
- 复用既有 `.ctx-*` CSS + i18n key,视觉 / 文案与 Sidebar 右键菜单一致。

## 下一步

- 桌面实测:worktree session 右键对话区 → 复制 / Reveal 拿到的应是 worktree 路径(`<dataDir>/worktrees/<session-id>`),非项目主目录。
- 头部 copy 按钮 tooltip 文案目前仍是「复制项目路径」(`chat.copyPathTip`);worktree session 下略不准确,但概念上用户可理解,暂不动 i18n。若后续要精确化,可改成「复制工作目录」(与 `sidebar.copyWorkdir` 统一)。
