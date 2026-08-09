# 2026-08-09 · Review #24220 Composer Tab 路径补全(Composer.tsx + mount 测试)

## 起因
Task #24220(前端 reviewer):对 #24219(5968d29 `feat(composer): Tab path autocomplete via
SessionFuzzyFind`)做前端验收。改动 2 文件,纯前端增量:
- `frontend/src/components/Composer.tsx`:+60 行(新增 `detectPathToken` helper、`completeReqId`
  ref、`onKeyDown` 内 Tab 路径补全分支)。
- `frontend/src/components/Composer.mount.test.tsx`:+152 行(新增 `describe("Composer Tab path
  autocomplete (Task #24219)")`,7 个用例)。

功能:无菜单(斜杠 / @mention 关闭)、光标紧跟路径 token(非空、不以 `@`/`/` 开头、含 `/` 或 `.`)、
无选区时,Tab 触发 `SessionFuzzyFind`;**单匹配内联替换 token**(目录项追加 `/` 便于继续下钻、文件项
不追加),零匹配 / 多匹配什么都不做(焦点保留)。普通词 / 空白 fall through 到浏览器默认 Tab(移焦点)。
shift/ctrl/cmd/alt+Tab、IME 合成、选区、无 session 全部不触发。

## 验收方法(对照反模式清单)
逐条从**定义点**出发追到**消费点**,确认全链路真实消费(不是「字段加了没人用」):

| 新增符号 | 定义点 | 消费点(逐跳) | 结论 |
|---|---|---|---|
| `detectPathToken` (helper) | `Composer.tsx:88` | `onKeyDown` Tab 分支 L455 `detectPathToken(value, cursorRef.current)` | ✓ |
| `completeReqId` (ref) | `Composer.tsx:151` | L459 `++completeReqId.current`(发请求前 bump)→ L461 `reqId !== completeReqId.current`(resolution 比对丢弃 stale) | ✓ bump + 比对闭环 |
| Tab 路径补全分支 | `Composer.tsx:442-478` | `onKeyDown` 内,mention 菜单块(L414-440)之后、历史导航(L480+)之前 | ✓ |

**无类型补丁反模式**:`completeReqId` 有写有读、`detectPathToken` 有调用,无悬挂字段。

## 行为正确性复核
- **菜单优先级正确**:斜杠菜单 Tab(`slashOpen` 块 L405 `Enter||Tab` → `pickSlash` + `return`)
  与 @mention 菜单 Tab(L427 `Enter||Tab` → `pickMention/goUpMention` + `return`)都在新 Tab 块
  **之前** return;新 Tab 块自身又带 `!slashOpen && !mentionOpen` 守卫(L451)。双保险,菜单打开时
  Tab 永不进路径补全。✓(测试「Tab with slash menu open commits the command」已锚定此优先级)
- **`detectPathToken` 判定**(L88-97):从光标向前取最大非空白片段;空 / 以 `@`(mention 领域)/
  以 `/`(斜杠命令 + 绝对路径)开头 → null;不含 `/` 也不含 `.` → null(排除普通散文词,「fix this」
  里 Tab `this` 不误触发)。文本是唯一事实源,不另存 state(§5.3)。✓
- **scope/term 复用** `splitScopeTerm`(L74,与 @mention 一致):`src/compo` → scope=`src` term=`compo`。
  测试锚定 `expect(...).toHaveBeenCalledWith("sid", "src", "compo", 12)`。✓
- **单匹配才补全**(L463 `list.length !== 1` → return):零 / 多匹配 no-op,焦点保留。测试覆盖多匹配
  「value unchanged」+ `onChange` 未被调。✓
- **目录追加 `/`、文件不追加**(L465 `node.path + (node.isDir ? "/" : "")`):测试锚定
  `see src/components/`(目录)+ `edit src/components/Foo.tsx`(文件)。✓
- **幂等守卫**(L466 `replacement === tok.token` → return):匹配恰等于已输入 token 时不重写,避免
  无谓 onChange。防御性,合理。✓
- **race guard**(L459/461):单调递增 `completeReqId`,每次 Tab bump,resolution 比对,过期丢弃 ——
  正确防止「前一次 Tab 的结果写到后一次 Tab 的 token 上」(§5.3 按 identity 而非顺序)。✓
- **hasSelection 守卫**(L454 `el.selectionStart !== el.selectionEnd`):有选区时跳过,不破坏选区。✓
- **修饰键守卫**(L450 `!shiftKey && !ctrlKey && !metaKey && !altKey`):shift/ctrl/cmd/alt+Tab 交给
  浏览器(OS / 窗口快捷键)。✓
- **IME 不受影响**:composing 早退在函数顶部(L399),覆盖 Tab —— IME 选词用 Tab 不会被路径补全抢。✓
- **历史导航 / Enter 发送不动**:均在 Tab 块之后(L480+/500),与 Tab 无交集。✓
- **无路径 token 时 fall through**:不 preventDefault,Tab 走浏览器默认(移焦点),保留原行为。✓
- **无新 state / 无新 i18n / 无新 CSS**:补全是静默内联替换,无下拉 / 无气泡 / 无新可见元素,故无 i18n
  key、无 CSS。✓

## 纪律对齐
- §3.7 英文注释:`detectPathToken`(L80-87)、Tab 块(L442-448)、`completeReqId`(L149-151)全英文。✓
- §4.4 不裸露结构化格式:补全无任何用户可见技术格式输出。✓
- §4.2 data-testid:补全本身无离散元素、无需 testid;textarea `composer-input` 已有。✓
- §5.3 找不变量:文本唯一事实源(scope/term 从 token 推导、无额外 state);race guard 按 identity。
- i18n:无新 key,无需 en/zh 同步。✓

## 类型 / 构建 / 测试
- `bun test src/components/Composer.mount.test.tsx`:**29 pass / 0 fail**(22 旧 + 7 新),与 worklog
  声称一致。
- `npx tsc --noEmit`:Composer.tsx 仅 2 个**预存** error(全是 generated bindings 模块未找到
  `bindings/.../chatservice` / `.../fsview/models`,worktree 未跑 `wails3 gen bindings` 所致,全仓
  ~43 个同类)—— **本次改动 0 新增类型错误**。
- 测试质量(对照反模式「锚定值,非字段存在」):断言全部锚定值 ——
  `onChange` 末次调用等于 `"edit src/components/Foo.tsx"` / `"see src/components/"`、
  `SessionFuzzyFind` 调用参数 `("sid","src","compo",12)`、多匹配时 `onChange` **未**被调、
  普通词 / `@` token / 无 session 时 `SessionFuzzyFind` **未**被调。✓
- 测试隔离坑(踩坑已记在原 worklog):`@foo` 用例靠**同步**比对调用计数 + 末尾 `await 200ms` 让
  @mention 防抖在本用例内 settle,避免泄漏到下一用例 —— 根因是 `mount()` 不 unmount 旧 Composer,
  既有 @mention 用例都靠各自 `await 200ms` 自洽,本次沿用。可接受。

## 观察(非阻塞,不阻止合并)
1. **typing-vs-Tab 竞态(narrow edge case)**:resolution 回调里 `value`(L468)是 render 闭包
   (Tab 那一刻的快照),而 `pos = cursorRef.current`(L467)是 resolution 时**新鲜读**。两者来源
   不对称:若用户在 Tab 按下 → IPC resolve 之间又敲了一个字符,`value` 仍是旧值(长度 < 新 pos),
   `value.slice(pos)` 钳到 `""`,`onChange(next)` 会用旧值头部 + replacement **整段覆写**,丢掉那个
   字符。原 worklog 「补全基于快照…与 stale 无关」的表述对 **Tab-vs-Tab**(已被 `completeReqId`
   守住)成立,但对 **typing-vs-Tab** 不严谨。影响评估:本地 SQLite fuzzy find IPC 窗口约数十 ms,
   用户需在该窗口内击键;症状可恢复(retype / undo);功能是 opt-in(用户主动按 Tab)。**不阻断
   合并**。若后续要修,正解是 resolution 时先判 `cursorRef.current` 与 Tab 快照 pos 是否一致 /
   或比对当前 value 与快照,不一致即视为「用户已移动」abort —— 与 `completeReqId` 同一不变量思路。
2. **测试覆盖小缺口(均低风险)**:`hasSelection` 守卫、shift/ctrl/cmd/alt+Tab 修饰键守卫、`disabled`
   守卫均无显式用例(`sessionId` 守卫已测,是 `disabled` 的主情形)。非阻塞,可作后续补充。

## 结论
**APPROVE #24219(Task #24220 PASS)。** 全链路真实消费、无类型补丁反模式;菜单优先级 / 路径 token
判定 / 单匹配内联补全 / 目录追加 `/` / race guard(identity)/ IME / 历史导航 / fall-through 全部正确;
纪律对齐(英文注释 / 文本唯一事实源);29/0 测试过、0 新增类型错误;测试锚定值。一个 typing-vs-Tab
窄竞态 + 几处守卫测试缺口均非阻塞,记为后续。

## 下一步 / OUT OF SCOPE
- typing-vs-Tab 竞态:如要修,resolution 回调比对待快照(value + pos)不一致即 abort。
- 多匹配可视化(下拉):worklog 已明确「那是 @mention 的领地,不开第二条交互路径」—— 不做。
- 补 hasSelection / 修饰键 / disabled 守卫的显式用例(可选)。
