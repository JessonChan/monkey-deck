# 2026-07-23 恢复 #22122 harness 红点 + 自动检查开关:rebase onto main 后调和重合入

## 起因

Task #22123。#22122「设置入口/harness 菜单红点 + 自动检查开关 UI」原本落在失败分支
`agent/coder/676bd9ec-failed`(2 个 commit:`c8bfdd4` feat / `3aedf80` docs),基点是
`37ff581`。期间 `main` 前进了 2 个 commit(#22121 后端「周期 ticker 跑
refreshHarnessesAsync + check_harness_updates 设置开关」的 feat `281cd41` + docs
`e8006ce`)。本任务把 #22122 的 2 个 commit **rebase 到最新 main**,重跑 gate,重新合并为
线性的 `main + 1`(feat/docs 合理成组)。

## 根因:文本无冲突,但有语义冲突(双机制)

- `c8bfdd4` 直接 cherry-pick **零文本冲突**:#22122 碰的全是前端文件(App.tsx /
  HarnessSettings.tsx / Sidebar.tsx / SettingsPanel.tsx / i18n / index.css / 新增
  `lib/harnessAutoCheck.ts`),与 #22121 碰的 Go 文件(`internal/chat/chat.go` /
  `harness_test.go`)完全不相交。
- **但语义冲突真实存在**:#22122 当时基线没有后端 ticker,所以它**自造了一套前端自动检查
  机制**——`lib/harnessAutoCheck.ts`(localStorage `md:harness-auto-check`)+ App.tsx 的
  6h `setInterval` 调 `RefreshHarnesses` + `settingsStore.harnessAutoCheck`。而 #22121
  上 main 后已经把同一件事做成**后端 ticker + SQLite `check_harness_updates` 设置**
  (`GetCheckHarnessUpdates`/`SetCheckHarnessUpdates`,ServiceStartup 起后台 goroutine,
  实时启停)。两者直接并存的破口:**前端开关只控制前端 6h 定时器,后端 ticker 仍照自己的
  SQLite 设置跑**——用户在 HarnessPane 关掉「自动检查」,后端 ticker 不受影响继续发请求;
  且同一个语义有两套持久化(localStorage + SQLite),互不同步。
- 这正是 #22122 原 worklog「下一步」预判的分支:「后端自带 harness 自动检查循环(读 SQLite
  setting)……替换前端 6h 定时器」。#22121 已落地那条路 → rebase 时按它收口。

## 改法:单一真相源(后端 ticker),删掉重复机制

**保留**:#22122 的「红点 UI」(纯前端派生,与后端无冲突,是 #22122 的核心新增价值)。
- `App.harnessUpdateAvailable = harnesses.some(upgradeAvailable)` → prop 传 Sidebar 齿轮
  + SettingsPanel models 导航项,亮 `.update-dot`。后端 ticker 每周期 `refreshHarnessesAsync`
  完成推 `chat:harnesses` 事件,App 已有订阅(App.tsx)据此重拉 `ListHarnesses` →
  `harnesses` 更新 → 红点自动刷新。**不需要前端定时器,红点照样实时。**

**调和**:HarnessPane 的「自动检查」开关直接绑后端。
- mount 时 `GetCheckHarnessUpdates()` 读当前值;toggle 调 `SetCheckHarnessUpdates(next)`
  (后端实时启停 ticker);失败回滚 UI。
- 不走 `useFrontendSettings`(那是前端 localStorage 轻量开关收敛层,§4 设计权衡),因为
  这是**后端 SQLite 持久化的设置**,直接经 ChatService 读写,与 harness 升级/权限规则一类。

**删除**前端重复机制(减少代码,功能不变 → §5.3 Less is More「删掉后功能不变的代码就该删」):
- `frontend/src/lib/harnessAutoCheck.ts`(整文件删)。
- `App.tsx`:6h `setInterval` effect + `HARNESS_CHECK_INTERVAL` + `isHarnessAutoCheckEnabled`
  import。
- `settingsStore.tsx`:`harnessAutoCheck` 字段 / setter / `harnessAutoCheck` import。
- `HarnessSettings.tsx`:`useFrontendSettings` import(改为直接绑后端)。

i18n 描述文案(`settings.harness.autoCheckDesc`)措辞本就通用(「运行时定期重新扫描并对照
上游发布源」),既适用于旧前端定时器也适用于现后端 ticker,无需改。

## 改了哪些文件

- `frontend/src/App.tsx`:删 6h 定时器 + 相关 import / 常量(保留 `harnessUpdateAvailable` 红点)。
- `frontend/src/components/HarnessSettings.tsx`:开关改绑后端
  `GetCheckHarnessUpdates`/`SetCheckHarnessUpdates`。
- `frontend/src/lib/harnessAutoCheck.ts`:删除。
- `frontend/src/lib/settingsStore.tsx`:删 `harnessAutoCheck` 字段。
- 本条 worklog。

(红点 UI 部分原样保留自 `c8bfdd4`:Sidebar.tsx / SettingsPanel.tsx / index.css /
i18n locales 的 `.has-update-dot` / `.update-dot` / `updateDotTip` / `openTipUpdate`。)

## 验证(gate 全绿)

- `wails3 generate bindings`(`make bindings`)成功:67 methods,含
  `GetCheckHarnessUpdates` / `SetCheckHarnessUpdates`。
- 前端:`bun install` + `bun run build`(tsc + vite production)通过(仅有既有的
  chunk-size > 500kB 警告,非错误)。bindings/dist 不入库(已 gitignore)。
- `go build ./...` ✅(仅 macOS linker 版本警告,非错误)。
- `go vet ./...` ✅(干净)。
- `go test ./...` ✅(全包绿:acp / chat / config / fsview / harness / permissions /
  store / terminal / titlegen / ui / update / worktree)。

## 下一步

- 实机验证(`wails3 dev`):任一 harness 有 `upgradeAvailable` 时齿轮 / models 导航亮红点;
  HarnessPane 开关关掉 → 后端 ticker 停(`SetCheckHarnessUpdates(false)` 实时启停)→ 重启
  app 后开关状态保持(SQLite 持久化)。
- 后端 ticker 默认周期 1h(#22121),响应性足够;若需更激进可加
  `check_harness_updates_interval` 设置(KISS,当前不做)。
