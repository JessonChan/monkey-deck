# Review #28921 — #174 标签点族 + ctx 菜单项目标签 quick-add(前端面)

## 结论

**APPROVE**(含 1 处 review 顺手修复,见下)。coder 侧 `3b6bc68` 与规格逐项对齐,按「类型补丁」反模式反向追踪了每个新字段/CSS 类/i18n 键的消费端,全部通电;停 completed-ready,不 push、不关 issue(流程约定)。

## 审查路径与证据

- **点族规格逐项核对**(`Sidebar.tsx:998-1019`):
  - 位置:meta 簇内 fork 徽章之后、pin 之前——「harness icon/fork 徽章同区」✓;
  - cap 3:`rowTags.slice(0, 3)`,溢出全量并入包裹 tooltip(`tagDotsTip` + `join(", ")`)✓;无标签返回 null,零足迹 ✓;
  - 三处同色:行内点(`:1015`)、过滤面板 chip(`:863`)、ctx 菜单点(`:1229/:1255`)同调 `../lib/tagColor` 的 `tagColor()`,同一 8 色 palette ✓;
  - 行高:`.session-tag-dots` inline-flex + flex-shrink:0 + 6px 点,归入既有 persistent-marker 家族(比相邻 11-14px 标记更小),无垂直增量 ✓;
  - `s.tags ?? []` 对 Go nil slice → JSON null 的 wire 形态安全 ✓;
  - react-tooltip(`data-tooltip-id="md-tip"`),无原生 `title` ✓;`data-testid="tag-dots-<sid>"` ✓。
- **菜单两节规格逐项核对**(`Sidebar.tsx:1203-1281`):
  - 第一节:会话已有标签,点击移除,契约不变(`tag-remove-<sid>-<tag>`);第二节:`collectTags(props.sessionsByProject[projectId])` 与过滤面板(`:797→802`)**同一未过滤源、同一首见序**,再 filter 掉自身标签;点击时**现查** `liveSession` 再 `[...cur, tag]`,连续追加见累积集(与输入框路径同约定);菜单不关,可连续增删 ✓;
  - 空态收窄:`tags.length===0 && projTags.length===0` 才显示 `tagsEmpty` ✓;
  - 自由输入原样保留在底部 ✓;`.ctx-submenu` 的 `max-height: 240px; overflow-y: auto` 为 #160 时代既有,滚动上限 ✓。
- **i18n**:4 个新键(`tagAddTip`/`tagsSessionSection`/`tagsProjectSection`/`tagDotsTip`)zh/en 双语齐全,`jq` 全树 key parity diff 为空;4 键在渲染点全部被消费(t() 调用逐个确认),无「字段加了没人用」。
- **测试**:测试 1 改写为 #174 点族契约(点数 2/3 锚定、inline style 含 `tagColor()` 值、tooltip 精确串、未标注行 null、`.session-tag-chip` 规则仍不存在);新增测试 8(quick-add 顺序精确锚定 `["tag-add-s1-db","tag-add-s1-redis"]`、追加 payload 精确、乐观更新后 db 就地从第二节翻到第一节);新增测试 9(空态双向门控)。断言均为锚定值而非字段存在性。`bun test`:tags 套件 9/9(70 expects)、相邻 scheduled+tagColor 12/12。
- **tsc**:仅剩 `../../bindings/...` 的 TS2307——gitignore 的生成物在本 worktree 未生成(`wails3 gen bindings` 可补),与本 diff 无关,触及文件无类型错误。

## Review 顺手修复(1 处)

- `frontend/src/index.css`:新增 `.ctx-tag-add { flex-shrink: 0; }`。quick-add 行的 Plus 图标挂了 `ctx-tag-add` 类但全仓无该规则;`.ctx-item` 是 `display:flex`,长标签名挤压时 svg 是可收缩 flex 项——同排的 `.ctx-tag-check { flex-shrink: 0 }` 正是为此存在。补齐后两图标同一防收缩保障。

## 验证

- `bun test src/components/Sidebar.tags.mount.test.tsx src/components/Sidebar.scheduled.mount.test.tsx src/lib/tagColor.test.ts`:21/21 pass(126 expects),CSS 修复后复跑全绿。
- tsc 触及文件无新增错误(见上,bindings 生成物缺失为环境性预存)。

## 三端状态(§4.7)

- 本卡前端面为 CSS 级增量:点族 6px 不引入新行高、无 hover 显隐、无断点条件分支;ctx 菜单为既有面(滚动上限既有)。代码层已由 mount 测试钉住结构/颜色/顺序契约。
- **桌面 GUI / 远程浏览器 / PWA 的像素级渲染比对未做**(本关卡无 GUI 运行环境;worklog 中 coder 已显式移交至 fe-reviewer 与用户实测)。归入用户验收:桌面 WebKit 行高目测、移动端 ≤768px 行宽挤压场景。风险有界:点族宽上限 24px(3×6+2×3),meta 簇本就多标记并存。

## 下一步

- 停 completed-ready,**不 push、不关 issue**。
- OPEN(不阻塞,沿 coder worklog):`tagDotsTip` 为全量标签名并列、无「+N」计数——按拍板「溢出并入 tooltip」最简实现,用户实测后如需计数再立项。
