# 2026-08-02 empty-turn 不再过度反应 + elicitation 调研(A 修)

## 起因

用户报:在 monkey-deck 给 omp session 发 `/review`,报错「Agent produced no response.
Connection reset; auto-reconnecting...」。但 omp 连接本身是好的,不该报"重置/重连"。

## 协议调研:omp `/review` 在 ACP 下为何零输出(读 omp 原始源码 + 探针实测)

读 `can1357/oh-my-pi` 原始 TS 源码(`/tmp/omp-src`,浅克隆)+ 写 ACP JSON-RPC 探针
直接打 `omp acp`,定位完整因果链:

1. omp 自报 43 个命令,含 `review`(描述 "Launch **interactive** code review")——
   `available_commands_update` 上报给 client(探针实测确认)。
2. `ReviewCommand.execute`(`packages/coding-agent/src/extensibility/custom-commands/bundled/review/index.ts:481`)
   有两条分支:`!ctx.hasUI` → 返回 headless review prompt(发给模型);`hasUI` → 弹交互菜单
   (`ctx.ui.select` 选 review 模式)。omp 对 headless 是**有专门处理的**,不是无脑吐命令。
3. **但 ACP 模式 `hasUI()=true`**:ACP 给 extensionRunner 注入了 `acpExtensionUiContext`
   (`modes/acp/acp-agent.ts:2309/2409`),用于把 extension 的 select/confirm/input 桥接成
   ACP `elicitation/create`。这个 context 让 `ExtensionRunner.hasUI()` 返回 true → review
   走**交互菜单分支**(不是 headless)。
4. ACP `select` 实现(`acp-agent.ts:392`):`if (!supportsForm) return undefined` —— **client
   没在 Initialize 声明 `elicitation.form` 能力时,直接返回 undefined**。monkey-deck 的
   `Initialize`(`internal/acp/runner.go:241`)只声明了 `fs`,没声明 elicitation → `supportsForm=false`
   → `select` 返 undefined。
5. review `execute` 拿到 `selected=undefined` → `if(!selected) return undefined`(review/index.ts:522)。
6. `#tryExecuteCustomCommand`(`agent-session.ts:5357`)收 undefined → `return result ?? ""` → 返回 `""`。
7. `prompt()` 见 `customResult===""` → `return false`(agent-session.ts:4831)—— **不发模型,turn 结束**。
8. ACP handler 见 `prompt()` 返 false → `{stopReason:"end_turn"}`(探针实测一致:发 `/review` 后 2-3 秒
   返 `{"stopReason":"end_turn"}`,全程零 `session/update` 通知;对照发普通消息正常产出)。

**结论**:**omp 的 bug / 缺陷**——上报了命令、声明了 UI(hasUI=true),但 UI 实际不可用时(client 无
elicitation)没降级到 headless prompt,整体静默返回空。正解是 omp 在 `select` 返回 undefined 时降级
到 `buildHeadlessReviewPrompt`,而非整体 undefined。但这属上游,等不起。

## elicitation 是否标准协议

是。协议官网 v1 schema 已正式收录 `elicitation/create`、`elicitation/complete` 方法 +
`ClientCapabilities.elicitation` 能力声明位。我们用的 `acp-go-sdk@v0.13.5` 把它标 `UNSTABLE`
(注释 "not part of the spec yet")——SDK 是 elicitation 刚成型那版,协议未定稿。标 UNSTABLE
不代表不能用。omp 已在用(检查 `clientCapabilities?.elicitation?.form`)。故支持无心理负担(§5.3:
外部事实先验证 —— 已验证协议位真实存在、对端真在用)。

## 修法(A:本条只修 empty-turn 过度反应)

`internal/chat/chat.go:2065` 的 empty-turn 检测把「`end_turn` + 零输出」**一律**当「resume 后
session 状态损坏」处理 → `teardownLive` + `startReconnect` + 推 `harness_empty_turn`。这个过强
假设基于「空 turn = 损坏」,但 omp `/review` 这种「合法零输出 end_turn」被误伤:连接是好的却报
「重置/重连」,吓人且无意义。

**修法**:保留 emitError(用户该知道 agent 没回应,不静默),但**不 teardown、不重连**——end_turn
是协议合法返回,连接本身是好的,用户看到提示后可继续操作(发下条消息、换命令)。原来一刀切 teardown+重连
是过度反应。

## 改了哪些文件

- `internal/chat/chat.go`:`ErrCodeHarnessEmptyTurn` 注释改准 + empty-turn 分支删掉
  `teardownLive`/`startReconnect`(只留 `emitError`)。
- `internal/chat/empty_turn_test.go`:断言从「session 应被 teardown」改成「连接必须保留」+ 注释
  说明新理由(end_turn+零输出是协议合法结果)。
- `frontend/src/i18n/locales/{zh,en}.json`:`harness_empty_turn` 文案改准,不再说「连接重置/重连」。

## 验证

- `go build . ./internal/...` 通过。
- `go test ./internal/chat/ -run TestEmptyTurn` PASS(连接保留断言通过)。
- `go test ./internal/...` 全绿(15 个包全 ok)。
- `bun run tsc --noEmit` 0 error。

## 下一步 / OPEN

- **B(下一 commit):实现 elicitation 支持**——Initialize 声明 `elicitation.form` + 实现
  `RequestElicitation` 回调 + 前端 ElicitationDialog(select/confirm/input 弹窗)。让 omp `/review`
  这类交互命令真正可用,而非静默空。这是协议正道(桌面客户端有人在场,交互裁决正合适,类比 §3.4 权限裁决)。
- [OPEN] 给 omp 提 issue / PR:`select` 返回 undefined 时应降级到 headless,而非整体返回空。
