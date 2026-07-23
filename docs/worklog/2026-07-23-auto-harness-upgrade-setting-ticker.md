# 2026-07-23 后端:auto_harness_upgrade 设置 + ticker hook 静默调 UpgradeHarness + 失败冷却 + 运行中进程安全(§5.3)

## 起因
Task #22385。已有周期 ticker + `check_harness_updates` 设置(Task #22121,只做「发现可升级 + 红点提示」,
**升级仍需用户手动点**)。本任务补「自动升级」:开关开启后,后台 ticker 发现 `UpgradeAvailable` 且
安全时**静默**调 `UpgradeHarness`(跑官方安装脚本),失败进冷却防反复重试。

## 设计
- **复用既有周期 ticker**,不另起 goroutine(KISS / Less is More)。`harnessRefreshLoop` 每个 tick 后追加
  `maybeAutoUpgrade()`。两个开关(`check_harness_updates` / `auto_harness_upgrade`)**共用同一 ticker**,
  OR 语义:任一开启即运行,都关才停(`syncHarnessRefreshTicker` 收敛启停,避免关 check 但 auto 仍开时误停)。
- **设置默认关闭**:静默跑官方安装脚本较重(网络/磁盘/可能重启服务),由用户在设置里显式开启。
  key = `auto_harness_upgrade`,复用 store.GetSetting/SetSetting,不新增表/迁移。
- **两条安全闸门(§5.3 外部事实是设计前提时先验证再动手)**:
  1. **运行中进程安全**:`liveSession` 新增 `harnessID` 字段(startLive 从 `se.Harness` 记录)。
     `maybeAutoUpgrade` 先扫 `s.active`,任一活跃 session 正用该 harness 即跳过(等下个 tick 再试,
     那时通常已 idle)。理由:升级运行中 harness 可能与进程冲突(Win 无法覆写运行中 .exe;
     Unix 虽换 inode 但官方脚本可能重启服务/动用户数据)。
  2. **失败冷却**:`autoUpgradeCooldown[id] = now + cooldownDur`(生产默认 1h)。
     升级失败置冷却,冷却期内不再反复重试同一失败升级(防每个 tick 反复跑同一失败安装脚本,
     打满日志/网络)。成功清冷却。
- **纯静默**:不向用户弹错误(后台行为);失败仅 `slog.Warn` + 冷却。成功会经 `UpgradeHarness`
  重发现 + 刷缓存 + 推事件,前端自然看到新版本号(红点消失)。
- **串行升级**:不并行跑多个安装脚本,避免互相打架/抢网络。

## 改法
- `liveSession` 加 `harnessID string`;`startLive` 落 `se.Harness`。
- ChatService 加字段:`autoUpgradeCooldown map[string]time.Time`(受 `s.mu` 保护)、
  `autoUpgradeCooldownDur time.Duration`;`NewChatService` 初始化(默认 1h)。
- 常量 `settingKeyAutoHarnessUpgrade = "auto_harness_upgrade"`。
- 新方法(export 给前端 binding):
  - `GetAutoHarnessUpgrade() bool` / `SetAutoHarnessUpgrade(on bool) error`(写设置后 `syncHarnessRefreshTicker`)
  - `autoHarnessUpgradeSetting() bool`(默认 false)、`refreshTickerNeeded() bool`(check OR auto)
  - `syncHarnessRefreshTicker()`(OR 启停,setter 共用,防互踩)
  - `maybeAutoUpgrade()`(读缓存 → 过滤 UpgradeAvailable + 非 in-use + 非冷却 → 串行 autoUpgradeOne)
  - `autoUpgradeOne(id)`(复用 UpgradeHarness;失败置冷却,成功清冷却)
- `ServiceStartup`:把原来的 `if checkHarnessUpdatesSetting() { startHarnessRefresh() }`
  改成 `syncHarnessRefreshTicker()`(统一 OR 启停)。
- `SetCheckHarnessUpdates` 改用 `syncHarnessRefreshTicker()`(关 check 但 auto 开时不停 ticker)。
- `harnessRefreshLoop` 的 `<-ticker.C` 分支追加 `s.maybeAutoUpgrade()`。
- `GetConfig` 加 `"autoHarnessUpgrade"` 字段。

## 改了哪些文件
- `internal/chat/chat.go`(liveSession 字段 + startLive 记 harnessID + 新方法 + GetConfig 字段 +
  ServiceStartup/refreshLoop/SetCheck 改 OR 语义)。
- `internal/chat/auto_upgrade_test.go`(新增 11 测)。

## 验证
- `go build ./internal/...` / `go vet ./internal/...`:干净。
- `gofmt -l internal/chat/*.go`:干净(既有的 idle_reaper/queue/scm_test 有 fmt 残留,非本次引入,不动)。
- `make bindings`(wails3 generate bindings):69 methods(+2:GetAutoHarnessUpgrade / SetAutoHarnessUpgrade),
  bindings 入 frontend/bindings(gitignore,不入库)。
- `go test ./internal/...`:全包绿(含 chat)。
- 新增 11 测单跑 `-v` 全绿:
  - 设置缺省(默认 false)+ 持久化往返(true↔false)+ GetConfig 暴露。
  - `maybeAutoUpgrade` 关闭时不触发;开启 + UpgradeAvailable + 无运行中进程 → 触发 + 成功清冷却。
  - §5.3 运行中进程安全:活跃 session 用该 harness → 跳过(且不记冷却);另一 harness 不受影响仍可升级。
  - 失败冷却:首次失败置冷却 → 冷却期内重置缓存后仍不重试(强断言跳过归因冷却非缓存)→
    手动把冷却置到过去 → 重试;成功清既有冷却。
  - UpgradeAvailable=false 不被尝试。
  - ticker OR 语义:check 关 + auto 开 → ticker 仍跑(emit 增长);二者皆关 → 停(emit 不再增长)。
  - 端到端:周期 ticker → Probe 报旧版/Source 报新版 → Discover 置 UpgradeAvailable → maybeAutoUpgrade 调 Upgrader。
- 新测 `-race` 单跑全绿(无新引入竞态)。

## 下一步
- 前端(下一任务):HarnessSettings 面板加「自动升级 harness」复选框,绑定 GetAutoHarnessUpgrade /
  SetAutoHarnessUpgrade + GetConfig.autoHarnessUpgrade;文案进 i18n。**需向用户说明这是静默跑官方安装脚本**
  (默认关闭的原因)。
- 可选:把 §5.4 的「自动升级跳过运行中 harness」补进已知坑索引(目前原则已在 §5.3,行为已落地)。
