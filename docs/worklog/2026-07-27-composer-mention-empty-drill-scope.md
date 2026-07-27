# 2026-07-27 前端 Composer @ mention:空 query 即弹 + 目录下钻 + scope 透传 + 面板 UI

**类型**:feat(frontend)

## 起因

Task #23449。承接后端 Task #23448(`FuzzyFind` 加 `scope` 参数 + 空 query 返根子项含目录 + fuzzy 含目录)。前端 Composer 的 @ mention 此前有三个体验缺口:

1. **空 query 关面板**:用户打 `@` 还没开始输字时下拉是空的(旧实现 `if (!q.trim()) close`),看不到项目结构、没法浏览。期望像 IDE quick-open:输入 `@` 即列根子项,可挑文件、可往下钻。
2. **无目录下钻**:旧实现只把 FuzzyFind 命中(且当时仅文件)当扁平列表;目录不可点击进入,跨目录找文件只能靠打字模糊。
3. **无 scope 透传**:旧签名 `SessionFuzzyFind(sessionId, query, limit)`,新签名加了 `scope` 但前端没传,「在当前目录内搜索」无从表达。

## 设计

### 不变量:文本是唯一事实源(§5.3)

drill 态(scope = 当前下钻到哪一层)**完全由 @ token 的文本表达**,不另存 state:

- `@foo` → scope="", term="foo"(全项目模糊)
- `@src/foo` → scope="src", term="foo"(src 子树模糊)
- `@src/` → scope="src", term=""(列 src 子项,drill 态;尾随 `/` 是标记)
- `@src/sub/` → scope="src/sub", term=""(drill 两级)

新增 `splitScopeTerm(q)`:按 query 最后一个 `/` 拆 (scope, term)。刷新 / 撤回编辑 / 恢复草稿都能从文本复现面板态,没有「state 与文本不一致」的 bug 类。

### query 始终打后端(含空 term)

mention `useEffect` 去掉 `if (!q.trim()) close` 分支:无论 term 是否空,都按 `(scope, term)` 调 `SessionFuzzyFind(sessionId, scope, term, 12)`。后端对空 term 返 scope 的直接子项(目录优先、字母序、尊重 .gitignore,Task #23448 已落地),前端直接渲染 —— `@` 即弹根目录列表。

### 目录项下钻 vs 文件项选中

- 目录项(`isDir`):点 / Enter / Tab → `drillMention(node)`:把 `@query` 替换为 `@<dirpath>/`(尾随 `/`),不关面板、不记提及;`useEffect` 据新 query 重算 scope 并列子项。
- 文件项:`pickMention` 不变 —— 替换为 `@<path> + 尾随空格`,记为 Mention、关面板。
- 统一入口 `activateMention(node)` 按是否目录分流。

### 返回上一级

- drill 态(scope≠"")面板顶部渲染「返回上级」行(`data-testid="mention-go-up"`),点之 `goUpMention()`:剥 query 末段(`src/sub/` → `src/` → ``)。
- 快捷键:面板内 Backspace 且 term 为空(光标紧跟 `/`)→ `goUpMention`(等价点 ..);Enter 在 `mentionIdx=-1`(焦点在返回行)→ `goUpMention`。

### 面板 UI

- 目录项:`<Folder>` 图标(强调色)+ basename + dim 目录前缀 + 右侧 `<ChevronRight>` 提示「可下钻」。
- 文件项:`<File>` 图标(text-3)+ basename + dim 目录前缀,无 chevron。
- 「返回上级」行:`<CornerUpLeft>` + 文案,text-3 弱化(非主体选项)。
- i18n 新增 `composer.mention.{goUp,goUpTip,drillTip}`(zh/en)。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`
  - 新增 `splitScopeTerm(q)` 工具(scope/term 拆分)。
  - mention `useEffect` 改走 `(scope, term)` 透传;去掉空 query 关面板分支;新增 `mentionScope` 派生。
  - 新增 `drillMention` / `goUpMention` / `activateMention`。
  - `onKeyDown` mention 分支:`Enter/Tab` 走 `activateMention`;`mentionIdx` 上界放宽到 -1(让 ↑ 能停到返回行);新增 Backspace 退一级。
  - 面板 render:目录/文件图标分流 + 目录 drill chevron + drill 态渲染返回行。
  - 导入 `Folder / ChevronRight / CornerUpLeft`。
- `frontend/src/index.css`:`.mention-item.is-dir/.is-file` 图标色、`.mention-drill-chev`、`.mention-up` 样式。
- `frontend/src/i18n/locales/{zh,en}.json`:`composer.mention.*` 三键。
- `frontend/src/components/Composer.mount.test.tsx`:
  - mock 签名 `(sessionID, scope, query, limit)`;原 `@foo` 用例断言改为 `("sid", "", "foo", 12)`。
  - 原「空 @query 关面板」用例改为「空 @query 即弹根子项(scope="",term="")」,断言目录/文件项类、根无返回行。
  - 新增 `describe("drill-down + scope + go-up")` 5 用例:目录下钻文本变 `@src/`、drill 态 scope 透传 + 返回行渲染 + 返回退根、`@src/foo` scope="src" term="foo"、Backspace 退级、drill 内选文件记提及并关面板。

## 验证

- `wails3 generate bindings` 重新生成(签名已含 scope);`npm run build`(=`tsc && vite build`)通过。
- `bun test src/components/Composer.mount.test.tsx`:10/10 通过(原 5 + 新 5)。
- `bun test`(全量):137 pass / 7 fail —— 7 fail 全在 `HarnessUpdateAwareness.mount.test.tsx`,**预存基线问题**(`git stash` 后干净基线同样 132 pass / 7 fail),与本次改动无关,是跨测试文件 mock 串扰(只在整批 `bun test` 不带 `--isolate` 时出现,单文件跑通过)。

## 下一步

- 桌面 app 实测跨平台 mention 面板渲染(macOS WebKit / Win WebView2,§4.6):目录图标色、chevron 对齐、返回行弱化态。
- 若用户反馈「想 @ 引用一个目录本身(作 ResourceLink)」当前不支持(目录项只能下钻),评估加修饰键(如 ⇧+Click 选为提及)—— 暂不做,等真实需求。
