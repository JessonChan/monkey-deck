# 2026-09-09 #198 移除 Composer 历史提示 chip / 导航徽标(↑↓ 翻历史保留)

## 起因

Issue #198:placeholder 瘦身时为 ↑↓ 翻历史快捷键补的可视提示(compose-tools 里的
hint chip + 翻历中的导航徽标)决定移除——键盘功能保留,只删可视提示层。
Task #29230,XS 级按 orchestrator 实查的移除清单执行。

## 改法

改动面全在 `frontend/src`:

1. **`components/Composer.tsx`**
   - 删 `compose-tools` 内 `{history.length > 0 && (...)}` 渲染块(chip + badge 两分支,原 ~1213-1239)。
   - **连带删除 `navDisplay` state 镜像**(声明 + `resetBuffers`/`navigateHistory`/`handleChange` 里 4 处 `setNavDisplay` 调用)。原因:渲染块删除后 `navDisplay` 变 write-only,`tsc`(`noUnusedLocals`)报 `TS6133` 直接卡死 acceptance gate。该 state 唯一消费者就是被删的徽标,属可视层的一部分;**权威状态机 `navRef` + `navigateHistory` 逻辑逐字未动**,↑↓ 行为零变化。
   - 相关注释改写为英文并如实描述现状(§3.7 触及即转)。
2. **i18n 四键全撤**:`composer.historyHint` / `historyHintTip` / `historyBadge` / `historyBadgeTip`(`locales/en.json` + `locales/zh.json` 各删 4 行,对称删除保住 leaf-key parity)。
3. **CSS 两 class 全撤**(`index.css`):`.compose-history-chip` / `.compose-history-badge` 定义 + `compose-history-badge-in` keyframes + 移动端 media query 里的 `display:none` 引用行;顺带把引用已删 chip 的两条相邻注释(compose-branch 家族描述、compose-mcp "Visual sibling" 描述、手机端 affordances 枚举)改为不再指向已删元素。

## 测试

- **新增 `components/Composer.history.mount.test.tsx`**(单用例 mount 断言,防功能误伤):
  1. chip/badge 的 testid 与 class 在 **idle 与翻历中** 均不存在(徽标过去恰在翻历时弹出);
  2. ↑ 进入历史 → 最新一条,再 ↑ 到更旧,↓ 走回,翻过最新**恢复草稿**——完整走一遍 `navigateHistory` 状态机。
- **`i18n/locales.test.ts`** 追加「已删四键不复活」pin(沿用 #23726 addIcon* 先例,把 grep 归零固化为回归断言)。
- 实测坑(记入 §5.6 类经验):happy-dom + React 19 下,**keydown 只有在 textarea 持焦时才到达 React 委托 handler**——`ta.focus()` 缺失时 Enter/ArrowUp 全部静默丢失(此仓库既有测试都隐式经过 focus/点击路径才没踩到)。测试内显式 `ta.focus()`,与真实使用(聚焦时按 ↑↓)一致。

## 验证

- `bun test --isolate`:本任务三个文件(新 mount 测试 + Composer.mount + locales)43/43 全绿;全仓 584 pass / 4 fail + 1 error,**4+1 全部是 `App.worktree-guard.mount.test.tsx`(#199 delete-chain)的存量失败**——`git stash` 后在未改动基线跑同一文件复现同样 4 fail + 1 error(`@wailsio/runtime` 的 `"null/wails/runtime"` URL 解析问题),与本次改动无关。
- `bun run build`(tsc + vite)零错误(navDisplay 移除后 TS6133 消除)。
- `go build ./...` + `go vet ./...` 干净(本次无 Go 改动,例行过门)。
- **grep 归零**:`compose-history-chip` / `compose-history-badge` / `composer-history-chip` / `composer-history-badge` / `historyHint` / `historyBadge` 在生产代码零残留;仅存于新测试的「不存在」断言与 locales pin(预期)。`navDisplay` 仅存于 Composer.tsx 注释里的历史说明。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`(渲染块 + navDisplay 镜像 + 注释)
- `frontend/src/index.css`(chip/badge 规则 + media query 行 + 相邻注释)
- `frontend/src/i18n/locales/en.json` / `zh.json`(各删 4 键)
- `frontend/src/i18n/locales.test.ts`(不复活 pin)
- `frontend/src/components/Composer.history.mount.test.tsx`(新增)

## 下一步

- 交 fe-reviewer 复核;APPROVE 后即 completed-ready(不 push、不关 issue)。
- OPEN:存量失败 `App.worktree-guard.mount.test.tsx`(#199)与本次无关,但其 harness 的 wails runtime URL 问题值得单独开 task 修(独立于本任务)。
