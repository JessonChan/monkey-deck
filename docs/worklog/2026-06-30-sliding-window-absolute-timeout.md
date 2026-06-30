# 2026-06-30 绝对超时改为滑动窗口(active长任务不再被误杀)

## 起因

session `ca5e8add`(omp 工程,右键菜单 clamp 多文件重构,151 条消息)在 22:47:03
整被 `chat absolute turn timeout elapsed=15m` 砍掉。`inProgress=0`——超时那一刻
没有卡住的 tool,agent 单纯因为没在 15min 内完成大任务就被杀。用户看到"干
到一半停了"。

## 根因

`internal/acp/runner.go` 的 `shouldCancelTurn` 把 `absolute` 实现为 **从 turn
起点 `start` 的固定倒计时**:

```go
if now.Sub(start) > absolute { return "absolute" }   // 到点必杀,不看是否还在产出
```

这条 absolute 当初(§5.4 #16)是为了治"in_progress tool 永久挂死 → 静默超时被
in_progress 豁免 → turn 永不取消"的兜底。但实现未区分"仍在产出"与"彻底没动静",
导致:
- **真·卡死**:静默超时(5min 无活动且无 in_progress tool)负责——专杀
  "无 chunk 且无 tool 在跑"。
- **真·长任务(active)**:每几分钟来一次 tool/message → lastActivity 持续刷新,
  但 fixed-15min 从起点算仍命中 → **误杀**。`ca5e8add` 正是这类。

## 改法

absolute 改为**以 `lastActivity` 为起点的滑动窗口**(语义与 idle 一致,去掉
in_progress 豁免):

```go
func shouldCancelTurn(start, now, silence, absolute) string {
    if a.timedOutAt(now, silence) { return "idle" }          // 先在无 in_progress 时杀真卡死
    if now.Sub(time.Unix(0, a.lastActivity.Load())) > absolute { return "absolute" } // 无活动兜底(无豁免)
    return ""
}
```

滑动窗口语义:
- turn 还在产出(tool/message 在流)→ `lastActivity` 持续刷新 → absolute 始终不
  命中 → 长任务跑完 `end_turn`。
- in_progress tool 中途死亡 → `lastActivity` 停在原地,彻底无活动超过 absolute
  → 兜底命中 → 取消 turn、拆死连接(§5.4 #16 仍成立)。

同步把 `maxTurnAbsolute` 从 15min 提到 **60min**(不再作为常规路径,只作为死
harness 的最终安全网,配合静默超时覆盖绝大多数真卡死场景)。

## 改了哪些文件

- `internal/acp/runner.go`:改 `maxTurnAbsolute`(15→60min)+ 注释,+ `shouldCancelTurn`
  滑窗实现 + 注释。
- `internal/acp/activity_test.go`:加
  `TestShouldCancelTurnSlidingAbsoluteDoesNotKillActiveLongTask`(治 ca5e8add 误
  杀回归)+ `TestShouldCancelTurnAbsoluteStillKillsInactiveDeadTool`(保 §5.4 #16
  in_progress 挂死兜底仍命中)。加 `fmt` import。

## 验证

- `go test ./internal/acp/` 全过,含新增两个回归测试(旧测试时序不变仍通过,
  因新逻辑更宽松——`lastActivity ≥ start`,原能触发的仍触发)。
- `go vet ./internal/acp/` 通过。
- `go test ./internal/...` 全过。

无需改 monkey-deck AGENTS.md(§5.4 是 RAK 引用列表、§3.3 只覆盖静默超时;absolute 滑窗是本项目
runner 内部实现,已在本条 §3 记录决策)。本次无阻塞 OPEN。
