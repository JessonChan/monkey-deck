# 2026-08-09 session custom_title 字段 + 侧栏右键重命名(Task #24234)

## 起因

用户希望能给会话自定义命名(重命名),而**不丢失 harness 自动生成 / 首条消息兜底的原标题**。
原 `sessions.title` 字段同时承担「auto 标题」(被 `maybeAutoTitle` / `syncSessionTitle` /
`session_info_update` 反复覆盖)与「展示名」两个职责,直接改它会:① 被下一次 auto 标题回流覆盖;
② 丢失原标题出处。需要一个独立字段承载用户重命名。

## 设计(根因:字段职责分离)

新增 `sessions.custom_title`(0016),与 `title` 分离:

- **展示优先级**:`custom_title || title || 兜底文案`。custom_title 非空时用它,否则回退 auto title。
- **不改排序键**:重命名不动 `prompted_at` / `updated_at` / `pinned`(与置顶同一理由:rename 不是
  内容活动,不应影响侧栏排序与「时间」显示)。`UpdateSessionCustomTitle` 只写 `custom_title` 列。
- **可逆**:空串 = 清除 custom_title,回退 auto title。
- **auto 标题通道不受影响**:`maybeAutoTitle` / `syncSessionTitle` 仍只写 `title`,与 custom_title 正交。
- **tooltip 揭示原标题**:设了 custom_title 且原 title 非空时,session-label hover 显示「原标题:xxx」,
  避免重命名后丢失出处(§4.5 统一 tooltip 用 react-tooltip / `data-tooltip-id="md-tip"`)。

## 改法

### 后端(Go)

- `internal/store/migrations/0016_session_custom_title.sql`:`ALTER TABLE sessions ADD COLUMN custom_title TEXT NOT NULL DEFAULT ''`。
- `internal/store/store.go`:`Session` 结构体加 `CustomTitle string \`json:"customTitle"\``。
- `internal/store/sessions.go`:`sessionColumns` 加 `custom_title`;`scanSession` 加 `&se.CustomTitle`;
  新增 `UpdateSessionCustomTitle(ctx, id, customTitle)`(只写 custom_title,不动 updated_at)。
- `internal/chat/chat.go`:新增导出方法 `ChatService.UpdateSessionCustomTitle(sessionID, customTitle)`
  透传 store(Wails3 binding → 前端)。
- `wails3 generate bindings`:重新生成,`Session.customTitle` 字段 + `UpdateSessionCustomTitle` 方法进入 bindings。

### 前端(React)

- `Sidebar.tsx`:
  - 新增 prop `onRenameSession`、state `renamingId` / `renameValue`。
  - 右键菜单「重命名」项(Pencil 图标,置顶项之后),点击进入 inline 编辑态(用 `customTitle || title` 初始化)。
  - 编辑态:整行换成 `<input>`,Enter 提交 / Esc 取消 / blur 提交;空串 = 清除回退。
  - label 显示 `customTitle || title || 兜底`;设了 custom_title 且原标题非空时 label tooltip 揭示原标题。
- `App.tsx`:新增 `renameSession` callback(调 `ChatService.UpdateSessionCustomTitle` + 乐观就地更新
  `sessionsByProject`,**不重排**——rename 不改排序键);传 `onRenameSession` 给 Sidebar。
- 一致性(§4.4):TabBar 标题、ChatView 头部、关闭 Tab 确认框的标题展示统一改为 `customTitle || title || 兜底`,
  避免重命名只在侧栏生效、其它位置仍显示旧标题的割裂。
- `index.css`:`.session-rename-input` 样式(复用 search-input 风格,紧凑行高对齐 session 行)。
- i18n:`sidebar.rename`(Rename / 重命名)、`sidebar.originalTitleTip`(Original title: {{title}} / 原标题:{{title}}),
  en.json + zh.json。

## 改了哪些文件

- `internal/store/migrations/0016_session_custom_title.sql`(新增)
- `internal/store/store.go`、`internal/store/sessions.go`、`internal/store/store_test.go`
- `internal/chat/chat.go`
- `frontend/bindings/...`(wails3 重新生成)
- `frontend/src/components/Sidebar.tsx`、`frontend/src/components/ChatView.tsx`
- `frontend/src/App.tsx`、`frontend/src/index.css`
- `frontend/src/i18n/locales/en.json`、`frontend/src/i18n/locales/zh.json`

## 验证

- `go build ./internal/...` ✅(`main.go` 的 `all:frontend/dist` embed 报错是构建产物缺失的固有项,与本次无关)
- `go vet ./internal/...` ✅
- `go test ./internal/...` ✅(全 pass;新增 `TestUpdateSessionCustomTitle` 覆盖设置/覆盖/清除 + 不动 updated_at + title 不被覆盖)
- `cd frontend && bun run build` ✅(tsc + vite 全过)
- `cd frontend && bun test --isolate`:`src/i18n/` 全 pass;5 个 `NewSessionModal` 失败**为预先存在**(stash 本改动后同样失败,git/worktree 环境导致,与本次无关)。

## 下一步

- 可选:多窗口(popout)同步——目前 rename 走乐观本地更新(与 `toggleSessionPin` 同模式),popout 窗口
  不会自动同步;若需要,可加一个 `chat:session-meta` 风格的事件推 custom_title 变更。当前单窗口场景已够用。
- 可选:重命名 input 的 IME 组合输入处理(回车确认与中文输入法候选的冲突),目前用 Enter 提交,
  中文输入法回车选词时可能误触发——观察是否需要 `compositionstart/end` 守卫。
