# 2026-08-09 · Review #24228 draft-indicator 缩尺寸端到端验收(行高一致性)

## 起因
Task #24230(前端 reviewer):对 #24228(4433618 `style(sidebar): shrink draft-indicator
14→12 for consistent row height`)做前端验收。改动 1 文件、+5/-5 行,**纯 CSS**:
- `frontend/src/index.css` L301-305:`.draft-indicator` width/height `14px → 12px`、
  `.draft-indicator svg` width/height `9px → 8px`;同步更新块注释(说明新尺寸目的)。

功能目标:让 sidebar session 行「有草稿」(渲染 `.draft-indicator`)与「无草稿」
(渲染 `.session-time`)两种状态行高一致 —— 原来 14px 的草稿标记把有草稿的行撑高。

## 改动消费链(从定义点追到渲染点)
| 符号 | 定义点 | 消费点 | 结论 |
|---|---|---|---|
| `.draft-indicator` | index.css:304 | `Sidebar.tsx:405` `<span className="draft-indicator" …><Pencil /></span>` | ✓ 唯一一处渲染 |
| `.draft-indicator svg` | index.css:305 | 同上 `<Pencil />`(lucide svg) | ✓ |
| `data-testid="draft-${s.id}"` | Sidebar.tsx:405 | 测试搜索:`rg "draft-indicator|draft-"` → **0 命中**(无测试锚定尺寸) | ✓ 无测试回归 |
| i18n `sidebar.draftTip` | en.json:66 / zh.json:66 | Sidebar.tsx:405 tooltip `t("sidebar.draftTip", { text })` | ✓ 两端同步、**本次未改字符串** |

**无类型补丁反模式**:无新增字段/类型;CSS 数值改动仅影响视觉,无逻辑链路。i18n 字符串
未变,无需新增 key。

## 行高一致性论证(端到端验收的核心)
`.session-item-main`(`index.css:237-242`)是 `display:flex; align-items:center`,
其高度 = 最高子元素高度。逐个子元素的实际高度:

| 子元素 | 高度 | 备注 |
|---|---|---|
| `.session-label`(标题文字) | **~14-15px** | 12.5px font、无显式 line-height → WebKit/WebView2 默认 ~1.15-1.2 → **行盒主导** |
| `.session-dot` | 7px | |
| `.session-harness-icon` | 12px | HarnessIcon size=12 |
| `.session-pin svg` | 11px | |
| `.tail-spinner` | 11px | |
| `.unread-dot` / `.perm-dot` | 7px / 8px | |
| `.session-time` | **10px** | `font-size:10px; line-height:1` |
| `.draft-indicator` | **旧 14px → 新 12px** | 本次改动 |

**结论**:
- **旧 14px**:在 label 行盒偏紧的引擎上(行盒 ~14px)与 label 持平甚至略超 → 有草稿行
  被撑高 1-2px,与无草稿行(session-time 10px 主导,但行高仍由 label ~14px 定)出现肉眼
  可见的高度差。**作者的经验观察成立。**
- **新 12px**:稳稳低于 label 行盒(~14-15px)→ 无论有/无草稿,行高都由 `.session-label`
  文字行盒主导,两种状态行高一致。**修复目标达成。✓**

12px 同时介于 `tail-spinner`(11px)与原 14px 之间,视觉上与其它 tail 图标(7-12px)协调,
不会突兀。glyph 8px / chip 12px ≈ 0.67 比例(旧 9/14 ≈ 0.64),比例略有上调但仍合理,
Pencil 笔尖在 8px 下仍可辨(hi-DPI 屏幕)。

## 纪律对齐
- §3.7 英文注释:块注释 L301-303 已改为全英文("Draft indicator: shown on idle sessions
  with unsent composer text. Sized down to 12px so it never inflates the row…")。✓
- §4.4 不裸露结构化格式:N/A(纯尺寸改动,无新展示内容)。✓
- §4.2 data-testid:`draft-${s.id}` 保留(Sidebar.tsx:405 未动),a11y/可测性无回归。✓
- §4.5 tooltip:沿用 react-tooltip(`data-tooltip-id="md-tip"` + `data-tooltip-content`),
  未引入原生 `title`。✓
- §5.3 找不变量:行高由「最高子元素」这一稳定不变量决定,改动直接把超标元素降到不变量
  (label 行盒)之下,而非加 `min-height`/`max-height` 之类启发式 hack。✓

## 类型 / 构建 / 测试
- 纯 CSS 改动,无 TS / binding / 类型涉及 → `tsc --noEmit` 无新增错误面。
- 无测试引用 `draft-indicator` 或其像素值 → 现有测试套件无回归风险(本次未跑全量,因改动
  不触及任何测试断言路径)。

## 观察(非阻塞,不阻止合并)
1. **块注释的表述精度 nit**:注释 L302-303 写 "never inflates the row beyond the
   session-time line height (10px / line-height 1)",但字面上 draft-indicator(12px)
   其实**高于** session-time(10px)。真正保证两种行高一致的不变量是 **`.session-label`
   文字行盒(~14-15px)** —— 它才是行高的主导者,draft 12px 与 session-time 10px 都在它之下。
   注释的结论(行不会被撑高)正确,但把基准归到 session-time 不够精确。可选优化:把括号里
   改成 "(governed by the .session-label text line-box, ~14-15px)" 之类。**纯文档精度,
   不影响行为,不阻断合并。**
2. `flex-shrink:0`、`border-radius:50%`、`inline-flex` 居中、soft accent chip 配色
   (`rgba(100,210,255,0.16)` + `var(--accent-2)`)均保留 —— 仅尺寸缩,视觉语言未变。✓

## 结论
**APPROVE #24228(Task #24230 PASS)。** 纯 CSS 尺寸缩改(14→12 / 9→8)+ 英文注释更新;
行高一致性论证成立(12px 稳低于 label 文字行盒主导的行高);无类型/绑定/i18n/测试影响;
data-testid 与 react-tooltip 保留,a11y 无回归;无类型补丁反模式。
一个注释精度 nit(基准应归 label 行盒而非 session-time),非阻塞。

## 下一步 / OUT OF SCOPE
- 可选:精修 `.draft-indicator` 块注释,把行高基准表述为 `.session-label` 文字行盒(非 session-time)。
