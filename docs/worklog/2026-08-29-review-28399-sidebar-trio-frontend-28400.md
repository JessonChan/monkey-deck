# Review #28399 侧栏三连前端面复审(标签 OR 过滤 / 全选 toggle / 闹钟配色)(#28400)

日期:2026-08-29
被审:2c20749(feat 侧栏三连)+ eff3a7f(worklog)
结论:**CHANGES REQUESTED(不通过)**——1×P0(#160③ OR 多选整体缺失)+ 1×P1(#162 配色/圆角偏离规格定值)+ 1×P2(#161 tooltip 动态化违反「保持静态」明文);#160a/#160b/#161 逻辑本体与测试质量合格。

## 复审方法

按「类型补丁反模式」反向追踪:不从 commit message 出发,从规格条目出发逐条对代码与测试断言;硬性测试逐条对照「断言值」而非「字段存在」;本机全量重跑 gate(bun test + build)。

## 逐件验证

### #160 标签交互重对齐——①②过,③(P0)缺失

- **①行内 chip 全撤 ✅**:旧渲染块(Sidebar.tsx 原 :939 区域 `.session-tag-chip` map)已删;`grep session-tag-chip` 仅剩测试的负向断言(tags.mount.test :207 `toBe(0)`、:213 `not.toMatch(/\.session-tag-chip\s*\{/)` 读 index.css 源文断言规则已删)——clean cutover 实证。
- **②标签钮 + 面板门控 ✅**:项目行按钮组新增 Tag 钮(Sidebar.tsx:795-797,lucide `Tag` size 12,react-tooltip、data-testid `tag-filter-sessions-<pid>`);面板 `tagPanelProj === p.id && projTags.length > 0`(:825)门控,数据直用 `collectTags(projSessions)`(:769);单开镜像 searchProj;**关面板必清该项目激活过滤**(:448-465,tags.mount.test test 6 断言重开无残留 active)。规格未明文的「关面板清过滤」是合理闭环(过滤激活⇒面板可见),不算偏离。
- **③多选 OR ❌ P0**:规格明文「tagFilter 从 Record<string,string> 改 Record<string,string[]>;session.tags ∩ 选中集非空即命中;空选中集=不过滤」。实测:
  - Sidebar.tsx:171 `useState<Record<string, string>>({})`——仍是单选;
  - `toggleTagFilter`(:432-439)`next[pId] === tag ? delete : 赋值`——单选替换语义;
  - 管线(:497-500)`(s.tags ?? []).includes(activeTag)`——单标签成员判断,非集合交集;
  - **测试钉死的是错误语义**:tags.mount.test test 4(:276-281)「Clicking another chip re-keys the filter (single-select)」——选 api 后点 db,s1(api)被隐藏。规格硬性测试要求「选 A+B→含 A 或 B 的 session 均可见」,该测试断言与规格相反。
  - 后果:硬性测试 1 的核心子句(多选 OR)零覆盖且行为相反;`tagFilterActive/tagFilterIdle` chip tooltip、`.active` 指示(`activeTag === tag`,:830/:835)也随单选写死,返工时须一并切集合成员判断。空选中集=不过滤需在管线里显式判 `length===0`(Set 语义下自然成立,但要防「空数组仍走过滤分支」)。
- **测试缺口(P3)**:「标签钮展开集合视图**含项目全部标签**」未断言(test 4 只断 row 存在 + 单 chip 过滤,未断言 projTags 全集渲染);「ctx 赋值后**视图即时更新**」无对应测试(test 2 只断 `setTagsMock` 调用值,未断言赋值后 chip 行/过滤即时反映新标签)。

### #161 全选 toggle——逻辑过,tooltip(P2)偏离

- **toggle 分支 ✅**(Sidebar.tsx:523-542):未全选→并入(未选→全选、部分→全选共用);已全选→整表剔除;剔空 `exitSelMode()`;anchor 在两分支均未触碰(:519-522 注释与实现一致,#155 ④ 语义保留);空项目 no-op(:525)。
- **测试 ✅ 锚定值**:batch.mount.test :404(二次点反选 + aria-checked false + batch-bar 消失)、:424(部分→补齐不清空)、:441(跨项目隔离,batch-count 逐字 `{"count":4}`→`{"count":1}`)、:180(未选→全选)。「Shift 连选 anchor 不断」仅间接覆盖(:232 常规 Shift range,无「select-all 后 Shift 仍锚定」序列,P3)。
- **tooltip ❌ P2**:规格明文「**tooltip 保持静态「全选」**」;实现改为随状态翻转(:772-774 `projAllSelected` + :798 三元切 `sidebar.batchDeselectAll`,并新增 zh/en key)。交互上属改善,但与定版规格相反——返工须回静态(删 key 走 clean cutover)或先改规格再动代码。

### #162 闹钟配色反转——❌ P1,定值两项不符 + 断言缺失

规格定值:`color → var(--amber); background → rgba(255,214,10,0.12); border-radius → 50%(回圆形);尺寸 14px/图标 10px 不变;is-due-soon 脉冲不动`。

实测(index.css:393-395):
- `color: var(--amber)` ✅;尺寸 14px / svg 10px ✅;`is-due-soon` perm-pulse 1.1s ✅;
- `background: rgba(255, 214, 10, **0.16**)` ❌(规格 0.12);
- `border-radius: **3px**` ❌(规格 50% 圆形)——:384-392 注释明文「the 3px-square silhouette」,即**有意**保留方形,commit message 亦自称「14px 方形不动」,与用户拍板的「回圆形」相反;
- **硬性测试 3 零落地(P1 的一部分)**:scheduled.mount.test 对该 chip 仅断 `className` 含 `scheduled-indicator`(:166/:214/:234),**无任何配色/圆角/尺寸断言**(规格要求「配色/圆形/尺寸断言」);脉冲类保留已覆盖(:168 not.toContain / :215 toContain / :225-230 wake 翻转),「行高不变」无断言(P3,可由 14px 固定尺寸断言近似承载)。

### i18n ✅(附 P3 备注)

zh/en 各 +3 key(tagFilterOn/tagFilterOff/batchDeselectAll),两侧 key 集合一致,locales.test 全绿;chip tooltip 沿用既有 tagFilterActive/tagFilterIdle。规格 i18n 硬性测试括号里提到的「**视图标题**」key 不存在——实现是纯 chip 行无标题;若规格确需集合视图标题,P0 返工时向规格 owner 确认补 key,否则视为括号示例性描述。

### worklog 文件名(P3)

规格指定 `docs/worklog/2026-08-29-sidebar-tags-realign-160-162.md`;实际落盘 `2026-08-29-sidebar-tag-realign-selectall-toggle-alarm-160-162.md`(tag 单数 + 扩展 slug)。内容齐全(规格反推说明/三端口径),改名即合规。

## Gate 重跑(本机实证)

- 本 worktree 初跑 `bun test --isolate` 45 fail——根因是 worktree 缺 `frontend/node_modules` 与 `frontend/bindings`(均 gitignored,非代码问题);`bun install` 后 6 fail(全部 `Cannot find module '.../bindings/...'`),`make bindings`(wails3 alpha2.106,126 methods/26 models)后 **427 pass / 0 fail / 7444 expects**——与被审 worklog 声称逐字一致。
- `bun run build`(tsc + vite)0 错误(仅既有 chunk>500kB 警告)。

## Findings 汇总

| 级别 | 项 | 位置 | 返工动作 |
|---|---|---|---|
| P0 | #160③ OR 多选整体缺失,测试反钉错误语义 | Sidebar.tsx:171/:432-439/:497-500;tags.mount.test:276-281 | state 改 `Record<string,string[]>`、toggle 改集合增删、管线改交集非空 + 空集不过滤、chip 激活/tooltip 切成员判断;test 4 重写为 OR 断言(选 A+B→含 A 或 B 均可见,两皆无者隐藏)+ 补「含全部标签」「ctx 赋值即时更新」两断言 |
| P1 | #162 配色/圆角偏离定值 + 硬性断言缺失 | index.css:393;scheduled.mount.test | background 0.12、border-radius 50%;注释同步改;测试补 getComputedStyle 配色/圆形/尺寸断言 |
| P2 | #161 tooltip 动态化违反「保持静态」 | Sidebar.tsx:772-774/:798;zh/en batchDeselectAll | 回静态「全选」;或先修订规格(需用户拍板) |
| P3 | worklog 文件名 / 集合视图标题 key / select-all→Shift 序列 / 行高断言 / 触及区中文注释(:169/:431/:768)待 P0 返工顺转英文 | — | 随返工顺带处理 |

## 下一步

退回实现侧按 Findings 返工;P0 返工后重跑三件硬性 mount 测试 + 全量 gate;本卡停 CHANGES REQUESTED,不关。
