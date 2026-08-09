# 2026-08-09 · Review #24229 draft-indicator 14→12(行高一致 + 视觉可辨识)

## 起因
Task #24231(前端 reviewer):对 #24229(`4433618` `style(sidebar): shrink
draft-indicator 14→12 for consistent row height`)做前端验收。

**关键事实:#24229 的改动与上一轮 #24228(Task #24230 已 APPROVE)是同一 commit
`4433618`、字节级一致** —— 该 commit 连同上一轮 review worklog 已落在 `main`(`git
diff main..HEAD` 为空,`main` 与本 review 分支同指 `90e5f4f`)。即 #24229 是同一改动的
再次提交(重跑/重编号),非新内容。故本次以「独立复核 + 复述结论」处理,不重复逐像素论证,
只做端到端链路再确认 + 记录「为何是重复」这个事实本身。

改动 1 文件、+5/-5 行,**纯 CSS**:
- `frontend/src/index.css` L304:`.draft-indicator` width/height `14px → 12px`。
- `frontend/src/index.css` L305:`.draft-indicator svg` width/height `9px → 8px`。
- L301-303 块注释同步更新(英文,说明新尺寸目的)。

功能目标:让 sidebar session 行「有草稿」(渲染 `.draft-indicator`)与「无草稿」(渲染
`.session-time`)两种状态行高一致 —— 原 14px 草稿标记把有草稿的行撑高 1-2px。任务标题里的
「视觉可辨识」即「缩尺寸后仍能看清」(12px chip + 8px Pencil glyph 在 hi-DPI 仍可辨),无
额外配色 / 形状改动。

## 改动消费链(从定义点追到渲染点)
| 符号 | 定义点 | 消费点 | 结论 |
|---|---|---|---|
| `.draft-indicator` | index.css:304 | `Sidebar.tsx:405` 唯一一处 `<span className="draft-indicator" …><Pencil /></span>` | ✓ 单一消费 |
| `.draft-indicator svg` | index.css:305 | 同上 `<Pencil />`(lucide svg,未传 size → 默认 24px,被本 CSS 规则覆写为 8px) | ✓ CSS 是有效尺寸来源 |
| `data-testid="draft-${s.id}"` | Sidebar.tsx:405 | `rg "draft-indicator|draft-"` 测试目录 → **0 命中** | ✓ 无测试锚定,无回归 |
| i18n `sidebar.draftTip` | en.json:66 / zh.json:66 | Sidebar.tsx:405 `t("sidebar.draftTip", { text: dh.trim() })` | ✓ 两端 key 同位、`{{text}}` 插值一致、**本次未改字符串** |

**无类型补丁反模式**:无新增字段/类型;`draftBySession` prop(`Sidebar.tsx:38/403`)链路
未动,App.tsx 上游 `draftBySession` state 未动。CSS 数值改动仅影响视觉,无逻辑链路。

## 行高一致性(端到端复核,确认上轮结论仍成立)
`.session-item-main`(index.css:237-242)是 `display:flex; align-items:center`,行高 =
最高子元素高度。`.draft-indicator` 与 `.session-time` 在 `Sidebar.tsx:396-407` 是**互斥
三元**(同一 tail 槽位,有草稿渲染前者、否则渲染后者)。其余子元素高度:`.session-label`
文字行盒(~14-15px,12.5px 字号)主导、`.session-dot` 7px、harness icon 12px、pin 11px、
tail-spinner 11px。

- **旧 14px**:在行盒偏紧的引擎上(~14px)与 label 持平甚至略超 → 有草稿行被撑高。
- **新 12px**:稳稳低于 label 行盒(~14-15px)→ 无论有无草稿,行高都由 label 文字行盒主导,
  两状态一致。**修复目标达成。✓**

12px 介于 tail-spinner(11px)与原 14px 之间,与其它 tail 图标(7-12px)协调;glyph 8px /
chip 12px ≈ 0.67 比例,Pencil 笔尖在 hi-DPI 仍可辨 —— 即任务标题「视觉可辨识」成立。

## 纪律对齐(复核上轮已确认项,本轮仍 PASS)
- §3.7 英文注释:块注释 L301-303 已全英文。✓
- §4.4 不裸露结构化格式:N/A(纯尺寸,无新展示内容)。✓
- §4.2 data-testid:`draft-${s.id}` 保留(Sidebar.tsx:405 未动),a11y / 可测性无回归。✓
- §4.5 tooltip:沿用 react-tooltip(`data-tooltip-id="md-tip"`),未引入原生 `title`。✓
- §4.6 UI 库约束:无新库引入,纯 CSS。✓
- §5.3 找不变量:行高由「最高子元素」这一稳定不变量决定,改动把超标元素降到不变量(label
  行盒)之下,而非加 min/max-height 启发式 hack。✓

## 类型 / 构建 / 测试
- 纯 CSS 改动,无 TS / binding / 类型涉及 → `tsc --noEmit` 无新增错误面。
- 无测试引用 `draft-indicator` 或其像素值(`rg` 测试目录 0 命中)→ 无测试回归风险。

## 与 #24228 / Task #24230 的关系(重要)
- `4433618`(本 PR 的全部内容)= 上一轮 #24228 已审核的 commit,**字节级一致**(`git diff
  0f7e0a9 4433618` 为空,二者仅 hash/时间不同,内容同)。
- 该 commit + 上轮 review worklog(`2026-08-09-review-24228-draft-indicator-row-height.md`)
  均已在 `main`,`git diff main..HEAD` 为空。
- 结论:#24229 是同一改动的再次提交(重编号 / 重跑),无新代码可审。本轮独立复核上轮已通过的
  链路,结论不变。

## 结论
**APPROVE #24229(Task #24231 PASS)。** 纯 CSS 尺寸缩改(14→12 / 9→8)+ 英文注释更新;行高
一致性论证成立(12px 稳低于 label 文字行盒主导的行高);视觉可辨识(8px glyph hi-DPI 可辨);
无类型 / 绑定 / i18n / 测试影响;data-testid 与 react-tooltip 保留,a11y 无回归;无类型补丁
反模式。与上一轮 #24228(Task #24230)是同一改动,结论一致。

## 下一步 / OUT OF SCOPE
- 可选(承袭上轮 nit,非阻塞):`.draft-indicator` 块注释 L302 把行高基准表述归到 `.session-label`
  文字行盒(~14-15px)而非 session-time(10px)—— 注释结论正确,仅基准措辞可更精确。
