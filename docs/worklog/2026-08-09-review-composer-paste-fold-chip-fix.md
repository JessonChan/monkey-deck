# 2026-08-09 Fix #24241 review: paste-fold 注释英文化 + 预览 copy/语义对齐

## 起因
Task #24242:落地 review #24241(REVIEW #91 composer paste-fold chip,REQUEST CHANGES)
的两条 P1 必修项。原 PR(commit `8aea26e`,Task #24240)把 >20 行大段粘贴折叠成 chip,
设计正确(34/0 测试通过),但违反两条硬约束。

## 必修项与改法

### #1 [P1] 新增注释全中文 —— §3.7 硬约束
`Composer.tsx` + `index.css` 本次新增的 paste-fold 相关注释几乎全为中文。逐条翻成英文
(意思不变),触及的 `(见 submit)` 片段一并转 `(see submit)`。仅转 review 列出的本次新增
注释,不碰 PR 之前就存在的中文注释(非本次改动范围,§3.7「不要求一次性全仓翻译」)。

涉及:`PASTE_FOLD_THRESHOLD` 说明块 / pasteSnippets state 块 / snippetPreview 块 /
submit 还原注释 / 两处 JSX 注释(chip + 预览)/ onPaste chip-ify 注释 / index.css
`.paste-chip` 注释。

### #2 [P1] 预览复用「click to expand」文案但点击实际收起 —— §4.4/§4.5 误导
paste-snippet 预览的折叠 divider 与外层 div 都复用了 `composer-collapse` 的
`collapsePreviewHint`("click to expand")/ `collapsePreviewDivider`("⋯ click to expand ⋯"),
但二者点击都执行 `setExpandedSnippet(null)` —— 是**收起**整个预览,与「expand」文案完全
相反。`t` mock 返回 key 原样,测试只断言 key 名,挡不住 copy 语义反向。

**修法(选「click expands preview not collapse」方向,而非 review 的 copy-only 兜底)**:
新增专用 i18n key,并把 divider 的行为从「收起」改成「展开折叠的中间行」,使「click to
expand」名副其实;关闭预览交给外层区域(独立 key 说「close」)。

- 新 key(en + zh):
  - `composer.pasteSnippetCloseTip` = "Click to close preview" / "点击关闭预览"
    (预览外层 title,点击外层区域 → 关闭预览)
  - `composer.pasteSnippetFoldNote` = "⋯ {{count}} lines folded (click to expand) ⋯" /
    "⋯ 已折叠 {{count}} 行(点击展开) ⋯"(divider,`{{count}}` = 中间折叠行数)
- 行为:
  - **divider 点击 → 展开**(`setSnippetFullyExpanded(true)`):揭示被折叠的中间行,预览
    变为显示全文(all 行),divider 消失。`stopPropagation` 防触发外层关闭。
  - **外层区域点击 → 关闭**(`setExpandedSnippet(null)` + `setSnippetFullyExpanded(false)`):
    预览整块消失,回到只剩 chip。
  - chip 体仍可再次点击收起(toggle,同原行为)。
- 新 state `snippetFullyExpanded`(boolean):控制预览内是否展开全文。打开新预览 / 关闭 /
  submit / 切 session 时重置为 false。
- `snippetPreview` useMemo 返回值由 `{ head, tail, note }` 改为
  `{ all, head, tail, foldCount }`:`all` 供展开态渲染全文,`foldCount` 供 divider 文案插值。
- divider 加 `data-testid="paste-snippet-expand"`(§4.2,供测试锚定)。
- `collapsePreviewHint` / `collapsePreviewDivider` 仍被**长文本折叠**(`composer-collapse`)
  继续使用,保留不删。

## 改了哪些文件
- `frontend/src/components/Composer.tsx`(注释英文化 + 预览语义重构 + 新 state)
- `frontend/src/index.css`(`.paste-chip` 注释英文化)
- `frontend/src/i18n/locales/en.json`(+`pasteSnippetCloseTip` / `pasteSnippetFoldNote`)
- `frontend/src/i18n/locales/zh.json`(同上)
- `frontend/src/components/Composer.mount.test.tsx`(divider 文案断言改 key;
  新增「divider 展开中间行、外层关闭」回归测试)

## 验证
- `wails3 generate bindings`(本 worktree 无 bindings,补齐)。
- `cd frontend && bun run build`(tsc + vite build)通过,无 TS / 编译错误。
- `bun test src/components/Composer.mount.test.tsx --isolate` → **35 pass / 0 fail**
  (原 34 + 新增 1 条 divider-expand 回归)。新测试锚定:
  - 折叠态:head/tail 可见、中间行 `log line 13` 不可见、divider 在;
  - 点 divider → 预览仍在(旧代码这里会消失 = bug 复现)、中间行可见、divider 消失;
  - 点外层行 → 预览关闭。
- 全量 `bun test --isolate` → 194 pass / 5 fail;5 fail 全在 `NewSessionModal.*`,
  与本次改动无关,`git stash` 后仍 fail(pre-existing,环境/路径相关)。
- 无 lint 脚本(package.json 未配)。

## 下一步
- 桌面 app 实测:粘贴 >20 行 → chip → 点 chip 出预览 → 点 divider 展开全文 → 点外层关闭。
- macOS WebKit + Win WebView2 跨平台抽检(§4.6)divider 展开动画 / tooltip。

## 设计备注
review #2 给了两个方向:(a) 保留收起行为 + 改 copy 说「close」;(b) 把点击改成展开。
本任务标题明确选 (b)「click expands preview not collapse」,故实现为 divider 展开中间行
(更贴「expand」语义且 UX 更好——用户真能看到被折叠的内容),并新增 `pasteSnippetCloseTip`
给外层关闭。`pasteSnippetFoldNote` 的 `{{count}}` = 中间折叠行数(= 全文行数 − head − tail)。
