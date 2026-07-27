# 2026-07-27 Sidebar session 右键菜单补「复制工作目录」

**类型**:feat(sidebar)

> Task #23437。session 行右键菜单原先只有「复制会话 ID」,缺复制工作目录的入口;项目行右键菜单早就有「复制工作目录」(`sidebar.copyWorkdir`),对话区右键菜单(Task #23430 / ce348e9)也有。本条把 session 行右键菜单补齐:在「复制会话 ID」与「在 Finder 打开 Worktree」之间插入「复制工作目录」,路径解析与对话区 copyPath 同一套优先级(worktree 优先 → 项目目录降级)。

## 起因

session 行右键菜单与项目行 / 对话区不一致:项目行能复制工作目录、对话区也能,唯独 session 行只有「复制会话 ID」。用户在 session 维度想拿工作目录路径,得先去项目行或对话区——多余跳转。

补齐后三个入口的「复制工作目录」语义统一(`sidebar.copyWorkdir`),路径解析也统一:`session.worktreePath || project.path`。

## 改法

### session 右键菜单插一项

位置:Sidebar.tsx session ctx-menu,「复制会话 ID」(`sidebar.copySessionId`)之后、「在 Finder 打开 Worktree」(`sidebar.revealWorktree`,仅 worktree session 显示)之前。

- 图标 / 文案:复用 `<Copy size={13} />` + `sidebar.copyWorkdir`(与项目行菜单完全一致,零新增 i18n key)。
- 路径解析:`ctx.session.worktreePath || props.projects.find(p => p.id === ctx.session.projectId)?.path || ""`——worktree 优先,降级到所属项目目录(与 ChatView `activePath` / App `termCwdRef` 同一套优先级,§1.4 目录是锚点)。
- 无路径兜底:写空串(clipboard.writeText(""));实际不会发生——session 必有 projectId 且项目必在 `props.projects` 里(否则 session 行根本不渲染)。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx`:session ctx-menu 在 copySessionId 与 revealWorktree 之间插「复制工作目录」按钮。

## 验证

- `wails3 generate bindings` + `bun run build`(frontend = `tsc && vite build`):零 TS / 编译错误。
- session 行右键菜单顺序:激活 / 置顶 / 复制会话 ID / **复制工作目录** / 在 Finder 打开 Worktree / 删除。

## 下一步

- 桌面实测:worktree session 复制得到 worktree 路径;普通项目 session 复制得到项目 path。
