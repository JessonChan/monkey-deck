# 2026-08-10 Review #118b PathLinkified 气泡 @mention 显 @basename 前端 (APPROVE w/ fix, Task #24265)

**起因**:Task #24265 = Frontend Reviewer 对 #118b(实现 commit `08d3b56` + worklog `ffbb523` +
基线验收 `09dd682`)做端到端复审。改动纯前端,无后端 / Go 变更。

## 复审范围

- `lib/filePath.ts`:`PathSpan` / `TextPart` 加 `isMention?`;`findPathSpans` 做 @ 前导检测
  (token-boundary `@`)+ 吞 @(`start -= 1`、`raw = "@" + m[0]`);`splitByPaths` 透传 isMention
  (仅 true);新增纯函数 `pathPartLabel`(mention → `@basename[:line]`,普通路径 → `raw`)。
- `components/PathLinkified.tsx`:span 渲染分流 —— mention 用 `pathPartLabel` + `.path-mention`。
- `components/CollapsibleText.tsx`:工具 I/O 行内路径同步分流(共用 `pathPartLabel`)。
- `index.css`:新增 `.path-link.path-mention`(`color-mix` accent-2 12% 底 + 实线下边 + 圆角)。
- `lib/filePath.test.ts`:补 8 个 mention 用例,既有 12 用例保持绿。

## 正确性

### @ 前导检测(token 边界不变量,§5.3)✅
`findPathSpans` 在路径命中后**回看前一字符**,不做「上一个 token 是什么」的启发式分段:
- `text[at] === "@"` 且 `at === 0 || !/[\w@]/.test(text[at-1])` —— `@` 必须在 token 边界。
- 边界检查正确排除类 email 的 `a@b/c.ts`(`@` 前是 word 字母 `a` → 不算 mention,
  test `word@path 不当 mention` 验证)。✅
- 命中后吞 @(`start = at`、`raw = "@" + m[0]`),**保持 `raw == text.slice(start, end)` 不变量**
  (注释也写明)。`path` 始终干净(不含 `@`),`onOpen(p.path, …)` 与普通路径一致 —— 上层
  FilePreviewOverlay 无需特判。✅(§5.3 转换层不丢弃标识 / 尊重数据源)

### isMention conditional spread(形状稳定)✅
`...(isMention ? { isMention: true } : {})` —— 非 mention 的 span/part 形状不变,
既有 `toEqual({start,end,raw,path,line})` / `{type,raw,path,line}` 断言全绿(测试印证)。
对「字段加了但全链路没人消费」反模式的核查见下「⚠️ 发现并修复」。

### pathPartLabel 纯函数(DRY,§5.3)✅
PathLinkified + CollapsibleText 共用,渲染分流只在 label + className 两处分叉,span 结构收敛。
四个分支(`@basename` / `@basename:line` / `raw` / `raw:line`)由 test `pathPartLabel` 覆盖。✅

### CSS / 跨平台(§4.6)✅
`.path-link.path-mention` 纯 CSS(`color-mix(in srgb, var(--accent-2) 12%, transparent)` +
实线下边 + 圆角 + 微 padding),inline 轻量、无 canvas / 重绘。`--accent-2` 已定义(`#64d2ff`)。
`color-mix` 与既有 composer mention chip(`.att-chip-mention` line 1124)同款用法 —— **样式与
composer chip 同族**,符合「气泡 mention 显 @filename,与 composer 一致」的产品意图。✅

### TypeScript / Wails binding ✅
`pathPartLabel` 入参类型 `{ isMention?; path; line?; raw }` 与 `TextPart` path 变体字段完全对齐。
无新增 binding 字段,无 Go struct → TS 类型对齐问题。`bunx tsc --noEmit` 改动文件零逻辑报错
(其余报错全为 worktree 缺 `node_modules` / `bindings/...`,预存在,与本次无关)。✅

### i18n 同步 ✅
复用既有 `collapsibleText.openPathTip` / `previewPathTip`(`locales/{en,zh}.json:479-480` 双语),
**无新增 key**。`{{raw}}` 插值在 span title / tooltip-content 两处消费 —— 对 mention,`raw` 含
`@` + 完整路径(如 `@src/foo.ts`),**完整路径留在 tooltip**(气泡显 `@basename`)—— 符合
§4.4(不裸露长技术 token,tooltip 是承载细节的正确位置)。✅

### 可访问性(§4.2 / §4.5)✅
mention span 沿用既有 `role="button"` + `tabIndex={0}` + Enter/Space `onKeyDown` + react-tooltip
`md-tip` 单例。键盘可达、hover 有 tooltip(完整路径 + 「打开」提示)。无回归。✅

## ⚠️ 发现并修复:isMention 在 2/4 渲染消费端漏消费(类型补丁反模式)

**按 anti-pattern checklist「字段加了但全链路没人消费,从字段定义点逐个确认消费端」核查
`isMention` 的全部渲染消费端**:

| # | 消费端 | 位置 | 是否消费 isMention |
|---|---|---|---|
| 1 | `PathLinkified` span | `PathLinkified.tsx:32,50` | ✅ `pathPartLabel` + 条件 className |
| 2 | `CollapsibleText` renderLine(短/展开态) | `CollapsibleText.tsx:111,130` | ✅ |
| 3 | `CollapsibleText` 折叠预览 **head** | `CollapsibleText.tsx:243,252`(修前) | ❌ `className="path-link"` + `{p.raw}` |
| 4 | `CollapsibleText` 折叠预览 **tail** | `CollapsibleText.tsx:283,292`(修前) | ❌ `className="path-link"` + `{p.raw}` |

**症状**:折叠态(长工具 I/O 的 head/tail 预览)里的 @mention 仍显原始 `@src/foo.ts`(长路径、
无 chip 底色),而同一 mention 在短/展开态显 `@foo.ts`(basename + chip 底色)—— **违反代码自身
声明的「三态一致」不变量**(`CollapsibleText.tsx:83` 注释「短态/展开态/折叠预览态均复用本函数,
保持三态一致」)。根因:折叠预览 head/tail 是**重复的内联渲染代码**(未复用 `renderLine`),
#24263 的 mention patch 只改了 `renderLine`,漏改这两处。

**这正是 anti-pattern checklist 警告的「字段加了但全链路没人消费」**:isMention 加进了 PathSpan/
TextPart,但 2/4 渲染端没读它。coder worklog 自述「CollapsibleText 工具 I/O 行内路径同步分流,
保持与气泡一致」—— 意图覆盖,但实际只覆盖了 renderLine。

**修法**(本 review 一并修):head + tail 两处 span 对齐 renderLine ——
`className={p.isMention ? "path-link path-mention" : "path-link"}` + `{pathPartLabel(p)}`。
4 行机械对齐(diff 见 commit),零逻辑变更、零新依赖。修后 4/4 渲染端全部消费 isMention,
三态一致不变量恢复。

> 注:head/tail span 原本缩进不同(tail 因嵌在 `preview.tail.length > 0 && (` 内深 2 空格),
> 非字节相同 —— 故 `replaceAll` 首次只命中 head;tail 单独二次编辑,保留其原有 24/26 缩进深度。

## 观察项(非阻塞 nit,不改)

### #1 `pathPartLabel` 用 `part.line ?` 真值判断(line:0 理论丢失)
`return "@" + base + (part.line ? \`:${part.line}\` : "")` —— 若 `line === 0` 则 `:0` 被吞。
但文件行号 1-indexed,正则匹配 `\d{1,6}` 实际不会产出有意义的 `:0`;且非 mention 分支返 `raw`
(含 `:0`)本身一致性也只是理论。**不阻塞**,真要严谨可改 `part.line != null`。记为可选。

## 验证(acceptance gate)

1. `cd frontend && bun test src/lib/filePath.test.ts`:**20 pass / 0 fail**(12 旧 + 8 新 mention)。
2. `cd frontend && bunx tsc --noEmit`:改动三文件(filePath / PathLinkified / CollapsibleText)
   零逻辑 / 类型报错;其余报错全为 `Cannot find module 'react'` 等(worktree 缺 `node_modules`,
   预存在环境问题,与本次改动无关)。
3. CollapsibleText 4 处渲染端手动核查:renderLine + head + tail + PathLinkified 全部消费 isMention。

## Verdict:APPROVE(附 1 处一致性修复)

核心功能(气泡 @mention 显 @basename)设计合规、测试扎实、CSS/i18n/a11y 全过、@ 前导检测的
token 边界不变量正确。**唯一问题**:isMention 在 CollapsibleText 折叠预览 head/tail 两处渲染端
漏消费(类型补丁反模式 / 违反三态一致),本 review 已一并修复(4 行机械对齐,零逻辑变更)。
修后全链路消费 isMention,功能完整收口。建议合入(含本修复)。

## 改了哪些文件

- `frontend/src/components/CollapsibleText.tsx`:折叠预览 head(行 243/252)+ tail(行 283/292)
  span 对齐 renderLine —— isMention 条件 className + `pathPartLabel(p)`(关闭类型补丁反模式)。
- `docs/worklog/2026-08-10-review-118b-pathlinkified-mention-frontend.md`(本条,新增)。
