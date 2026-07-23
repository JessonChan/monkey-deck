# 2026-07-23 Review #22383 自动升级端到端验收:后端 setting+ticker+冷却+进程安全 + 前端子开关UI+联动+tooltip+i18n(PASS)

## 起因

Review #22943(被审两实现):
- **#22385 后端** `3527516` `feat(chat): auto_harness_upgrade 设置 + ticker hook 静默 UpgradeHarness + 失败冷却 + 运行中进程安全`(+ worklog `814de34`)。
- **#22941 前端** `d9f3304` `feat(ui): harness 自动升级子开关 UI(挂 check 下 + 风险 tooltip + GetConfig 接线)`(+ worklog `d071c98`)。

Reviewer 职责:不只「编过 + 测过」,要证明**行为真的实现了**,防「改签名/加字段但函数体不变、
build 绿但行为没生效」的常见失败模式。验收四件事:
1. **设置 + ticker hook**:auto_harness_upgrade 开启后,周期 ticker 每个 tick 真会触发 `maybeAutoUpgrade`。
2. **两条安全闸门**:运行中进程安全(跳过 in-use harness)+ 失败冷却(失败 1h 不重试,成功清)。
3. **OR 语义**:check/auto 共用同一 ticker,任一开即跑、都关才停(关 check 但 auto 开不能误停)。
4. **前端子开关**:绑后端 setter(实时启停)+ GetConfig 接线(两开关初值)+ 风险 tooltip + i18n。

## 验证做了什么

### 1. 环境对齐(全绿)
- worktree 初始 `node_modules` 空 + bindings 未生成 → `bun install` + `wails3 generate bindings`
  (**69 methods**,含新 `GetAutoHarnessUpgrade` / `SetAutoHarnessUpgrade`;防「Go 加了方法但前端用旧 binding」)。
- `go build ./...` / `go vet ./...`:干净(仅 `main.go:22` `all:frontend/dist` embed——worktree 未跑前端 build 的既有现象,非本次引入)。
- `go test ./internal/chat/ -run 'AutoHarness|MaybeAutoUpgrade|RefreshTicker|AutoUpgradeTicker' -v`:**12 测全绿**
  (11 新增 + 既有 `TestHarnessRefreshTicker_RunsPeriodically`)。
- `-race` 单跑同集合:全绿,无新引入竞态。
- `bun run build`(tsc + vite production):通过(仅既有 chunk>500kB 旧 warning)。
- `bun test`:**113 pass / 0 fail**(原 97 + 本次净增 16)。

### 2. 后端行为真改变了(读 diff + 读源码,非盲信 worklog)
- **ticker hook 真接入**:`harnessRefreshLoop` 的 `<-ticker.C` 分支在 `refreshHarnessesAsync()` 后追加 `s.maybeAutoUpgrade()`(`chat.go:2237`)。
  关键:`refreshHarnessesAsync` 名字虽 Async 但**实为同步**(`chat.go:2077-2083` 顺序跑 Discover + Store + emit),
  故 maybeAutoUpgrade 读到的是本次 tick 刷新后的缓存(不是上一 tick 的陈旧值)。✓
- **运行中进程安全(§5.3)真落地**:`liveSession` 加 `harnessID string`,`startLive`(`chat.go:1055`)落
  `harnessID: se.Harness`(**生产路径,非仅测试**)。`maybeAutoUpgrade` 先持 `s.mu` 扫 `s.active` 建 `inUse[harnessID]`,
  候选筛选 `if inUse[h.ID] { continue }`(`chat.go:2273`)——真跳过正被活跃 session 使用的 harness。✓
- **失败冷却真生效**:`autoUpgradeOne` 失败 → `autoUpgradeCooldown[id] = now+dur`(`chat.go:2295`,持锁),
  成功 → `delete`(`chat.go:2299`)。候选筛选 `if until := s.autoUpgradeCooldown[h.ID]; until.After(now) { continue }`
  (`chat.go:2276`)。**UpgradeHarness 在锁外调用**——不持 `s.mu` 跑安装脚本(网络/磁盘),锁仅覆盖簿记。✓
- **OR 语义真收敛**:`refreshTickerNeeded() = check || auto`(`chat.go:2127`),`syncHarnessRefreshTicker` 起/停统一,
  `SetCheckHarnessUpdates` / `SetAutoHarnessUpgrade` / `ServiceStartup` 三处都走它——**修掉了原来 `SetCheckHarnessUpdates`
  自己 start/stop 的旧逻辑**(`chat.go:2160` 旧 if/else 已删,改调 sync)。关 check 但 auto 开时 ticker 不误停。✓
- **默认值一致**:auto 默认 false(`autoHarnessUpgradeSetting` def=false,`NewChatService` cooldown=1h);
  check 默认 true。前端兜底同。✓
- **GetConfig 暴露**:`"autoHarnessUpgrade": strconv.FormatBool(...)`(`chat.go:2351`)——前端 GetConfig 接线的后端前提。✓

### 3. 后端单测有效性(防「测了但没测行为」)
`internal/chat/auto_upgrade_test.go` 11 测逐条核对,**无空断言**:
- `TestMaybeAutoUpgrade_SkipsRunningHarness`:**核心**——直接注入 `svc.active["s1"] = &liveSession{harnessID:"opencode"}`,
  断言 `up.called=false` **且** 无冷却残留(区分「跳过」与「失败冷却」)。✓
- `TestMaybeAutoUpgrade_DifferentHarnessInUse`:omp 在用 → opencode 仍可升级(证明只跳「正被使用的那一个」,不误伤其他)。✓
- `TestMaybeAutoUpgrade_FailureCooldown`:三段式——失败置冷却 → **第二次前重置缓存恢复 UpgradeAvailable**
  (强断言「跳过」只能归因冷却而非缓存里 UpgradeAvailable=false,§5.3 找不变量)→ 手动把冷却置过去 → 重试。✓
- `TestRefreshTicker_OrLogic`:check 关 + auto 开 → emit 持续增长;二者皆关 → emit 停(真验 OR 语义)。✓
- `TestAutoUpgradeTicker_EndToEnd`:周期 ticker(20ms)→ Probe 报 1.0.0/Source 报 2.0.0 → Discover 置
  UpgradeAvailable → `waitFor` upgrader 被调。**ticker hook 端到端真生效**,不只是单测 maybeAutoUpgrade。✓

### 4. 前端行为真接上了后端
- **GetConfig 接线**(`HarnessSettings.tsx`):mount 由 `GetCheckHarnessUpdates` 改为 `GetConfig` 一次取回两字段;
  解析 `cfg.checkHarnessUpdates !== "false"`(默认 true)/ `cfg.autoHarnessUpgrade === "true"`(默认 false),
  **兜底与后端默认一致**。写仍走各自 setter(单一真相源 = 后端 SQLite,§5.3)。✓
- **子开关绑定**:`toggleAutoUpgrade` 乐观翻转 → `await SetAutoHarnessUpgrade(next)` → catch 回滚 `setAutoUpgrade(!next)`
  + setError(与 toggleAutoCheck 一致;顺手修了 review #43 指出的 toggleAutoCheck 注释 stale)。✓
- **风险提示(§4.4/§4.5)**:整行 `data-tooltip-id="md-tip"` + `data-tooltip-content=autoUpgradeRiskTip`
  (react-tooltip,非原生 title)+ `AlertTriangle`(amber `#ff9f0a`)。i18n en/zh 三键齐全(Title/Desc/RiskTip),
  RiskTip 文案明确「无人值守跑官方安装脚本(联网/写磁盘/可能重启服务)」。✓
- **样式**:`.settings-row.is-sub`(缩进 + accent 左边线区分层级)。✓
- **mount 测有效性**:mock 由 `GetCheckHarnessUpdates` 改为 `GetConfig`(返两字段)+ 新增 `SetAutoHarnessUpgrade` mock;
  断言 mount 调 GetConfig、两开关 aria-checked 反映字段、点子开关真调 `SetAutoHarnessUpgrade(arg=true)`(防「渲染了但不接后端」)、
  setter 抛错 UI 回滚、风险行带 tooltip。✓

## 结论

**PASS**。四件事行为全部真落地,无「改签名但函数体不变」的空壳;后端两条安全闸门 + OR 语义 + ticker hook
均有真验行为的单测(含端到端 + race);前端子开关真接后端 setter + GetConfig + 风险 tooltip + i18n 齐全;
gate 全绿(go build/vet/test + bun build/test)。无 reject 项。

## 下一步(非阻塞,可选)
- 实机 `wails3 dev` 抽验:HarnessSettings 面板「自动检查」下方出现「自动升级」子开关(缩进 + 警告图标);
  hover 弹风险 tooltip;开关状态重启后保持(SQLite)。单测已覆盖逻辑,此为视觉确认。
- §5.4 可补一条「自动升级跳过运行中 harness」已知坑索引(原则已在 §5.3,行为已落地,优先级低)。
