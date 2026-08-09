# 2026-08-09 Review #91 Composer 大段粘贴折叠 chip (REQUEST CHANGES, Task #24241)

**起因**:Task #24241 对 #24240/#91(commit `8aea26e`,feat(composer): fold large paste
(>20 lines) into a chip, restore full text on submit)做 Frontend Reviewer 独立复审。本审
只评前端(`frontend/src/`),无后端 Go 改动。

## 复审范围

- `frontend/src/components/Composer.tsx`(`PASTE_FOLD_THRESHOLD` / `PasteSnippet` /
  `pasteSnippets` + `expandedSnippet` state / sessionId reset / `addPasteSnippet` /
  `removePasteSnippet` / `snippetPreview` useMemo / `onPaste` >20 行分支 / `submit` 拼接还原 /
  `empty` 判定 / att-chips + paste-snippet 预览渲染)
- `frontend/src/components/Composer.mount.test.tsx`(新增 5 例 `Composer large-paste
  fold-to-chip (Task #24240)`)
- `frontend/src/index.css`(`.paste-chip` / `.paste-chip-toggle` / `.paste-chip-expanded`)
- i18n(`composer.pasteSnippet` / `composer.pasteSnippetTip` / `common.remove`,en + zh)
- §4.4(不裸抛结构化)/ §4.5(tooltip 人话)/ §3.7(注释英文)/ §4.2(data-testid)/ 类型安全

## 验证(acceptance gate)

- `cd frontend && bun install` + `bun test src/components/Composer.mount.test.tsx --isolate`
  → **34 pass / 0 fail**(含新增 5 例 paste-fold + 既有 paste-collapse / mention / slash / Tab
  regression 全过),与 worklog 记录一致。
- 测试断言锚定**值**(`onSend.mock.calls[0][0]` 含具体行 `log line 1` / `log line 25`、
  `sendBtn.disabled` 真假、`onChange` 被 `""` 调用),非字段存在,符合反模式要求。✅
- 注:`node_modules` 在本 worktree 未安装,首次需 `bun install` 才跑得起来(环境约束,非代码问题)。

## 设计正确性 ✅(核心路径无问题)

- **onPaste 顺序**:图片(优先)→ paste-fold(>20 行 `preventDefault` + 捕获 chip + `return`)
  → 短→长折叠(原逻辑)。阈值 20 > 整体折叠阈值 8,二者互斥:超 20 行根本不进 textarea,
  谈不上后续折叠,顺序正确。
- **submit 还原**:`combined = [raw, ...snippets.text].filter(非空).join("\n\n")`;`forcePlain`
  分支不 trim(保留前导空格转义 `/`),`sendAsPlain` 走 `submit(" " + value, mode, true)` 时
  snippet 仍拼接在转义文本之后 —— 边缘但自洽(snippet 不应因命令转义而丢失)。✅
- **`empty` 判定**:纳入 `pasteSnippets.length === 0`,只有 chip 无手打文本也可发。✅
- **sessionId reset**:`useEffect([sessionId])` 清 `pasteSnippets`/`expandedSnippet`/
  `snippetIdRef.current`,与 attachments 等 per-session 隔离行为对齐(Composer 无 per-session
  key、不随 session 切换重挂载)。`ps-N` key 在 siblings 内唯一即可,reset 后复用计数无碰撞。✅
- **§4.4**:预览只显可读文本行(`<div className="composer-collapse-line">{l || " "}</div>`),
  不裸抛 JSON / 原始对象。✅
- **i18n 同步**:3 个新键 `composer.pasteSnippet` / `composer.pasteSnippetTip` / `common.remove`
  en + zh 齐全、插值变量 `{{lines}}` 对齐、位置一致。✅
- **CSS 布局**:`.att-chip` 基类 `inline-flex`;`.paste-chip-toggle` 做 button reset
  (`background:none;border:none;font:inherit`),嵌套进 chip 不破坏布局。✅
- **data-testid**:`paste-chip` / `paste-chip-remove` / `paste-snippet-preview` 齐全(§4.2)。✅

## 必须修复(REQUEST CHANGES)

### #1 [P1] 新增注释全部为中文 —— 违反 §3.7 硬约束

`Composer.tsx` + `index.css` 本次新增的注释**几乎全为中文**,而 §3.7 是硬约束:**「新增注释一律
用英文;旧中文注释触及即转英文」**。逐条:

- `Composer.tsx:~208` `// --- 大段粘贴折叠成 chip(PASTE_FOLD_THRESHOLD)---` 起 4 行全中文
- `Composer.tsx:~217` `// Composer 不随 session 切换重挂载 …` 2 行全中文
- `Composer.tsx:~226` `// 展开预览的折叠块(复用 composer-collapse …)` 中文
- `Composer.tsx:~327` `// 还原完整文本:大段粘贴被 chip 化 …` 2 行全中文
- `Composer.tsx:~778` `{/* 大段粘贴 chip:复用 att-chip 视觉 … */}` 中文 JSX 注释
- `Composer.tsx:~806` `{/* 展开的 paste-snippet 预览 … */}` 中文 JSX 注释
- `Composer.tsx:~901` `// 大段文本粘贴(> PASTE_FOLD_THRESHOLD 行)…` 3 行全中文
- `index.css:1104` `/* 大段粘贴 chip:复用 att-chip 视觉 … */` 中文
- 另:`Composer.tsx:~59` 英文注释里夹了一个中文片段 `(见 submit)` —— 同属未转英文。

**修法**:把上述注释整体翻成英文(意思不变即可)。这是本 PR 最干净的必修项,纯文档层面、零逻辑
风险。§3.7 写得很明确,无解释空间。

### #2 [P1] 预览复用了「click to expand」文案,但点击实际是「收起」—— §4.4/§4.5 误导

`Composer.tsx:~808-823` paste-snippet 展开预览复用了 `composer-collapse` 的两套文案:

```tsx
<div className="composer-collapse paste-snippet-preview"
     title={t("composer.collapsePreviewHint")}                 // ← "Click to expand full editor"
     onClick={() => setExpandedSnippet(null)}>                  // ← 实际:收起
  ...
  <button className="composer-collapse-divider"
          onClick={(e) => { e.stopPropagation(); setExpandedSnippet(null); }}>
    {t("composer.collapsePreviewDivider", { note: snippetPreview.note })}   // ← "⋯ N lines folded (click to expand) ⋯"
  </button>
```

`collapsePreviewHint` = "Click to expand full editor" / "点击展开全文编辑";
`collapsePreviewDivider` = "⋯ {{note}} (click to expand) ⋯" / "⋯ {{note}}(点击展开) ⋯"。

这两个 key 在**原 `composer-collapse`** 里是对的:那个块是**折叠态预览**,点击 `expandInput()`
**展开**成完整 textarea 编辑器,所以「click to expand」名副其实。

但 paste-snippet 预览的语义**正好相反**:它是用户点 chip 后的**展开/窥视态**,点击(外层 div 或
divider)执行 `setExpandedSnippet(null)` —— 是**收起**预览,且**不会**展开显示被折叠的中间行。
于是用户看到「⋯ N lines folded (click to expand) ⋯」,以为点一下能看到中间被折叠的行,结果
**整个预览消失了**——动作与文案完全相反。

- **违反 §4.5**(tooltip 必须准确说明元素作用)与 §4.4(不误导用户)。
- **为何测试没挡住**:`t` mock 返回 key 原样,断言只查
  `textContent.toContain("collapsePreviewDivider")`(key 名),无法发现真实文案语义反向 ——
  这正是「mock 化 i18n 测不到 copy 语义」的典型,文案选择只能靠人审。
- **修法**:为 paste-snippet 预览**新增专用 key**(不复用 expand 语义的 key),例如:
  - `composer.pasteSnippetCloseTip` = "Click to close preview" / "点击关闭预览"(预览外层 title)
  - `composer.pasteSnippetFoldNote` = "⋯ {{count}} lines folded (click to close) ⋯" /
    "⋯ 已折叠 {{count}} 行(点击关闭) ⋯"(divider,`{{count}}` = 中间折叠行数)
  - 或更简:title 直接复用 `common.collapse`("Collapse"/"收起"),divider 只显
    `linesFolded`("{{count}} lines folded")而不带动作动词。

## 观察项(非阻塞)

### #3 [P3] `snippetPreview` 的 else 分支是死代码 + 用错文案

`Composer.tsx:~229` snippetPreview:

```tsx
if (all.length > COLLAPSE_HEAD_LINES + COLLAPSE_TAIL_LINES) {   // HEAD+TAIL = 4+2 = 6
  return { head, tail, note: t("composer.linesFolded", { count }) };
}
return { head: all, tail: [], note: t("composer.longLineTruncated", { count: sn.chars }) };
```

`addPasteSnippet` 仅由 `onPaste` 的 `pasted.split("\n").length > PASTE_FOLD_THRESHOLD(20)` 触发,
即每条 snippet 的 `lines > 20`;`all = sn.text.split("\n")` ⇒ `all.length > 20 > 6`,**if 恒真**,
else 分支**不可达**。且 else 里用 `longLineTruncated`("{{count}} chars · long line truncated")
语义也错(此时是「全文展示、无截断」,不是「长行截断」)。

- 无功能影响(不可达),但属「带误导文案的死代码」。建议直接删 else、或保留并换成正确文案
  (如 `linesFolded`/`lineCharCount`)。不阻塞。

### #4 [P3 a11y] 预览外层 `<div onClick>` 不可键盘聚焦

`Composer.tsx:~808` 预览块用 `<div onClick={…收起…}>`,非 button、无 `tabIndex`/`role`,键盘用户
无法聚焦后回车收起。不过 chip 体本身是 `<button>`(`paste-chip-toggle`),再次点击 chip 即可收起
预览(同一 state toggle),故键盘路径存在、无功能死路。可选加 `role="button" tabIndex={0}` +
`onKeyDown` Enter/Space 收起以增一致性。nit。

### #5 [P3 nit] `snippetPreview.note` 与 divider 复用结构 —— 记录设计耦合

paste-snippet 预览整体复用了 `composer-collapse` 的 DOM 结构 + class(`composer-collapse-pre` /
`composer-collapse-line` / `composer-collapse-divider`),视觉一致性收益明确。但两处语义相反
(见 #2:collapse=点击展开 vs paste=点击收起),复用结构没问题、复用**文案 key** 才是坑。
#2 修好后此耦合即可接受,仅记录。

## Verdict:REQUEST CHANGES

核心设计(onPaste >20 → chip 化、submit 空行拼接还原完整原文、empty 纳入 snippet、sessionId
reset、att-chip 视觉复用、data-testid、i18n en/zh 同步、测试锚值 34/0 pass)实现正确、验收通过。
但两条硬约束违规必须先修:

- **#1(§3.7 新注释全中文)** —— 纯文档层、零风险,直接翻成英文。
- **#2(预览文案「click to expand」与实际「收起」反向,§4.4/§4.5)** —— 新增专用 i18n key,
  不要复用 expand 语义的 `collapsePreviewHint` / `collapsePreviewDivider`。

#3/#4/#5 非阻塞,建议 #3(删死代码)顺手清。

## 改了哪些文件

- `docs/worklog/2026-08-09-review-composer-paste-fold-chip.md`(本条,新增)
