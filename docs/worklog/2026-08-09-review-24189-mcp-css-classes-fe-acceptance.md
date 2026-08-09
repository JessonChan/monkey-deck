# 2026-08-09 · Review #24189 MCP 设置面板 5 个 CSS 类 fe 端到端验收

## 起因
PR #24189(commit 245de7c)给 `frontend/src/index.css` 加了 5 个设置面板表单原语类
(`.btn` / `.btn.primary` / `.field` / `.settings-list` / `.settings-inline-toggle`)+ 10 个
`:root` 主题变量,声称「补齐 McpSettings 已引用但 CSS 未定义的类 + 让 index.css 里所有 var()
ref 都能解析」。本任务(#24191)由前端 reviewer 做**端到端验收**:确认这些类/变量真的被消费,
不是「字段加了全链路没人消费」的类型补丁反模式。

## 验收方法(对照反模式清单)
- **消费端逐个确认**(反模式:字段加了没人消费):从每个类 / 变量的**定义点**出发,grep 全部
  消费端(`.tsx` + `index.css`),确认至少一处真实引用。
  - 关键坑:第一轮 `grep "var(--$v)"` 漏掉了带 inline fallback 的引用(`var(--yellow, #ffd60a)`,
    `var(--warn-bg, rgba(...))` 等)——`var(--x)` 要求紧跟右括号,而带 fallback 的是 `var(--x, ...)`,
    不匹配。第二轮改 grep `--$v`(任意引用形式)才把 4 个「看似 0 消费」的变量(`--yellow`/
    `--warn-bg`/`--warn-bd`/`--accent-soft`)的真实消费点找出来。**结论:10 个变量全部被消费,无类型补丁。**
- **构建 / 测试**:`bun install` + `wails3 generate bindings`(worktree 缺 node_modules 与 bindings)
  → `bun run build:dev` 通过;`bun run test` 177 pass / 5 fail。
- **回归判定**:把 `index.css` 换回父提交版本重跑测试,结果完全一致(177 pass / 5 fail)→
  **5 个 fail 是 pre-existing**(全在 `NewSessionModal.mount.test.tsx` 的 worktree/git selector
  逻辑,与本次 CSS 改动无关),本次 0 回归。
- **i18n**:MCP 子树 zh/en 各 22 key,集合完全相等(zh-only / en-only 均空)。

## 消费清单(全部命中)
| 类 / 变量 | 消费点 |
|---|---|
| `.btn` | McpSettings ×4 |
| `.btn.primary` | McpSettings ×2 |
| `.field` | McpSettings ×7 |
| `.settings-list` | McpSettings ×1 + NewSessionModal ×1 |
| `.settings-inline-toggle` | McpSettings ×2 |
| `--text-1/--text-4/--fg/--fg-muted/--border/--elev-hover` | index.css 多处 |
| `--yellow` | index.css:1810/1812(带 `#ffd60a` fallback) |
| `--warn-bg`/`--warn-bd` | index.css:1017(`.slash-warn`,带 fallback) |
| `--accent-soft` | index.css:1520(`.git-ai-btn`,带 fallback) |

新类引用的 `:root` 变量(`--elev/--hover/--text/--text-2/--bg/--sep/--accent/--mono/--sans/--r-sm`)
全部已存在,无悬挂引用。

## 改了哪些文件(本次 review 顺手修的小问题,均在 index.css 同文件)
1. **`--accent-soft` 颜色漂移**:`.git-ai-btn`(index.css:1520)的 inline fallback 是
   `rgba(0, 132, 209, 0.12)`,而新加的 root 变量是 `rgba(10, 132, 255, 0.12)`。root 解析后实际
   渲染色从 (0,132,209) 静默漂移到 (10,132,255)=macOS systemBlue(= `--accent #0a84ff`,反而
   更对齐,但漂移是静默的)。把 fallback 对齐到 (10,132,255) 消除不一致。
2. **`.btn.primary:disabled` 冗余 + disabled 仍 hover 增亮**:原 `.btn.primary:disabled` 与
   `.btn:disabled` 设的属性完全一样(冗余);且 `.btn.primary:hover` 的 `filter: brightness(1.1)`
   未在 disabled 时复位 → disabled 主按钮 hover 仍会轻微增亮。改为 `.btn.primary:hover:not(:disabled)`
   一并解决(既删冗余,又堵 hover 增亮)。
3. **`.field` 硬编码 `border-radius:6px`** → `var(--r-sm)`(= 6px),与全文件几何变量风格一致。

> 不改:`.field :focus` 的 `rgba(10, 132, 255, 0.5)` 实为 `--accent` 在 0.5 alpha 的精确值,
> 与 accent 已对齐,且 `--accent` 是固定 macOS systemBlue,留作硬编码风险极低。

## 验证
- `bun run build:dev` 通过(含上述 3 处改动)。
- `bun run test`:177 pass / 5 fail,与改动前一致(5 fail 均为 pre-existing,非本次引入)。

## 结论
**APPROVE #24189。** 5 个类 + 10 个变量全部端到端被消费,无类型补丁反模式;构建通过;0 测试回归;
i18n zh/en 同步。顺带修了 3 处同文件小问题(颜色漂移 / 冗余规则 / 几何变量)。

## 下一步 / OUT OF SCOPE
- **McpSettings.tsx:239 的原生 `title=`**(`.settings-inline-toggle` 上)违反 §4.5(应用 react-tooltip,
  禁用原生 title)——这是**组件层 pre-existing 问题**,不在本 CSS commit 范围内,留作后续 follow-up。
- NewSessionModal 的 5 个 pre-existing test fail(worktree / base-ref selector 逻辑)另案排查,
  与本次 CSS 验收无关。
