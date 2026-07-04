# 2026-07-04 session 置顶(项目内会话恒在顶部)

## 起因

项目下 session 一多,常用的几条会话会被新对话挤下去,每次都要滚或搜。用户要求加**置顶**:置顶后该会话恒在项目列表顶部,取消后回到正常时序位。

## 设计 / 决策

核心赌注:**排序交给 DB,前端不另排**。现有侧栏 session 顺序本就是 DB 侧定的(`ListSessions` 的 `ORDER BY`),前端 `sessionsByProject` 直接吃这个顺序。所以置顶最省事、最不易漂移的做法是加一列 + 改 ORDER BY,而不是「前端把某项拉到顶」(那会和分页 slice、搜索 filter、live-title 刷新三处打架)。呼应 §5.3 找不变量不堆 if。

- **数据模型**:单一布尔列 `pinned`(照抄 `0004_project_allow_external.sql` 的 INTEGER 0/1 模板),不加 `pinned_at`。置顶组**内部**沿用 `prompted_at DESC`(最近活跃的在最上),与微信/Telegram 习惯一致。若日后要「固定序」再加 `pinned_at`,默认方案最小。
- **入口**:复用 session 行**已有的右键菜单**(`onContextMenu` → 激活/复制 ID/Finder/删除),加一项随 `s.pinned` 切换「置顶对话 / 取消置顶」(Pin / PinOff 图标)。不另开 hover 钉子按钮 —— session 行右侧状态簇是 perm/spinner/unread/draft/time 的**互斥链**,pin 是**正交**状态(置顶的同时也能在跑 turn),硬塞会打架或抖动。删会话都走右键菜单,置顶走它最一致。hover 按钮留作 v2。
- **置顶标记**:右侧状态簇**最前**一个 lucide `<Pin size={11}>`,仅 `s.pinned` 时渲染。常驻标记(弱色 `var(--accent)`),与瞬态活动状态正交、各占一格;`flex-shrink:0` 不挤压状态簇、状态簇 right-aligned 位置不抖。tooltip「已置顶 · 右键可取消」。不加背景 tint/左边条(一个图标够,§4.6 轻量、KISS),不够显眼再加。
- **视觉层级**:dot = 在干嘛(活动,强色),pin = 这条很重要(分类,弱色),两维度独立。
- **刷新策略**:用**乐观本地重排**,不调 `refreshSessions`。复刻 DB 排序 `pinned DESC, promptedAt DESC, updatedAt DESC` 做稳定 sort。理由:`refreshSessions` 全量替换会洗掉 turn 进行中的前端直播 title(就是 `2026-07-01-sidebar-session-search.md` 里修过的坑);本地重排规避它、即时。`SetSessionPinned` 后端不动 `updated_at`(置顶不是内容活动,不该影响「时间」显示与二级排序)。

## 改法

### 数据层
- `migrations/0008_session_pinned.sql`:`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;`。
- `store.go`:`Session` struct 加 `Pinned bool json:"pinned"`。
- `sessions.go`:`sessionColumns` 加 `,pinned`;`scanSession` 末尾加 `&se.Pinned`(modernc 支持 INTEGER→*bool,`AllowExternal` 已验证);`ListSessions` ORDER BY 改 `pinned DESC, prompted_at DESC, updated_at DESC`;新增 `SetSessionPinned(ctx, id, pinned)`(v:=0/1,不动 updated_at)。

### 后端 binding
- `chat.go`:`ChatService.SetSessionPinned(sessionID, pinned)` 透传 store。
- `wails3 generate bindings`:重生成(45 methods,9 models)。⚠️ 本次发现 alpha.106 生成器把 bindings 从 `.ts` interface 改成了 `.js` class + JSDoc(`@ts-check`),属 wails3 版本行为;bindings 是 gitignored 构建产物,以当前 wails3 输出为准,不手改。前端 `import type { Session }` 仍可用(class 名即类型)。

### 前端
- `Sidebar.tsx`:lucide import 加 `Pin, PinOff`;session 行 `<span className="session-label">` 后插 `{s.pinned && <span className="session-pin">…}`;session 右键菜单「激活对话」后加切换项;Props 加 `onTogglePin`。
- `App.tsx`:`toggleSessionPin` useCallback(后端落库 → `setSessionsByProject` 本地 flip + 稳定重排);`<Sidebar>` 接 `onTogglePin={toggleSessionPin}`。
- `index.css`:`.session-pin { flex-shrink:0; display:inline-flex; color:var(--accent) }` + svg 同色。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `internal/store/migrations/0008_session_pinned.sql` | 新增:pinned 列 |
| `internal/store/store.go` | Session struct 加 Pinned |
| `internal/store/sessions.go` | sessionColumns/scanSession/ListSessions ORDER BY + SetSessionPinned |
| `internal/store/store_test.go` | TestSessionPinnedSort(未置顶序 / 置顶跳顶 / 多置顶组内 prompted 序 / 取消置顶 / 字段读回) |
| `internal/chat/chat.go` | ChatService.SetSessionPinned binding |
| `frontend/bindings/...` | wails3 generate bindings(gitignored) |
| `frontend/src/components/Sidebar.tsx` | Pin 图标 + 右键菜单切换项 + Props.onTogglePin |
| `frontend/src/App.tsx` | toggleSessionPin(乐观本地重排)+ 接线 |
| `frontend/src/index.css` | .session-pin 样式 |

## 验证

- `go test ./internal/...` → 全包 ok(含新增 `TestSessionPinnedSort`,覆盖:未置顶时 A,B,C;置顶 C → C,A,B;再置顶 B → B,C,A(组内 prompted 序);取消 B → C,A,B;`GetSession.Pinned` 字段读回)。
- `cd frontend && bunx tsc --noEmit` → exit 0(确认 binding `.ts→.js` 格式变化未破坏类型)。
- `bun run build:dev` → 通过(397 模块,154ms)。
- `bun test` → 12 pass / 0 fail(流式合并等回归未坏)。

## 权衡 / OPEN

- **未做实机验证**:`wails3 dev` 跑一轮确认右键菜单 Pin/PinOff 切换、置顶后行即时跳顶且 Pin 图标常驻、取消后回位、turn 进行中切置顶不洗掉直播 title。需 GUI。
- **置顶组内部排序**:默认按 `prompted_at`(最近活跃在顶)。若用户反馈要「最近置顶的在顶」(固定序),加 `pinned_at` 列即可,改动局部。
- **多置顶可见性**:Pin 图标用 `var(--accent)` 弱色,若实测在深色主题不够显眼,可换 `var(--text-2)` 或加弱背景 tint。

## 下一步

- 视反馈决定是否加 hover 钉子按钮(v2,提升可发现性,右键菜单对不熟 macOS 右键的用户略隐蔽)。
- 视反馈决定置顶组是否改固定序(`pinned_at`)。

## 提交说明

```
feat(session): 项目内会话置顶(pinned 恒在顶部)
```
