# 2026-08-29 · 侧栏三连:标签交互重对齐 + 全选 toggle + 闹钟配色反转(#160/#161/#162 / Task #28399)

日期:2026-08-29 · 基线:rak main=b580cd4(#150 标签 MVP / #155 批量入口迁移已在库)

## 起因

父 issue #28398(四点拍板定版)的三张子卡,收敛侧栏标签与批量交互的两轮 review 尾巴:

1. **#160a 行内 mini-chip 全撤**:session 行的彩色标签 chip 默认零视觉占用,hover 也不显示。
2. **#160b 标签过滤入口进项目行按钮组**:过滤 chip 行不再常驻,挂到项目行按钮组(Sidebar.tsx 项目行搜索按钮旁)。
3. **#161 全选 toggle**:项目级 select-all 从「只并入」改为完整 toggle——再点一次取消全选。
4. **#162 闹钟配色反转**:`.scheduled-indicator` 从 #141 的实心反色(amber 底 + 深字)反转回 amber 字形 + 软 amber tint 底。

⚠ 规格可达性说明:本沙箱 `gh` keyring token 失效、仓库私有(web 404),#28398/#160/#161/#162 原文不可读。四点语义从任务卡残留文本(「#160 a.行内 mini-chip 全撤(默认零视觉占用,hover 也不显示);b.项目行按钮组(:742-749 搜索…」+ 标题「全选 toggle」「闹钟配色反转」)与代码史(#150/#155/#138/#141 worklog)反推重建。**#162 的反转方向取字面义**:把 #141 的双色对(amber 底/深字)对调(amber 字/tint 底),即回到 #138 已验证过的配色组合,几何(14px 方形 3px 圆角)与 is-due-soon 脉冲不动。若原意相反(要更深更重),改回只需对调 `.scheduled-indicator` 的 color/background 两个值。

## 方案与决策

### #160a 行内 mini-chip 全撤(零视觉占用)

- 删 `Sidebar.tsx` session 行的 `(s.tags ?? []).map(...)` chip 渲染块;行 meta 区回到 harness 图标 → pin → terminal-mark → 闹钟 → 互斥尾槽,标签在行内不留任何痕迹(无 hover 显现——hover 显现也需要常驻占位与额外 CSS,且用户明说「hover 也不显示」)。
- 删 `.session-tag-chip` CSS 规则与注释(clean cutover,无死代码)。标签可见性只剩两条正经通道:ctx「标签 ›」子菜单(赋值/移除)与过滤 chip 行(过滤)。
- `tagColor`/`TAG_PALETTE` 不动:仍是过滤 chip 底色与 ctx 圆点的配色来源。

### #160b 过滤入口进项目行按钮组

- 项目行按钮组变为 [搜索][标签][全选][新对话](`Sidebar.tsx` 项目行,搜索与全选之间):`Tag size=12`(与 search=12 同形制),`data-testid="tag-filter-sessions-<pid>"`(照 `search-sessions-<pid>` 命名式),tooltip 键 `sidebar.tagFilterOn/Off`(panel 开→「收起标签过滤」/关→「按标签过滤」,命名对齐 `searchOn/searchOff` 的「描述点击后果」惯例)。
- 新状态 `tagPanelProj: string | null`,**单开镜像 searchProj**:开另一项目的面板自动关掉前一个。关闭面板(直接关或被顶掉)**顺带清掉该项目的激活过滤**——不变量:「过滤激活 ⇒ 面板可见」,关掉的 chip 行永远不在暗地里收窄列表(no hidden state)。
- chip 行渲染门从 `projTags.length > 0` 改为 `tagPanelProj === p.id && projTags.length > 0`;开面板时自动展开项目(与搜索/全选按钮同款)。
- 项目无标签时按钮仍在、点了没行可显(no-op):与 #155 全选取 no-op 同理——`disabled` 会吞 hover 使 tooltip(§4.5)失效。

### #161 全选 toggle

- `selectAllProject`:可见集 `projectList(pId)` 非全部已选 → 并入 + 进选择模式(原语义);**已全部可见选中 → 从选择集剔除该可见集**;剔除后选择集为空 → `exitSelMode()`(与 Esc 同终态:checkbox 消失、batch-bar 消失)。部分选中 → 补齐(toggle 的 select 分支,不是清除)。
- anchor 两分支都不碰(select-all 不是单行 toggle 点击,#155 ④ 延续);空项目 no-op(#155 ③)延续;跨项目 union 语义延续——toggle 只按「本项目可见集」增删,他项目选择不动。
- tooltip 反映状态:`projAllSelected ? batchDeselectAll : batchSelectAll`(新键 zh「取消全选本项目会话」/en "Deselect all sessions in this project")。空项目保持「全选」文案(按钮是 no-op,不撒谎说能取消)。

### #162 闹钟配色反转

- `.scheduled-indicator`:`color: #4a3b00; background: var(--amber)` → `color: var(--amber); background: rgba(255, 214, 10, 0.16)`(#138 的 tint 组合,与 `.draft-indicator`/`.st-thinking` 同族)。尺寸 14px、3px 方形圆角、10px 字形、`is-due-soon` 脉冲全部不动——本卡只动配色。
- 动机(自评):#141 的实心 amber 块在「多 session 同时挂着定时项」时整列高响度;反转后闹钟退回安静的信息性信号,方形状仍与圆点系区分。注释同步改写(#138→#141→#162 演变链)。

## 改了哪些文件

|文件|改动|
|---|---|
|`frontend/src/components/Sidebar.tsx`|删行内 chip 块;`tagPanelProj` 状态 + `toggleTagPanel`;`selectAllProject` toggle 化(空集退出模式);项目行按钮组插 Tag 按钮 + 全选 tooltip 动态化;chip 行渲染门;注释更新|
|`frontend/src/index.css`|删 `.session-tag-chip` 规则;`.session-tags-row` 注释改写(门控来源);`.scheduled-indicator` 配色反转 + 注释改写|
|`frontend/src/i18n/locales/{zh,en}.json`|新增 `sidebar.tagFilterOn/tagFilterOff/batchDeselectAll` 三对键(插在 tagFilterIdle / batchSelectAll 同位)|
|`frontend/src/components/Sidebar.tags.mount.test.tsx`|场景 1 改「零行内占用 + CSS cutover 钉死(`.session-tag-chip` 规则不存在)」;场景 4 加面板门控(默认关/开面板);场景 5 先开面板;场景 6 改「关面板清过滤 + 重开无激活 chip」|
|`frontend/src/components/Sidebar.batch.mount.test.tsx`|过滤态全选测试先开面板;新增 ×3:二次点击取消全选并退出空模式 / 部分选中时补齐不清除 / 跨项目 toggle 互不影响|

## 验证

- **定向套件**:`bun test Sidebar.tags Sidebar.batch Sidebar.scheduled` → 25 pass / 0 fail(tags 6 + batch 13 + scheduled 6)。
- **全量仓库门**:`bun test --isolate` → **427 pass / 0 fail**(含 locales.test zh/en 键集 parity——新三对键双语同位由其钉住)。注:直接 `bun test`(无 --isolate)有跨文件 realm 串扰,仓库门命令即隔离模式(#150 已记)。
- **前端构建**:`bun run build`(tsc + vite production)零错误(仅既存 chunk-size advisory)。
- **Go 门**:`go build ./...` + `go vet ./...` 干净(本次零 Go 改动)。
- **bindings**:新 worktree 缺 gitignore 的 bindings,`go run …wails3@v3.0.0-alpha2.106 generate bindings`(go.mod 钉版,OPEN 遗留的 CLI 漂移规避)补齐后跑测试/构建;非签名变更。

### 三端说明(§4.7)

纯共享 Sidebar 呈现/交互层改动:零新增 binding/事件/远程守卫分支,无 `isRemoteClient()` 分化,新按钮完全复用既有 `.icon-btn.small` 形制,闹钟新配色复用 #138 在三端跑过的 tint 组合(纯 CSS 变量 + 固定值,无引擎特有属性,§4.6 合规),≤768px 抽屉同一渲染路径。行为面由 mount 测试(happy-dom 真实点击)覆盖;**桌面 GUI / 远程浏览器 / PWA 的肉眼冒烟未在本沙箱执行**(无法起 Wails GUI),与 #155 同口径留待人工复核。

## OPEN / 下一步

- **#162 反转方向待原图核对**:如上所述按字面义实现为「amber 字 + tint 底」;若拍板原意是把深底加重(如深底 + amber 边),改两个 CSS 值即可。
- **大项目全选边界**(继承 #155 OPEN):未过滤态全选=分页切片,>25 条需「加载更多」续选;toggle 的 deselect 分支同样只作用可见切片。
- 人工三端冒烟:桌面 GUI(按钮组四键不挤、tooltip 翻转)、远程浏览器、PWA ≤768px。
- 不 push,停 completed-ready 等人复核。
