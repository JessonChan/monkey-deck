# 2026-07-23 后端:周期 ticker 跑 refreshHarnessesAsync + check_harness_updates 设置开关

## 起因
Task #22121。harness 发现/版本检测(2026-07-14 Task #15113)目前只在**启动时**异步刷新一次
(`ServiceStartup → go s.refreshHarnessesAsync()`)+ 用户**手动点刷新**。问题:应用长期驻留时,
上游发了新版本、用户新装了 harness,前端不会自动刷新「可升级」提示——除非用户主动进面板点刷新。
需要后台周期 ticker 持续刷新;同时给出设置开关让用户能关掉(省网络/电量,GitHub API 限额)。

## 设计
- **复用现有 refreshHarnessesAsync**(它已做:限时 5s 发现 + 写 harnessCache + 推 EventHarnesses),
  不另写刷新逻辑。ticker 每 N 周期调一次即可(KISS / Less is More,不重复造)。
- **开关持久化在 settings 表**,key = `check_harness_updates`(布尔字符串),默认**开启**
  (开箱即得更新提示)。复用现有 `store.GetSetting/SetSetting`(字符串),不新增表/迁移。
- **ticker 生命周期对齐既有后台 goroutine 模式**(health watcher / idle reaper):
  `startHarnessRefresh`/`stopHarnessRefresh`/`harnessRefreshLoop`,stop+done channel 优雅停,
  ServiceShutdown 等待落定防泄漏。启停幂等(防双起/双停)。
- **默认周期 1 小时**:GitHub API 免鉴权 60/小时/IP,每小时一次、每个有 Source 的 harness 一请求,
  远在限额内;桌面长期驻留,不过频(§4.6 资源/电量)。测试可注入短间隔(`harnessRefreshEvery`)加速。
- **实时启停**:`SetCheckHarnessUpdates(true/false)` 写设置后**立即** start/stop ticker,
  不等重启。`GetCheckHarnessUpdates` 读当前值(前端设置面板复选框),`GetConfig` 暴露该字段。

## 改法
- ChatService 加 3 字段:`harnessRefreshStop/Done chan struct{}`、`harnessRefreshEvery time.Duration`。
- `NewChatService` 默认 `harnessRefreshEvery: time.Hour`。
- `ServiceStartup`:初始异步刷新后,按 `checkHarnessUpdatesSetting()` 决定是否 `startHarnessRefresh()`。
- `ServiceShutdown`:`stopHarnessRefresh()`(在关 session 前)。
- 新增(均 export 给前端 binding):
  - `GetCheckHarnessUpdates() bool`、`SetCheckHarnessUpdates(on bool) error`
  - `checkHarnessUpdatesSetting()`(私有,读设置默认 true)、`settingBool(v, def)`(私有解析工具)
  - `startHarnessRefresh`/`stopHarnessRefresh`/`harnessRefreshLoop`(私有,启停 + 循环)
  - 常量 `settingKeyCheckHarnessUpdates = "check_harness_updates"`
- `GetConfig` 加 `"checkHarnessUpdates": strconv.FormatBool(...)`。
- `stopHarnessRefresh` 用 `s.mu` 保护 stop/done channel 的读写,nil 字段 + 等 done 落定;
  `harnessRefreshLoop` 用入参捕获的 `stop`(局部),消除「nil 字段并发读」竞态。

## 改了哪些文件
- `internal/chat/chat.go`(struct 字段 + ServiceStartup/Shutdown + 新方法 + GetConfig 字段)
- `internal/chat/harness_test.go`(新增 5 测:settingBool 解析 / 默认 true / 设置读写持久化 /
  ticker 周期触发 + 关停后停止 / start-stop 幂等;附 `setupHarnessStoreSvc`、`waitFor` 辅助)

## 验证
- `go build ./internal/...` / `go vet ./internal/...` 全绿。
- `gofmt -l` 干净(已 `-w` 对齐 struct 注释)。
- `make bindings`(wails3 generate bindings)成功:67 methods(含 GetCheckHarnessUpdates /
  SetCheckHarnessUpdates),bindings 入 frontend/bindings(gitignore,不入库)。
- `go test ./internal/chat/`(默认非 race)全绿;新测 `-race -v` 单跑全绿:
  settingBool×15 / 默认 true / 设置读写 / ticker 周期≥3 次 + 关停后不再触发 / start-stop 幂等。
- 已知(非本次引入):`TestEmptyTurnDetectedAsError` 等 3 个 `-race` 测在**干净树上也 FAIL**
  (pre-existing race),与本改动无关——`go test ./internal/chat/`(默认非 race)通过,与既有基线一致。

## 下一步
- 前端(下一任务):HarnessSettings 面板加「自动检查 harness 更新」复选框,绑定
  GetCheckHarnessUpdates/SetCheckHarnessUpdates + GetConfig.checkHarnessUpdates;文案进 i18n。
- 可选:周期改为可配(setting `check_harness_updates_interval`),当前固定 1h 够用(KISS)。
