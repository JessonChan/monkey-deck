# Review #28399 侧栏三连二轮复审——返工复验通过(#28402)

日期:2026-08-29
被审:08a4eff(P0 OR 多选)+ bc28aa8(P1 配色定值)+ 424b91d(P2 静态 tooltip / P3 anchor 补测)+ 42849e3(worklog 改名),返工记录 `2026-08-29-review-28399-rework-frontend-28401.md`
结论:**APPROVE(通过)**——上轮三项 Findings(P0/P1/P2)全部实证修复,P3 顺带项落地;全量 gate 本机重跑与返工声称逐字一致。

## 复审方法

沿用「类型补丁反模式」反向追踪:不顺着返工 commit message 走,从上轮 Findings 条目出发逐条对代码与测试;`tagFilter`/`activeTag`/`batchDeselectAll`/`projAllSelected` 全仓 grep 确认消费端闭合、无死残留;本机重跑全量 gate(bun test --isolate + bun run build)。

## 逐项复验

### P0:#160③ OR 多选 ✅(08a4eff)

- **消费端闭合(grep 实证)**:`tagFilter` 仅三处读(state :173 / 管线 :509 / chip :783)、两处写(`toggleTagFilter` :436 / `toggleTagPanel` :456);单数 `activeTag` 零残留。
- **state**:Sidebar.tsx:173 `Record<string, string[]>` ✅。
- **toggle**(:436-448):集合增删,re-click 剔除;**剔空即删 key**(:440-444),不留空数组 key——「空集仍走过滤分支」被结构性排除 ✅。
- **管线**(:507-519):`activeTags.length ? some(交集) : 全量`——交集非空命中(OR)+ 空集不过滤;`searching || activeTags.length` 绕分页、`activeTags.length === 0` 才显「加载更多」(:999/:1002),三处同步 ✅。
- **chip**(:842/:847):`.active` class 与 tooltip 均按成员判断 `activeTags.includes(tag)`,非「最后点击」✅。
- **测试锚定值**(tags.mount.test):
  - test 4(:247-302)重写为 OR 断言:选 api→仅 api 载体;**加选 db→s1+s2 均可见、仅持 redis 者隐藏**(:275-279,规格核心子句);两 chip 均 `.active`(:281-282);tooltip 逐字断言(`sidebar.tagFilterActive` / `sidebar.tagFilterIdle {"tag":"redis"}`,:283-286);单删→仅 db 过滤(:289-293);再点→空集抬过滤全量回 + 无 active(:296-301)。补测缺口①:chip 行断言 3 枚全并集(:264)。
  - test 6(:334-365)扩为双激活:关面板丢弃**整个**选中集、重开零残留 ✅。
  - test 7(:367-404)新增:面板开着经 ctx 赋新标签,`root.render` 模拟父端乐观回流后 chip 行即时 +1 且新 chip 立即可过滤(:394-401)——补测缺口② ✅。

### P1:#162 配色定值 ✅(bc28aa8)

- index.css:394 `border-radius: 50%; color: var(--amber); background: rgba(255, 214, 10, 0.12)`——0.12 与圆形两项均回定值;:395 svg 10px、:396 is-due-soon perm-pulse 1.1s 不动;「3px-square silhouette」旧注释已删,改记定值与 14px 行高不变量 ✅。
- 断言落地(scheduled.mount.test :238-269):注入**真实 index.css**(readFileSync,非 fixture 复写值)后 `getComputedStyle` 逐值锚定——color 收 `#ffd60a`/`rgb(255, 214, 10)` 两形态、background 逐字 `rgba(255, 214, 10, 0.12)`、radius `50%`、盒 14px、字形 10px;`finally style.remove()` 不污染他测 ✅。上轮「硬性断言零落地」补齐。

### P2:#161 tooltip 回静态 ✅(424b91d)

- Sidebar.tsx:810 tooltip 固定 `t("sidebar.batchSelectAll")`;`projAllSelected` 派生态零残留(grep 实证)✅。
- zh/en 两侧 `batchDeselectAll` 已删、`batchSelectAll`/tagFilter* 四 key 两侧同步(jq 实证);locales.test 全量绿 ✅。clean cutover 完整。

### P3 顺带 ✅

- batch.mount.test :463-490 补 anchor 序列:Cmd+click s2 立锚→全选→Shift+click s3 仍按锚扩 range(count 逐字 `{"count":3}`、`activated` 空)——anchor 被清的退化路径(s3 翻 false、count 2)会被该断言暴露,#155④ 回归岗就位 ✅。
- worklog 已按规格改名 `2026-08-29-sidebar-tags-realign-160-162.md` ✅。
- 触及区注释已转英文(Sidebar.tsx :169-172/:433-435/:450-455/:499-506/:780-786)✅。

## Gate 重跑(本机实证)

- 本 worktree 重检出后 `frontend/node_modules` 缺失(同上轮):`bun install` 后初跑 6 fail,**全部** `Cannot find module '.../bindings/.../chatservice'`——gitignored 生成物不全,非代码问题;`make bindings`(wails3 alpha2.106,126 methods/26 models)后 **430 pass / 0 fail / 7478 expects(57 文件)**,与返工 worklog 声称逐字一致。
- `bun run build`(tsc + vite)0 错误(仅既有 chunk>500kB 警告)。

## 备注(非阻塞)

- **i18n「视图标题」key**:返工按「括号示例性描述」处理未加 key(纯 chip 行无标题),复审认可该裁量;若规格 owner 后续确需属小改,OPEN 留档。
- **三端人工回归**:改动均为既有组件内状态/样式/文案修正,无新依赖、无布局结构变化,回归风险低;GUI webview / 远程浏览器 / PWA 真机回归仍留待有人环境(OPEN,沿返工记录)。
- **环境坑复现提示**:`node_modules` + `bindings` 双缺失导致 fresh worktree 初跑必 6 fail——连续两轮复审均遇,新 agent 进 worktree 先 `bun install && make bindings` 再跑测试。

## 下一步

- 本卡关闭,侧栏三连(#160/#161/#162)闭环。
- 两个 OPEN(视图标题 key、三端人工回归)留在记录中,待有人环境/规格 owner 处理。
