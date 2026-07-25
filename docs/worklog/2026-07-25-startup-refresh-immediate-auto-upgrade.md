# 2026-07-25 启动路径:refreshHarnessesAsync 完成后若 auto on 立即 maybeAutoUpgrade(不等首个 tick)

## 起因

Task #23059。自动升级(#22385)只在周期 ticker 的每个 tick 末尾跑 `maybeAutoUpgrade`。
默认周期 `harnessRefreshEvery = 1h`,所以**用户开了 auto 后,启动后最长要等 1 小时才发生首次自动升级**。
而启动时本来就会跑一次 `refreshHarnessesAsync`(发现本机 harness + 查上游最新版本),此刻缓存已就绪、
`UpgradeAvailable` 已置位——若 auto 开启,理应**紧接着就升级**,而不是干等首 tick。

## 改法

把启动路径从「只 refresh」升级为「refresh 完若 auto 开则立即 maybeAutoUpgrade」:

- 新增 `refreshHarnessesThenMaybeAutoUpgrade`(`internal/chat/chat.go`):顺序跑 `refreshHarnessesAsync`,
  随后 `if s.autoHarnessUpgradeSetting() { s.maybeAutoUpgrade() }`。复用与 ticker 完全一致的
  「refresh → maybeAutoUpgrade」序列,只是把首跑从「等首 tick(默认 1h)」提前到「启动 refresh 完即可」。
- `ServiceStartup` 里 `go s.refreshHarnessesAsync()` 改为 `go s.refreshHarnessesThenMaybeAutoUpgrade()`
  (仍异步,不阻塞启动;auto 关时与原来等价,maybeAutoUpgrade 内部也会 auto 早返,双保险)。

不引入新通道、不改 ticker 逻辑、不改 maybeAutoUpgrade 本身。运行中进程安全 / 失败冷却等闸门
全部沿用(同一函数),无新风险面。

## 改了哪些文件

- `internal/chat/chat.go`:新增 `refreshHarnessesThenMaybeAutoUpgrade`;`ServiceStartup` 调用它。
- `internal/chat/auto_upgrade_test.go`:新增两个单测 + 文件头覆盖说明。
- `docs/worklog/2026-07-25-startup-refresh-immediate-auto-upgrade.md`:本条。

## 验证

- `go build ./...` / `go vet ./...`:干净(仅既有 `all:frontend/dist` worktree embed 提示,非本次引入)。
- `go test ./internal/chat/ -run 'AutoHarness|MaybeAutoUpgrade|RefreshTicker|AutoUpgradeTicker|StartupRefresh' -v -count=1`:**14 测全绿**
  (含新增 `TestStartupRefresh_TriggersAutoUpgradeImmediately` / `TestStartupRefresh_NoAutoUpgradeWhenDisabled`)。
- `go test ./internal/chat/ -count=1`:全绿。
- 新测的关键断言:`disableTicker(svc)`(`harnessRefreshEvery=0`,startHarnessRefresh 直接返回)下,
  同步调 `refreshHarnessesThenMaybeAutoUpgrade()` → `up.called=true`。证明升级**只来自启动路径自身的同步调用,
  不靠后台首 tick**(否则禁 ticker 就不会触发)。auto 关的同条件测断言 `up.called=false`(只 refresh 不升级)。
- `-race` 全量跑有 3 个**预先存在**的失败(`TestEmptyTurnDetectedAsError` /
  `TestRunPromptDisconnectEmitsCode` / `TestRunPromptBrokenPipeEmitsCode`,run-prompt/disconnect/reconnect 代码,
  本次未触碰):`git stash` 后裸 tree 同样失败,确认与本次无关。

## 下一步

- 可选:实机 `wails3 dev` 抽验——auto 开 + 本机装旧版 harness,启动后短时间内(无需等 1h)即静默升级。
  单测已覆盖逻辑,此为视觉/时序确认。
