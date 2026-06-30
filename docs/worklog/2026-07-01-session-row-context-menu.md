# 2026-07-01 侧栏会话行左键菜单(激活/复制 ID/Finder 打开/删除)

## 起因
用户发现侧栏会话(session)项只有「点击激活」一个交互,缺项目级那样的操作菜单。用户要求给会话标题加一个**左键菜单**,菜单项:
- **复制会话 ID** —— 排障/对接用
- **在 Finder 打开** —— 尤其 worktree session,直接定位到隔离工作目录
- **删除会话** —— 硬删除(DB 记录也清掉)
- **不做重命名** —— ACP 协议不支持改 session title(opencode 自生成,客户端不该再调 LLM;§5.4 #14)

## 现状核查(开工前)
- 项目级已有右键菜单(`Sidebar.tsx` 的 `ctx` state + `.ctx-menu`/`.ctx-item` CSS),含「复制工作目录 / 在 Finder 打开 / 移除项目」。会话项只有一个 `<button onClick={onSelectSession}>`,无任何菜单。
- 后端 `ChatService.DeleteSession(sessionID)`(`internal/chat/chat.go:394`)已存在且已 binding:关活跃 harness + `cleanupWorktree` + 删 DB 记录。**Go 侧零改动**。
- 后端 `ChatService.RevealPath(path)`(`internal/chat/dialog.go:48`)已存在且已 binding,macOS 走 `open`。
- `Session` model(`store/models`)有 `worktreePath` 字段 —— Finder 打开可直接用,无 worktree 时该项不显示。
- 分支核查:`git branch --no-merged main` 为空,**无未合并功能分支**;`md/*` 都是 per-session worktree 分支(§1.4),非待合并功能。

## 改法

### 1. Sidebar.tsx —— 会话行重构 + 左键菜单
**结构变更**(关键:JSX 不允许 `<button>` 嵌 `<button>`,原来会话项是单个 `<button class=session-item>`,要加菜单按钮必须先拆):
- 原:`<button class="session-item">` 一个按钮包全部
- 新:`<div class="session-item-row">`(外层,承载 hover/active 背景 + 给菜单钮留位)
  - `<button class="session-item-main">`(flex:1 占满,点击激活对话,内含 dot/label/状态指示)
  - `<button class="session-menu-btn">`(⋮ 图标,hover/active 时 `display:flex` 显出,左键打开菜单)

**菜单 state 类型升级**为判别联合(discriminated union),项目级与 session 级共用一套关闭逻辑(Esc / 外部 mousedown / resize):
```ts
type Ctx =
  | { kind: "project"; x: number; y: number; project: Project }
  | { kind: "session"; x: number; y: number; session: Session };
type ConfirmTarget =
  | { kind: "project"; project: Project }
  | { kind: "session"; session: Session };
```

**菜单位置**:session 菜单由 `⋮` 按钮点击触发,取 `.session-item-row` 的 `getBoundingClientRect()`,菜单**右对齐于该行底部**(`right = window.innerWidth - rect.right`,`top = rect.bottom`)。与项目级右键菜单用 `left/clientX` 区分。

**菜单项**:
- 激活对话(当前已选中时 `disabled`,避免重复触发 selectProject 重载)
- 复制会话 ID(`navigator.clipboard.writeText(session.id)`)
- 在 Finder 打开 Worktree(仅 `session.worktreePath` 非空时渲染,`ChatService.RevealPath(worktreePath)`)
- 删除会话(danger,进确认弹窗 → `props.onRemoveSession`)

**Props 新增**:`onRemoveSession: (sessionId: string) => void`。

### 2. App.tsx —— removeSession handler + 接线
新增 `removeSession` useCallback(紧随 `removeProject`):
1. `await ChatService.DeleteSession(sessionId)` —— 后端关 harness + 清 worktree + 删 DB
2. 从 `sessionsByProject` 移除该 session(遍历所有 project 的 list filter)
3. 清掉该 session 的**全部 per-session 缓存**(items/hasMore/usage/status/statusDetail/activity/unread/permission/queue/draft/history/attachments/mentions/configOptions + `queueBySessionRef` + `oldestSeqRef` + `loadedSessionsRef` + `historySeededRef`)—— 用一个内联泛型 `drop` helper 统一删 key,避免删错漏删导致 stale 缓存残留
4. 若是当前选中,`setSelectedSessionId(null)`

`<Sidebar>` 接线新增 `onRemoveSession={removeSession}`。

### 3. index.css —— 新结构样式 + disabled 态
- 删旧 `.session-item*` 规则(7 条),换成 `.session-item-row` / `.session-item-main` / `.session-menu-btn`(13 条):行级 hover/active 背景、main 区 flex:1 + 原 padding、菜单钮 22×22 默认 `display:none` 行 hover/active 时显出。
- `.ctx-item:disabled` + `:disabled:hover`:激活对话在已选中态置灰、不响应 hover。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/components/Sidebar.tsx` | 会话行拆 div+双 button;`Ctx`/`ConfirmTarget` 判别联合;`openSessionMenu` 取 rect 右对齐定位;session 菜单 4 项 + 删除确认弹窗;Props 加 `onRemoveSession` |
| `frontend/src/App.tsx` | 新增 `removeSession`(后端删除 + 全 per-session 缓存清理 + 选中态清空);`<Sidebar>` 接 `onRemoveSession` |
| `frontend/src/index.css` | `.session-item*` → `.session-item-row/-main/-menu-btn`;`.ctx-item:disabled` 态 |

**Go 零改动** —— `DeleteSession`/`RevealPath` 早已 binding,无需 `wails3 gen bindings`。

## 验证
- `npx tsc --noEmit`(frontend)exit 0,无诊断。
- `go build . ./internal/... ./cmd/...` exit 0(Go 无改动,顺带回归)。
- 逻辑审查:
  - 会话行点击激活路径不变(`session-item-main` 的 onClick 与原 `session-item` 一致),菜单钮 `stopPropagation` 不误触激活。
  - 菜单关闭三件套(Esc/外部 mousedown/resize)对项目级与 session 级统一生效。
  - 删除确认弹窗与项目移除弹窗共用 `ConfirmTarget` 类型,互斥(一次只一个)。
  - `removeSession` 的 `drop` helper 是纯函数,泛型 `<T,>` 在 .tsx 里需尾逗号避歧义。

## 权衡 / OPEN
- **未做实机验证**:`wails3 dev` 跑一轮,确认菜单定位(右对齐底部不溢出窗口)、worktree session 的 Finder 打开命中隔离目录、删除后侧栏即时消失且切回不残留。需 GUI。
- **激活对话 disabled 而非隐藏**:已选中时菜单仍显示该项但置灰,让用户知道「这就是当前会话」;也可改成隐藏,看后续反馈。
- **Finder 打开仅 worktree**:非 worktree session(git 项目未勾独立分支 / 非 git 项目)不显示该项,因为「打开项目目录」项目级菜单已有,会话级重复无意义。若用户想要会话级也开项目目录,可去掉 `worktreePath &&` 守卫。

## 提交说明
```
feat(sidebar): 会话行左键菜单 —— 激活/复制 ID/Finder 打开 worktree/删除
```
