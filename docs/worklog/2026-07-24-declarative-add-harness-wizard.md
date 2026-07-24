# 2026-07-24 声明即用 harness:数据层 + 合并层 + binding + 前端向导

## 起因

承接 `2026-07-24-probe-harness-acp-conformance-jcode-zero-code`(ProbeHarness 已证 jcode
零代码通过 conformance)。本条把"声明即用"做成端到端可用:用户输启动命令 → 自检 →
通过即落库可用,完全不动驱动层、零 per-harness 身份分支。严格门槛(要求 end_turn,
用户拍板)。

## 设计(分层,驱动层零改动)

- **数据层**(store):`user_harnesses` 表 + CRUD。store 只管 SQL;能加与否在 acp 层、
  id 冲突在 service 层。
- **harness 包**:加 `DiscoverWith(ctx, extra)`(用户行只 LookPath+--version,无 Source/
  Upgrader → 降级)+ `IsBuiltin(id)`。包仍 store-free。
- **合并层**(chat service):helper(userHarnessRows/harnessCommand/normalizeHarnessID/
  allHarnessCommands/reloadHarnessCommands)。4 个调用点改走合并:SetHarnessCommands、
  Normalize、Command(spawn)、Discover → DiscoverWith;ListHarnesses 静态兜底也并用户行。
  驱动层 runner/chat/handler 一行不改。
- **binding**:`ProbeNewHarness`/`AddUserHarness`/`RemoveUserHarness`(id 由命令首 token 派生,
  校验非内置/非重复,落库后重注入 reaper + 刷新缓存)。
- **前端**:HarnessSettings 加按钮 → AddHarnessWizard 内联表单(命令+可选名 → 自检 →
  体检单 Tier1 四项 + 能力矩阵 + messageId 行为 → CanAdd 才允许添加)。CanAdd 是 Go 方法
  不序列化,前端按 Tier1 字段自算。

## 改了哪些文件

- `internal/store/migrations/0012_user_harnesses.sql`(新)、`internal/store/user_harnesses.go`(+test)
- `internal/harness/discover.go`(DiscoverWith)、`internal/harness/harness.go`(IsBuiltin)
- `internal/chat/chat.go`(合并 helper + 4 调用点 + 3 binding 方法 + declarative_harness_test)
- `internal/acp/probe.go`(CanAdd 严格门槛,前序 commit)
- `frontend/src/components/AddHarnessWizard.tsx`(新)、`HarnessSettings.tsx`(按钮+挂载)
- `frontend/src/i18n/locales/{zh,en}.json`、`frontend/src/index.css`

## 验证

- `go test ./internal/...` 全绿。
- `TestDeclarativeAddUserHarness`:add→列表合并→命令解析→id 归一化→冲突拒绝→删除全路径(不 spawn)。
- `TestUserHarnessCRUD`:建/查/列/删 + 必填 + PK 冲突 + 幂等。
- integration:`go test -tags=integration -run TestProbeHarness ./internal/acp/` goose/omp/jcode
  全 PASS(严格门槛 turn==end_turn)。
- 前端 `bunx tsc --noEmit` 零错误。
- `wails3 generate bindings` 重生成(72 方法;bindings gitignored 不入库)。

## 结论 / 下一步

- **声明即用端到端打通**:任意 ACP harness 输命令、自检过(严格 end_turn)即落库可用,
  驱动层零 per-harness 代码。jcode 这条留出测试集现已可经向导加入,零硬编码。
- 待办(可选):向导加"删除用户 harness"按钮(RemoveUserHarness binding 已就绪,差前端入口 +
  Harness 区分用户/内置);用户 harness 图标上传;实机 `wails3 dev` 跑一遍 jcode 全流程冒烟。
