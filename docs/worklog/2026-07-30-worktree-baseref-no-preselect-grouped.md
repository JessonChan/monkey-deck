# 2026-07-30 worktree 基线选择器:取消预选 + 分组(默认/最近使用/全部)

## 起因

新建对话弹窗选 Worktree 模式时,基线分支选择器会**自动预选**(探测到的默认分支或上次选择),用户一不留神就基于错误基线建了 session。用户反馈:不要帮用户做选择,否则容易搞错。

期望逻辑:
1. 默认**不预选**任何分支(强制用户显式选)。
2. 拉开列表后顺序:**① Git 默认分支(通常 main)→ ② 最近使用过的 → ③ 全部分支按时间**。

## 根因 / 设计

旧设计把两个不同概念揉进了一个 `defaultBaseRef`:
- 「Git 默认分支」(仓库属性,origin/HEAD → main/master 探测)
- 「上次选择」(用户历史,per-project setting `baseRef:<id>`)

`ResolveBaseRefDefault` 优先返回「上次选择」,兜底「探测默认」,前端直接预填 + 星标 + 置顶。预选正是搞错的来源。

新设计把两者**拆开**,且**不再预选**:
- `ResolveBaseRefDefault` 只返回**探测到的仓库默认分支**(纯仓库属性),供「默认分支」组置顶 + 星标。
- 新增 `RecentBaseRefs`:per-project 最近选择**历史列表**(most-recent-first,去重,封顶 5,`baseRefHistory:<id>` JSON),供「最近使用」组。与默认分支是不同概念(仓库属性 vs 用户意图)。
- 前端 `baseRef` 初始为空,「新建」在 worktree=true 且未选基线时禁用(Route A strict「显式基线」更强了,不是削弱——§1.4 / 2026-07-28 worklog 的核心赌注「绝不裸用 HEAD」保持不变,只是不再替用户拍板)。
- 列表三组各分支**只出现一次**:默认组(0~1,星标)→ 最近使用组(recentRefs 序,排除默认)→ 全部组(后端 committerdate 倒序,排除已出现)。空组隐藏。

「最近使用」用列表而非单值:用户可能在 main/develop 间来回切,列表更实用(旧的单值 `baseRef:<id>` 被新的历史列表取代,旧 key 变成无人读的死数据,无妨)。

## 改法

### 后端 `internal/chat/chat.go`
- `ResolveBaseRefDefault`:删掉「上次选择」优先级,只返回探测到的仓库默认(origin/HEAD → main/master probe);探测失败 `Ok=false`(前端只是少一个「默认分支」组)。
- 新增 `RecentBaseRefs(projectID) []string`:读 `baseRefHistory:<id>` JSON,过滤掉已删除的 ref(RefExists),保 recency 序。
- 新增 `recordBaseRefHistory(projectID, baseRef)`:prepend + 去重 + 封顶 5,写回。best-effort,错误只 log。
- `CreateSession`:原来 `SetSetting("baseRef:"+projectID, resolvedBase)` 改成 `recordBaseRefHistory(projectID, resolvedBase)`。

### 前端
- `App.tsx`:`newSession` 状态加 `recentRefs: string[]`;`createSession` 并发预取 `ResolveBaseRefDefault`/`SearchBaseRefs`/`RecentBaseRefs`;透传 `recentRefs` 给 modal。
- `NewSessionModal.tsx`:`baseRef` 初始改 `""`(取消预选);`filteredBranches` 单列表 + 置顶排序 → `grouped` 三组(defaultItem / recentItems / restItems),两组过滤(名称 + local/remote)在各组内生效,`used` Set 保证去重;渲染三组 + 组标题,option 行抽出 `renderOption`(3 处调用,锁步行为,§5.3 允许的微小函数)。trigger 仍保留「选中分支==默认时显示 ★」。
- i18n `en/zh.json`:`newSession.baseRefGroupDefault/Recent/All`。
- `index.css`:`.ns-baseref-group`(组间分隔线)+ `.ns-baseref-grouphead`(小字大写组标题)。

### bindings
- `wails3 generate bindings`(新增 `RecentBaseRefs` binding)。

## 改了哪些文件

- `internal/chat/chat.go`:重写 `ResolveBaseRefDefault`;新增 `RecentBaseRefs`/`recordBaseRefHistory`;`CreateSession` 改用历史记录。
- `frontend/src/App.tsx`:状态类型 + 预取 + 透传 `recentRefs`。
- `frontend/src/components/NewSessionModal.tsx`:取消预选 + 三组分组渲染。
- `frontend/src/components/NewSessionModal.mount.test.tsx`:**新增** 3 个 mount 测试。
- `frontend/src/i18n/locales/{en,zh}.json`:3 个组标题 key。
- `frontend/src/index.css`:组标题样式。
- `frontend/bindings/`:regen(gitignored)。

## 验证

- `go build . ./internal/...` 通过。
- `go test ./internal/chat/... ./internal/worktree/...` 全绿。
- i18n JSON:`python3 json.load` 两个文件均合法。
- 前端 `tsc --noEmit`:无非模块错误(剩余 "Cannot find module" 是 bindings 噪声,固有)。
- 前端 `bun run test`:**150 pass / 0 fail**(新增 3 个 NewSessionModal mount 测试)。新增测试锁定的不变量:
  1. **取消预选**:选了 worktree 模式后「新建」禁用(旧 `useState(defaultBaseRef)` 代码会让「新建」立即可用 → 测试 FAIL)。
  2. **分组 + 去重**:三组顺序 Default→Recent→All,每个分支**整张表只出现一次**,默认组星标,最近组保 recentRefs 序、排除默认,全部组保后端日期倒序。
  3. **选择启用**:点分支 → 关闭下拉 → 「新建」启用 → onConfirm 收到 `("omp", true, "develop")`。
- 服务器模式 / GUI 实测:本环境未做(用户自行验证真实渲染:组标题、星标、分隔线)。

## 下一步 / OPEN

- **GUI 实测**:真实 macOS WebKit 下点开弹窗确认分组视觉(组标题排版、★ 颜色、组分隔线、滚动)。mount 测试覆盖行为,纯 CSS 视觉待用户确认。
- 旧的 `baseRef:<id>` setting key 成死数据(无人读);如需整洁可一次性清理,目前留着无副作用。
