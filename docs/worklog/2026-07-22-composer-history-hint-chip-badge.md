# 2026-07-22 输入框翻历史显眼提示(placeholder 瘦身 + compose-tools hint chip + 翻历史即时反馈徽标)

## 起因

Task #21325。原 `composer.placeholderNormal` 把所有快捷键塞进 placeholder:

> 给 monkey-deck 发消息…(Enter 发送 · Shift+Enter 换行 · @ 提文件 · / 看命令 · ↑↓ 翻历史)

问题:
1. **placeholder 过长** —— 文本挤、视觉噪、移动端/窄屏被截断;且 placeholder 在有内容 / 聚焦有内容时消失,Hint 曝光不持续。
2. **↑↓ 翻历史无可视入口** —— Enter / Shift+Enter 是通用约定,@ 有提及按钮、/ 有斜杠按钮,唯独 ↑↓ 翻历史没有任何 UI 元素提示,只藏在 placeholder 一行小字里;新用户根本发现不了。
3. **翻历史无即时反馈** —— 按 ↑↓ 时输入框内容被替换,但用户不知道自己翻到「第几条 / 共几条」,也不知道当前是翻历史态还是草稿态,容易迷失。

本任务一次性闭合这三点:**placeholder 瘦身** + **compose-tools hint chip**(把最隐晦的 ↑↓ 提到工具栏) + **翻历史即时反馈徽标**(导航中显示位置)。

## 改法

### 1. placeholder 瘦身(i18n)

`frontend/src/i18n/locales/{zh,en}.json` 的 `composer.placeholderNormal`:

- zh:`"给 monkey-deck 发消息…   (Enter 发送 · Shift+Enter 换行 · @ 提文件 · / 看命令 · ↑↓ 翻历史)"` → `"给 monkey-deck 发消息…"`
- en:同理去掉括号内全部 Hint,只留 `"Message monkey-deck…"`。

快捷键提示迁移到 chip / tooltip(下方),不再挤占 placeholder。`placeholderQueued` 保持不变(排队语义文案,不涉及此次改动)。

### 2. compose-tools hint chip + 翻历史徽标(Composer.tsx + index.css)

**核心思路**:在 `compose-tools` 行(slash 按钮之后)加一个元素,它有两种互斥态:

- **未翻历史态 → `compose-history-chip`**(可点按钮):文本 `↑↓ 历史` / `↑↓ History`,hover tooltip(`composer.historyHintTip`)说明用法。**点击等价按 ↑**:调 `navigateHistory(-1)` 进入翻历史并聚焦输入框(给只 mouse 的用户一个入口)。
- **翻历史中态 → `compose-history-badge`**(span,不可点):文本 `历史 {{idx}}/{{total}}` —— `idx` = `navDisplay + 1`(1-indexed,旧→新,最新那条 = N/N),hover tooltip(`composer.historyBadgeTip`)说明 ↑↓ 方向。徽标用 accent 配色 + 入场动画,翻历史时即时替换 chip,用户一眼看到「我在第几条」。

两者都挂 `data-tooltip-id="md-tip"`(§4.5 统一 react-tooltip,禁用原生 title)。

**状态镜像(ref → state)**:`navigateHistory` 原本只用 `navRef`(事件处理同步读写,不触发重渲染)。徽标要随翻阅即时刷新,必须有 state 驱动渲染,故新增 `navDisplay` state:

- `navigateHistory`:每次更新 `navRef.current` 后 `setNavDisplay(navRef.current)`;恢复草稿分支同步 `setNavDisplay(-1)`。
- `handleChange` / `submit`:重置 `navRef.current = -1` 的同时 `setNavDisplay(-1)`(用户真实输入 / 发送即退出翻历史态,徽标消失、chip 回归)。

### 3. CSS(index.css)

- `.compose-tools` 加 `align-items: center`(chip/badge 与图标按钮垂直居齐)。
- `.compose-history-chip`:mono 字体 + `var(--elev-2)`/`var(--sep)` 边框,hover 转 accent 配色(与 `.composer-collapse-toggle` 同语言,视觉一致);`margin-left: 4px` 与前面的图标按钮拉开间隔。
- `.compose-history-badge`:accent 配色(`color-mix` 14% 背景 + 40% 边框)+ `compose-history-badge-in` 0.12s 入场动画(scale + fade),让「chip → 徽标」的态切换有视觉反馈。

## 端到端贯通核对(非空壳)

1. **placeholder 瘦身传导**:`Composer.tsx:519` `placeholder={prompting ? t("composer.placeholderQueued") : t("composer.placeholderNormal")}` —— 改后 placeholderNormal 值即输入框 placeholder 文案。✓
2. **chip / badge 渲染处**:`Composer.tsx:590` `{history.length > 0 && (navDisplay >= 0 ? <badge> : <chip>)}` —— 在 `compose-tools` div 内,挂 `composer-history-chip` / `composer-history-badge` class 与 testid。✓
3. **navDisplay 驱动**:`navigateHistory` / `handleChange` / `submit` 三处入口都同步 `navDisplay`,徽标随翻阅 / 输入 / 发送即时更新。✓
4. **i18n key 传导**:`composer.historyHint` / `historyHintTip` / `historyBadge` / `historyBadgeTip` 均在 chip/badge 渲染处经 `t(...)` 取值,非硬编码。✓
5. **点击 chip 触发导航**:`onClick={() => { navigateHistory(-1); requestAnimationFrame(() => ref.current?.focus()); }}` —— 进入翻历史态(徽标出现)并聚焦(后续 ↑↓ 键能继续翻)。✓

## 规约合规

- §4.4:chip/badge 文案全走 i18n 人话(`↑↓ 历史` / `历史 3/10`),无裸露结构化格式。✓
- §4.5:统一 `react-tooltip`(`md-tip`),禁用原生 `title`(chip/badge 都用 `data-tooltip-*`)。✓
- §4.6:chip/badge 是纯 CSS 驱动(无 canvas / 重 backdrop-filter / 动画仅 0.12s transform+opacity),跨平台一致,轻量。✓
- §5.3 KISS / Less is More:复用现有 `navigateHistory` 逻辑,只加一个 state 镜像 + 两段 JSX;chip 与 badge 互斥态共用一个挂载点,不引入额外组件。✓
- §0.3 / §6.2:本 worklog 已写;commit 原子(代码与文档分两个 commit),代码 commit diff 仅含 i18n + Composer.tsx + index.css 三类直接相关文件,不夹带。✓

## 验证

- `make bindings` → `cd frontend && bun run build`:tsc + vite 通过(无类型 / 编译错误)。✓
- `cd frontend && bun test`:60 pass / 0 fail(streamMerge / ModelSelect / MermaidRenderer 等未受影响)。✓
- `go build ./...` / `go vet ./...`:clean(只剩 macOS SDK 链接器版本警告,非错误,与本改动无关)。✓
- `node -e 'JSON.parse(...)'`:zh.json / en.json 改后均合法 JSON。✓
- 无 Go 改动(纯前端 + i18n + CSS)。

## 改了哪些文件

- `frontend/src/i18n/locales/zh.json`:`placeholderNormal` 瘦身;新增 `historyHint` / `historyHintTip` / `historyBadge` / `historyBadgeTip`。
- `frontend/src/i18n/locales/en.json`:同上(英文)。
- `frontend/src/components/Composer.tsx`:新增 `navDisplay` state;`navigateHistory` / `handleChange` / `submit` 同步镜像;compose-tools 行加 chip(未翻历史)/ badge(翻历史中)互斥渲染。
- `frontend/src/index.css`:`.compose-tools` 加 `align-items`;新增 `.compose-history-chip` / `.compose-history-badge` + 入场动画。
- `docs/worklog/2026-07-22-composer-history-hint-chip-badge.md`(本文件)。

## 下一步

- 实测:在桌面 app / server 模式(§5.5)接真 session 验证:① placeholder 短了;② chip 点击 / ↑↓ 都能进翻历史;③ 徽标位置随 ↑↓ 即时变;④ 输入 / 发送后徽标消失、chip 回归。
- 若用户反馈 chip 在 compose-tools 里偏挤(attach + image + slash + history 四件),可考虑只在 `empty`(无内容)时显 chip,有内容时收为 tooltip-only;当前选择常显以保证持续曝光(对齐任务标题「显眼提示」)。
