# #174 标签点族 + ctx 菜单项目标签 quick-add(Task #28921)

## 起因

#160a 全撤行内 tag chip 后,session 行零标签足迹,用户实测盲操作(多个 session 无法一眼区分标签归属)。本卡是用户实测后的**显式回退**:推翻 #160a 的 zero-footprint 决策,但**只恢复点级标识,不恢复文字 chip**。

拍板(2026-08-31,父 issue #174):

1. **行内哈希色点族**:每标签一枚 6px 色点,颜色与过滤面板 / ctx 菜单同源(`tagColor()`),cap 3,溢出并入 tooltip,置于 meta 簇(harness icon / fork 徽章同区),行高不变。撞色风险已接受(小尺寸 + 固定槽 + tooltip 消歧)。
2. **ctx「标签 ›」菜单分两节**:会话已有标签(点击移除,现状不变)+ 项目其他标签(`collectTags(projSessions)` 同源首见序,点击追加)+ 自由输入保留;submenu 已有 `max-height: 240px; overflow-y: auto` 滚动上限(#160 时代即有,无需改)。

## 改法

- **点族**:`Sidebar.tsx` session 行 meta 簇内(fork 徽章之后、pin 之前)加 IIFE:无标签不渲染;有标签渲染 `span.session-tag-dots` 包裹(tooltip = 全量标签名,含溢出)+ 最多 3 枚 `span.session-tag-dot`(inline style `background: tagColor(tag)`)。
- **菜单两节**:submenu IIFE 里新增 `projTags = collectTags(props.sessionsByProject[ctx.session.projectId] ?? []).filter(t => !tags.includes(t))`(与过滤面板同一 `collectTags` 源、首见序):
  - 第一节 `ctx-label`「会话标签」+ 现有移除行(打勾 / 点击移除,契约不变);
  - 第二节 `ctx-label`「项目其他标签」+ 追加行(dot + 名称 + Plus 图标,`data-testid="tag-add-<sid>-<tag>"`,点击时**现查** `liveSession` 的 tags 再 `[...cur, tag]`——连续追加看到的是累积集,不是渲染时快照,与输入框路径同一约定);
  - 空态消息 `tagsEmpty` 收窄为「会话与项目都无标签」才显示(项目有可加标签时空话让位给 quick-add 列表);
  - 自由输入原样保留在底部。
- **CSS**:`index.css` 新增 `.session-tag-dots`(inline-flex / gap 3px / flex-shrink 0,归入 pin/renamed/terminal/popout 同一 persistent-marker 家族)+ `.session-tag-dot`(6px 圆点);并把过滤面板注释里「sessions carry zero visual tag footprint」的过时表述改为「文字 chip 仍移除,行内标识自 #174 起为点级」。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx` —— 点族 IIFE + 菜单两节 + 注释转英文(§3.7)。
- `frontend/src/index.css` —— 点族规则 + 过时注释修正。
- `frontend/src/i18n/locales/{en,zh}.json` —— 新键 `tagAddTip` / `tagsSessionSection` / `tagsProjectSection` / `tagDotsTip`。
- `frontend/src/components/Sidebar.tags.mount.test.tsx` —— 测试 1 由「#160a 零足迹」改写为「#174 点族契约」(≤3 点 / 颜色同源 / 溢出进 tooltip / 无标签无足迹 / `.session-tag-chip` 仍不存在);新增测试 8(两节菜单:quick-add 追加进 live 集 + 乐观更新后 db 就地翻转到已添加节)与测试 9(`tagsEmpty` 仅在全项目无标签时出现)。

## 验证

- `bun test components/Sidebar.tags.mount.test.tsx`:9/9 pass(70 expects)。
- `bun test components/Sidebar`:8 个 Sidebar mount 套件 48/48 pass,fork 徽章 / stray-zero / 重命名 / 定时等无回归。
- 全量 `bun test`:123 fail——与 pristine 基线(`git stash` 后重跑)**完全同数**(123 fail / 504 tests),系本 worktree 环境性预存失败(ChatView 虚拟化 / FilePanel search / Composer mention 等),本卡 delta = +2 tests 全 pass、0 新增失败。
- `npm run build`(tsc + vite production)通过(仅预存的 chunk>500kB 警告);本 worktree 需先 `wails3 generate bindings` 补齐 gitignore 的生成物。
- repo 无 lint 脚本(package.json scripts 仅 dev/build/preview/test)。
- **三端视觉回归未做**,原因与去向:本卡流程为 coder→fe-reviewer→APPROVE,视觉/三端(桌面 GUI / 远程浏览器 / PWA)渲染比对归 fe-reviewer 关卡;点族为 6px inline-flex 圆点、不引入新行高,CSS 层面无垂直空间增量。真机/桌面像素级验收待 fe-reviewer 与用户实测。

## 下一步

- fe-reviewer 审查;通过后停在 completed-ready,**不 push、不关 issue**(流程约定)。
- OPEN(不阻塞):`tagDotsTip` 溢出仅并列全量标签名、无「+N」计数——按拍板「溢出并入 tooltip」最简实现,若 fe-reviewer 要求计数再加。
