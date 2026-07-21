# 2026-07-22 Review #21318 harness 断连 i18n 回归测试补齐复验(PASS)

## 起因

Task #21318(二轮 Review):复验 Task #21312 是否补齐了 Review #21311 的阻塞项。

Review #21311 验收 commit `610ca7d`(harness 断连文案 i18n detail→code)时判 NEEDS CHANGES:
实现正确、端到端贯通已核实,但**违反 AGENTS.md §5.3 硬约束**——新增的 code 驱动分支
(后端 `emitError(code)` + 前端 `s.code ? t(...) : ...`)无任何回归测试钉住。现有
`TestEmptyTurnDetectedAsError` 只断言 `.Status == "error"`,不查 `.Code`;有人把 `emitError`
还原成 `emitStatus("error", "<中文硬编码>")` 所有测试仍全绿,要防的 i18n 回归完全没被钉住。

本复验的核心问题:**新增的测试是否真的把 code 驱动分支钉死了?**——不是「能编译 / 能跑过」,
而是「逐路径把 emitError 还原成中文 emitStatus,测试是否必红」(§5.3「先复现再修」的镜像:
修复钉住的 bug,测试必须在 bug 回归时变红)。

## 改动核对(commit `6b9bc94`,3 文件)

`internal/chat/queue_test.go`:
- `fakeChat` 增 `promptErr error` 字段(queue_test.go:35):非空则 `Prompt` 立即返回该错,
  不进入 block/cancel 分支。默认 nil,对既有测试零影响。✓ 注入点干净。
- `Prompt` 实现(queue_test.go:48-58):进锁读 `promptErr` → 发 `started` 信号(保留,
  `waitStarted` 照常可用)→ `err != nil` 立即返回。✓ 不破坏既有 block/cancel 语义。

`internal/chat/empty_turn_test.go`:
- emit 捕获从 `lastStatus string` 升级为 `lastPayload StatusPayload`(empty_turn_test.go:23-28)。
- 新增两断言(empty_turn_test.go:44-51):
  - `Code == ErrCodeHarnessEmptyTurn`(稳定翻译键,而非空)。
  - `Detail == ""`(不夹带任何硬编码/裸错文案)。
- 原 `Status == "error"` + teardown 断言保留。✓

`internal/chat/error_code_test.go`(新增,121 行):
- `waitErrorStatus` / `assertDisconnectedCode` 两个 helper(DRY,复用于 3 个用例)。
- `TestRunPromptDisconnectEmitsCode`:后台路径(`runPrompt`,SendMessage 驱动)Prompt 返回
  `"peer disconnected before response"` → `Code == ErrCodeHarnessDisconnected` + `Detail == ""` + teardown。
- `TestRunPromptBrokenPipeEmitsCode`:`"write |1: broken pipe"`(§5.4 #2 第二类断连信号,
  `IsPeerDisconnected` 同样命中)→ 同样 code 驱动。✓ 覆盖两类断连信号。
- `TestSendAndWaitSyncDisconnectEmitsCode`:同步路径(`SendAndWaitSync`,chat.go:1310)
  Prompt 失败 → 同样 `Code == ErrCodeHarnessDisconnected` + `Detail == ""` + teardown。

## 路径覆盖核对(逐 emit 点对照生产代码)

全仓 grep `emitStatus\(sessionID, "error"|emitError\(` 锁定所有 error-status 发射点:

| 生产代码 | 发射 | 覆盖测试 |
|---|---|---|
| chat.go:1310(SendAndWaitSync 断连) | `emitError(Disconnected)` | TestSendAndWaitSyncDisconnectEmitsCode ✓ |
| chat.go:1387(runPrompt 断连) | `emitError(Disconnected)` | TestRunPromptDisconnectEmitsCode + BrokenPipe ✓ |
| chat.go:1396(空 turn) | `emitError(EmptyTurn)` | TestEmptyTurnDetectedAsError ✓ |
| chat.go:1180(DB 保存失败) | `emitStatus("error", detail)` | 非断连族、带动态 `err.Error()`,**有意保留**(§4.4 调试信息),非本次范围 ✓ |

**3/3 断连族路径全覆盖**,无遗漏。

## 复现验证(核心:钉死回归窗口)

按 review 「先复现再修」要求,逐路径把 `emitError` 还原成中文 `emitStatus`,确认测试变红:

1. **chat.go:1396(空 turn)** `emitError(EmptyTurn)` → `emitStatus("error","agent 未产生响应…")`
   → `TestEmptyTurnDetectedAsError` 红:`Code="", want "harness_empty_turn"`。✓
2. **chat.go:1387(runPrompt 断连)** `emitError(Disconnected)` → `emitStatus("error","agent 连接已重置…")`
   → `TestRunPromptDisconnectEmitsCode` / `TestRunPromptBrokenPipeEmitsCode` 红:`Code=""`。✓
3. **chat.go:1310(SendAndWaitSync)** 同上还原 → `TestSendAndWaitSyncDisconnectEmitsCode` 红:`Code=""`。✓

三处还原后均恢复 `emitError`,`git diff --stat` 空、grep 确认生产代码回到 commit `6b9bc94` 状态。

**结论:测试确实钉死了 code 驱动分支**——任一 emitError 退回中文 emitStatus,对应测试必红。
这正是 Review #21311 要求的「能复现该 bug 的测试」。每个用例还有 `Detail == ""` 第二道独立
断言,双保险(退回中文时 Detail 非空,同样触发失败)。

## 验证

- `go test ./internal/chat/... ./internal/acp/...`:ok(chat 2.0s / acp 2.0s,仅 linker macOS
  版本告警,与本改动无关)。✓
- `go vet ./internal/chat/... ./internal/acp/...`:clean。✓
- 4 个目标测试单独 `-v` 跑全 PASS。✓
- 复现验证(见上)3/3 路径还原后变红,恢复后全绿。✓

## 规约合规

- §5.3「每个 bug 修复必须配一个能复现该 bug 的测试,先复现再修」:**满足**——复现验证确认
  测试在 bug 回归时必红。这是本复验的核心判据。
- §5.3「找不变量」:测试按稳定 code 常量(`ErrCodeHarnessEmptyTurn`/`ErrCodeHarnessDisconnected`)
  断言,不按 Detail 文本启发式匹配。✓
- §5.1「单测用 mock,不启真 harness」:全部走 `fakeChat` + `promptErr` 注入。✓
- §0.3 / §6.2:被验收方 worklog(`2026-07-22-harness-disconnect-i18n-regression-test.md`)
  已写,含逐路径复现记录;commit 原子(单 commit 3 文件纯测试 + 一个文档 commit 分离),
  message 说清改了什么 + 为什么。✓
- §6.2 不夹带:diff 仅含测试相关文件。✓

## 前端断言(review「建议项」)

Review #21311 标前端 `s.code ? t(...) : ...` 分支单测为「建议项」,明确「后端补齐即可放行」。
被验收方未补前端断言,worklog 说明理由(App.tsx:305 是事件回调内一行三元,挂载整个 App
成本高、需 mock 大量 Wails3 binding)。**后端断言已把「断连族必须走 code、不许回退中文
Detail」钉死**,前端分支只在 `s.code` 非空时翻译——后端不发 code 前端就无路可译,故后端
测试已足够锁住 i18n 回归。前端断言缺席不阻塞合入。✓

## 结论

**PASS**。Review #21311 的阻塞项(§5.3 回归测试缺口)已补齐:

- 3/3 断连族 emit 路径(SendAndWaitSync / runPrompt / 空 turn)各有测试覆盖。
- 复现验证确认:任一 emitError 退回中文 emitStatus,对应测试必红(钉死回归窗口)。
- Code + Detail 双断言,双保险。
- build / vet / test 全绿;测试基础设施改动(promptErr 注入)干净、不破坏既有用例。

可放行合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-harness-disconnect-i18n-regression-test.md`(本文件)。
