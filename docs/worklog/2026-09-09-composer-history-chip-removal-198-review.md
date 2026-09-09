# #198 Review:Composer 历史 chip/badge 移除(55393d5)独立复核 — APPROVE

- 日期:2026-09-09
- 角色:frontend reviewer(独立反相复核,不信叙事,以 main 内容为准)
- 对象:coder 卡 #29230,代码 commit `55393d5`(移除)+ `54ca850`(worklog);其上 `5524a81` 为 daemon fallback commit(仅 `.gitignore` +1 行,**非本卡产物,无前端影响**,已核实其 diff)。

## 结论

**APPROVE(2 个非阻塞观察项,见文末)。** 四项核查清单全过,红线(↑↓ 键盘翻历史行为零回归)成立,无「类型补丁」反模式。

## 核查清单结果

### ① Composer.tsx 移除反相核实 — 过

- 渲染块删净:`{history.length > 0 && (...)}` 两分支(`composer-history-badge` 徽标 / `composer-history-chip` 按钮)整块删除,无死代码残留;全仓 grep `navDisplay|setNavDisplay|compose-history|composer-history` 仅剩 3 处合法存在:测试文件的负向断言、Composer.tsx 顶部说明注释、locales.test.ts 的防复活 pin。
- **navDisplay state 镜像删除安全**:4 处 `setNavDisplay` 分别位于 turn 重置 effect、`navigateHistory` 草稿恢复分支、`navigateHistory` 主路径、`handleChange`——全是纯 state 镜像写,唯一消费者即被删徽标 JSX;逐行比对 diff 确认删的只有镜像写,无任何读取者。
- **红线成立**:`navRef = useRef(-1)`、`navigateHistory` 全体(空 history 守卫、进入时 `draftRef` 存草稿、`navRef = history.length - 1` 从最新进入、越界恢复草稿 + `moveCursorEnd`)、onKeyDown 守卫(↑ 首行无修饰键、↓ 仅翻历中末行)、`handleChange` 真实输入退出翻历——与父 commit 逐字一致。

### ② i18n 四键对称删 + 防复活 pin — 过

- `historyHint/historyHintTip/historyBadge/historyBadgeTip` 在 `en.json` 与 `zh.json` 同位置对称删除(各 4 行),leaf-key parity 保持。
- `locales.test.ts` 新增 pin 断言的是**键不存在**(`expect(k in composerZh).toBe(false)` + `composerEn` 同,4 键 × 2 locale),不是键存在——负向断言正确。
- `Composer.history.mount.test.tsx` 从渲染层二次钉死(testid + class 双选择器)。

### ③ CSS 全撤 + 无孤立引用 — 过

- `.compose-history-chip`、`.compose-history-badge` 定义块、`@keyframes compose-history-badge-in`、移动端 media query 内 `.compose-history-chip, .compose-history-badge { display: none; }` 全部删除。
- 相邻注释三处同步更新:分支指示注释(改写且转英文)、MCP chip 注释(去掉 `/ history-chip` 引用)、mobile media query 注释(`slash/history/branch` → `slash/branch`)。
- 全仓 grep 无孤立引用(仅测试负向断言与说明注释,合法)。

### ④ 测试真实钉死 + 零回归 + build/tsc 绿 — 过

- **mount 测试是真实钉死,非字段存在断言**:锚定值断言 `onChange` 序列——↑→`"newer"`、↑→`"older"`、↓→`"newer"`、翻过最新→恢复草稿 `"draft msg"`;chip/badge 缺席断言覆盖三个时机(idle、**翻历中即徽标原弹出点**、草稿恢复后)。符合「断言值流到具体输出」标准。
- 验证(本机实测,非转述):`bunx tsc --noEmit` 0 诊断;`bun run build`(tsc + vite production)成功;全仓 `bun test --isolate` **584 pass / 4 fail / 1 error**,4 fail + 1 error 全部落在 `App worktree live-guest guard on the delete chain (#199)`。
- 测试注释如实记录了 happy-dom + React 19 下 keydown 须 `ta.focus()` 才达 React 委托 handler 的实测约束。

### #199 基线失败复核 — 确认非本卡引入

不止于确认失败名:在 `git worktree add` 出的父 commit `590ff96` 干净检出上(复制同版本 bindings + node_modules)单独跑 `App.worktree-guard.mount.test.tsx` → **0 pass / 4 fail / 1 error,与 HEAD 完全同型**。基线实证成立;失败根因是 App mount 走 Wails 浏览器 HTTP transport 的环境性报错,与 Composer/i18n/CSS 改动无耦合路径(被删键全仓零消费者,tsc 绿佐证)。

## 环境备注(复现所需)

- 本 worktree 缺 `frontend/node_modules` 与 gitignored 的 `frontend/bindings/`:需 `bun install` + `wails3 task bindings`(产物不入库)后 tsc/test 才可跑;评审时已按此补齐。此为 worktree 常态,非代码问题。

## 观察项(非阻塞,不要求本卡处理)

1. Composer.tsx 个别未被本次改动触及的中文行内注释仍在(如 `navigateHistory` 的 `dir` 注释、`handleChange` 的退出翻历注释)——§3.7 触及即转,本次已转的部分(顶部块注释、CSS 三处)已合规,余者留待后续触及。
2. `bun run build` 有 chunk >500kB 提示,存量既有,与本卡无关。

## 下一步

- 卡 #29230 停在 completed-ready;不开 issue、不 push、不派后续卡。
