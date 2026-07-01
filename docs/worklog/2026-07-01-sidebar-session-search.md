# 2026-07-01 侧栏会话搜索(标题 ∪ 内容)

## 起因

项目下 session 一多,只靠标题滚动找很费劲;很多 session 标题还是空的「新对话」,
标题搜索覆盖不到。用户要求在**项目条**上加搜索按钮,搜标题,**并问内容搜索会不会太重**。

## 设计 / 决策

- **标题搜索**:纯客户端子串过滤。`sessionsByProject` 本就全量加载(见 Sidebar 顶部注释),
  即时、零后端开销。这是核心、必做。
- **内容搜索会重吗?不会。** 桌面级本地 SQLite,单项目 `content LIKE '%q%'` 扫描是毫秒级
  (数据量远到不了需要 FTS5 的程度)。值得做——否则空标题 session 搜不到。
- **交互合一**:一个搜索框,**标题命中(本地即时)∪ 内容命中(后端 LIKE 去抖 200ms、≥2 字符触发)**,
  不分模式、不加开关(KISS / Less is More)。标题先出,内容回流后并入,体感即时。
- **只回 session id,不回 snippet**:前端在已加载列表上做并集过滤,后端最薄。

## 改法

1. 后端 `store.SearchSessionIDsByContent(ctx, projectID, query)`:
   `SELECT DISTINCT m.session_id FROM messages m JOIN sessions s ... WHERE s.project_id=? AND m.content LIKE ? COLLATE NOCASE`。
   按 project 隔离、大小写不敏感、`DISTINCT` 去重。
2. `ChatService.SearchSessionContent(projectID, query)` 暴露给前端(binding)。
3. `wails3 generate bindings` 重生成。
4. Sidebar:
   - 项目行加 Search 图标按钮(新对话按钮旁),点按展开项目 + 顶部出现搜索框,再点/Esc 关闭。
   - 搜索时 `projSessions.filter(matchSession)` 覆盖分页(全显命中),非搜索态保留原分页。
   - 去抖 effect 调 `SearchSessionContent` 回填 `contentHits`;`matchSession` = 标题子串 ∪ contentHits。
   - 空结果「无匹配的会话」;加载更多在搜索态隐藏。
5. index.css 加 `.session-search-row` / `-input` / `.search-spinner` / `-empty`。

## 改了哪些文件

- `internal/store/messages.go` — 新增 `SearchSessionIDsByContent`。
- `internal/store/store_test.go` — 新增 `TestSearchSessionIDsByContent`(大小写/隔离/去重/空结果)。
- `internal/chat/chat.go` — 新增 `SearchSessionContent` binding 方法。
- `frontend/bindings/...` — `wails3 generate bindings` 重生成(gitignored 产物)。
- `frontend/src/components/Sidebar.tsx` — 搜索按钮/框/过滤/去抖。
- `frontend/src/index.css` — 搜索相关样式。

## 验证

- `go test ./internal/... .` → 9 包 ok。
- `TestSearchSessionIDsByContent` 覆盖:大小写不敏感、跨项目隔离、同 session 多消息去重、无命中空切片。
- `bunx tsc --noEmit` → 0;`bun run build:dev`(tsc + vite build)→ 通过。

## 修复:清空态下搜索中途失效

### 根因

搜索匹配的是 `sessionsByProject` 里每条 session 的 `title` 字段(前端子串)。
但 App 的 `chat:status` handler 里,**status 切 `prompting`(用户发消息)时会触发 `refreshSessions(pid)`**,该函数用 `ListSessions` 的 DB 结果**全量替换**该项目 session 列表。

问题:DB 里 session title 只在回合结束后才由 `syncSessionTitle` 回写(`chat.go` `persistTurn` 成功后),
turn 进行中 DB 里 title 仍为空串。全量替换 → 前端已有的直播标题(`chat:session-meta` 流的)被洗掉,
**前端子串匹配突然全部落空 → 搜索「失效」**。

`chat:session-meta` event 虽然会在 title 到来时原地更新(第 290-301 行),但它补一帧、status 就刷掉一帧,时序上始终落后。

### 修法(`frontend/src/App.tsx`)

- `refreshSessions(projectId, keepFields?)`:加第二个参数。`keepFields=true` 时按 session id 做合并,
  仅当 DB 返回的 title 为空时,保留前端 `prev` 里已有的 title(`!ns.title && live.title`),其余字段以 DB 为准。
  初次加载 / 删除等调用点默认 `keepFields=false` 不变(必须全量替换的场景)。
  Map 动态 key(id)运行时查询,用 `Map`(呼应规则 ts-set-map)。
- status handler `prompting` 分支:改调 `refreshSessions(pid, true)`,保留前端标题。

### 验证

- `bunx tsc --noEmit` → 0;`bun run build:dev` → 通过。
- 手动逻辑:推空标题后 DB 重拉 + DB 非空标题后重拉,两条路径均符合预期(空保留 / 非空覆盖)。

## 注意 / 已知

- `LIKE` 查询里 query 的 `%`/`_` 会作通配符(桌面搜索场景可接受,代码注释已标)。
- **未提交**:工作区另有用户在途改动(`internal/acp/runner.go`、`activity_test.go`,
  以及 Sidebar/index.css 里用户已有的分页/置顶改动),与本次搜索无关,未替用户提交混入。
  本搜索改动待用户决定提交时机。

## 下一步

- 视使用反馈,可加「内容命中 snippet 预览」(高亮匹配片段),目前只过滤列表。
- 搜索态目前只在一个项目内;若需跨项目全局搜索再单独做。
