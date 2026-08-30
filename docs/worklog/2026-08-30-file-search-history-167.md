# #167 文件面板搜索历史(最近搜索)——前端面实现(Task #28442)

- 日期:2026-08-31(落盘文件名按任务指定用 08-30 slug)
- 改动面:`frontend/src/components/FilePanel.tsx`、`frontend/src/lib/filePanelCache.ts`、zh/en locales、新增两份测试。**无后端改动。**
- 任务上下文:Wails3 worktree(Task #28442),规格 D1-D8 已拍板,逐条硬性。

## 起因

#132 给文件面板加了 debounce 模糊搜索(非受控 input + 原生 listener, Exit 即退出)。用户每次重开搜索都要重新敲同样的 query——加一份「最近搜索」历史:项目级 localStorage 持久化、聚焦空 query 时下拉展示、点击回填立即搜、单条可删、cap 12 自淘汰。

## 设计与决策(对照 D1-D8)

### D1 历史存储
- 键:`md:recent-file-searches:<rootPath>`;**rootPath 取自既有 prop 链**——App.tsx:2494 `activeSession?.worktreePath || selectedProject?.path || ""` → SidePanel.tsx:79 → FilePanel。App 侧 sessionId→project 映射已物化为该 prop,FilePanel 侧零新依赖(无新 binding、不动 App/SidePanel,守住改动面)。
- **rootPath 为空(映射确实不可得)才退 per-session 键** `md:recent-file-searches:<sessionId>`(`recentFileSearchesKey`)。
- 值为 JSON 字符串数组;**前移去重**写入(`rememberRecentFileSearch`);cap 12(`RECENT_FILE_SEARCH_CAP`);读取 try/catch 防腐 + 非数组/非字符串项过滤(`loadRecentFileSearches`),形态照抄 Composer.tsx `md:recent-models`(:1427-1455)。
- ⚠️ **键域边界(如实注明)**:git 项目走 §1.4 worktree 模型,App 传下的 rootPath 实为 per-session worktree 目录 → 「项目级共享」在 git 项目下实际退化为 per-worktree 键(非 git 项目 rootPath=项目目录,真项目级)。这与规格字面一致(键=映射产物 rootPath),但跨 session 共享历史的意图只在非 git 项目成立。若要真项目级,需 App 改传 `selectedProject.path`(动 App/SidePanel,超出本次改动面)→ 记 OPEN。

### D2 状态保持
- `FilePanelSnapshot` 增 `searchOpen: boolean` / `query: string`(读取侧 `?? false` / `?? ""` 兜默认);卸载快照保存点(snapRef,原 :76-77)纳入两字段。
- searchOpen/query 的 useState **上移进快照恢复状态块**(lazy init 读 cache;否则 snapRef 处 TDZ 引用不到)。
- **results 不缓存**:重挂恢复 searchOpen+query 后,既有 debounce 搜索 effect 原样自动重跑,未新增任何缓存/重跑机制。
- 非受控 input 的 DOM 回填(hydration):重挂后 `el.value = query`,放在**独立 effect**(与 D5 的 key listener 链物理分离,该链 diff 零改动)。

### D3 命中即退出维持
- `pickResult` 仍 `exitSearch()`(#132 有意设计,不动);历史写入挂在 **pickResult 入口**(记录 `query.trim()`),与退出行为解耦;文件与目录命中都算一次提交(目录命中 reveal-in-tree 行为原样,仅同样记历史)。
- 搜索提交点与 pickResult 相同:Enter/点击均路由到 pickResult,组件内无独立提交点(故无第二挂点)。

### D4 历史入口
- 触发条件 = **input 聚焦(searchFocused)且 query 为空且 recent 非空**(`showHistory`);无历史不渲染。
- 渲染:tree-body 内第三分支,复用结果列表容器风格(`.tree-row .file-search-item` + `tree-name`/`tree-acts`/`tree-act`),**零新组件、零新 CSS**。
- 点击历史项 = `applyHistory`:直接写 DOM value(非受控)+ `setQuery` → 既有 debounce effect 立即触发搜索(重挂 hydration 与此共用「DOM 为真相源」原则)。
- 单删 ✕:`removeRecentFileSearch` 单条删除,`stopPropagation` 防误回填;删空后下拉整体消失回落树。
- blur 先于 click 的经典坑:行 `onMouseDown` `preventDefault` 保持 input 焦点,下拉不会在 mousedown→click 之间消失。
- i18n:`filePanel.searchHistory`(zh 最近搜索/en Recent searches)、`filePanel.searchHistoryDelete`(zh 删除这条搜索历史/en Delete this search entry),zh/en 同步。
- §4.5:query 超 `.tree-name` max-width 45% 会截断 → 行级 react-tooltip(`data-tooltip-content={q}`)展示完整 query;✕ 按钮独立 tooltip。无原生 title。

### D5/D6 形态不动(红线)
- Esc=exitSearch 原生 listener 链(原 :312-350)**逐字未动**(diff 可证:该 effect 仅行号位移,内容零变更;exitSearch 体内新增一行 `setSearchFocused(false)`,属关闭态清理,不在链上)。
- 非受控 input + 原生 input/keydown/composition listener 形态不变;历史下拉交互挂现有容器体系(行用 React onClick/onMouseDown,与结果行同范式;focus/blur 用原生 listener,与 input 事件同范式)。
- 键盘(↑↓ 选历史项)未做:规格未要求,且扩 key listener 语义触碰 D5。

### D7 清理边界
- 历史只由 remember/remove/cap 操纵;closeTab(App.tsx:1716)/evictSessionCache/purgeSession 只触进程内 snapshot Map(`deleteFilePanelState`)与 SQLite,**不清 localStorage**。全 src grep 证据:无任何 `localStorage.clear`/`removeItem` 调用点。

## 改动文件

| 文件 | 内容 |
|---|---|
| `frontend/src/lib/filePanelCache.ts` | Snapshot 增两字段;+4 个历史存取函数 + cap 常量(全英文注释,§3.7) |
| `frontend/src/components/FilePanel.tsx` | 快照纳入 searchOpen/query;recent/searchFocused 状态 + historyKey + 开启时重载 effect;pickResult 入口写入;applyHistory/deleteHistory;focus/blur+hydration 独立 effect;tree-body 历史分支;import History/X |
| `frontend/src/i18n/locales/zh.json` / `en.json` | filePanel 增 searchHistory / searchHistoryDelete |
| `frontend/src/lib/filePanelCache.test.ts` | **新增** 11 测:键域两变体、写入/前移去重/blank 忽略、cap12 淘汰、坏 JSON/非数组/非串过滤、超长 clamp、单删/异键隔离、localStorage 抛异常安全 |
| `frontend/src/components/FilePanel.search-history.mount.test.tsx` | **新增** 9 测:pick 写入(仅输入不写)、跨 pick 前移去重、cap12 组件路径、rootPath 空退 session 键、目录命中也记、下拉渲染+回填立即搜+下拉→结果替换、✕ 单删(不退出/不回填/删空回落树)、无历史不渲染、**重挂恢复 searchOpen+query+hydration 且 debounce 自重跑(无结果缓存)** |

测试基建注:happy-dom 的 `.focus()` 不派发 focus 事件 → 测试用原生 `dispatchEvent(new Event("focus"))`(与既有 typeInto 派发 input 事件同范式);组件侧是原生 focus/blur listener,真实 webview 不受影响。

## 验证(D8)

- `bun test --isolate`(frontend,全量):**510 pass / 0 fail**(基线 490/0;+20 新测,既有 FilePanel/App/SidePanel 等零回归)。
- `bunx tsc`:过。`bun run build`(tsc + vite 产线构建):过(chunk >500kB 警告为既有)。
- 既有 `FilePanel.search.mount.test.tsx`(8 测)/`FilePanel.coarse.mount.test.tsx`:全绿,#132 行为(含 IME 三重守卫、seq guard、目录 reveal)原样。

### 三端说明(§4.7)

- **后端/binding**:零改动,无统一验证项。
- **桌面 GUI(webview)**:行为面由 happy-dom mount 测试覆盖(同一 React 树,无 webview 专属分支);视觉面**零新 CSS、零容器外渲染**——历史行只出现在既有 tree-body 内、复用既有类(≤768 的 `.tree-acts` opacity 0.6 规则、36px 行高对历史行同样生效),桌面/移动 DOM 同构,渲染差异无从产生。真 webview 视觉冒烟未跑(本环境无 GUI 实例),按构造论证 + 建议 merge 前随 §5.6 常规冒烟。
- **远程浏览器**:未新增 `isRemoteClient()` 分支、未触 WS/`remote:resync` 面;binding 调用(SessionFuzzyFind/SessionListDir)与此前一致。
- **PWA/移动**:无 ≤768 条件分支、无 coarse-pointer 分支(历史行无 draggable),交互为标准 click(无 hover 依赖;tooltip 点按走既有 md-tip 体系);无 standalone 专属能力触及。
- 红线自查:@mention、RawPayloadDisclosure、复制契约等无关面零触碰(diff 范围 = 上表 5 个文件);参考库零接触。

## OPEN / 下一步

1. **git 项目键域为 worktree 级**(见 D1 注):跨 session 共享历史需 App 改传 `selectedProject.path`——涉及 App/SidePanel,超本次改动面,待拍板。
2. merge 前按 §5.6 做一轮三端常规冒烟(本任务以构造论证 + mount 测试收口)。
3. 下拉键盘导航(↑↓/Enter 选历史项)未做,规格未要求且受 D5 约束,如需另立任务。
4. 环境注:worktree 的 `frontend/bindings`(gitignored)缺失会导致 8 个依赖真实 bindings 的测试文件挂 `Cannot find module`,`make bindings` 重生成后恢复(本次基线即如此修复,490→510 与本任务无关的既有用例全部在册)。
