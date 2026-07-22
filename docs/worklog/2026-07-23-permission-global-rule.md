# 2026-07-23 后端 onRespond("global") 把权限请求转全局 PermissionRule(准确匹配)

## 起因
Task #22126。权限裁决前端已有 once/session/project/deny 四档,缺「全局允许」档:
用户想「这个命令/路径以后永远自动放行、跨所有 session/project」,但目前只能逐会话/逐项目记
(session/project 仅内存记忆、随 session 生灭;要全局必须手动去设置面板建规则)。
需在后端把 `onRespond("global")` 转成一条 `level=allow`、对当前请求「准确匹配」的全局
PermissionRule,持久化进 DB 并刷新全部活跃 session,后续同标识请求被规则引擎自动放行。

> 本任务只做**后端 + 单测**;前端 PermissionCard 的「全局允许」按钮是另起任务。

## 设计
「准确匹配」= 把当前请求的标识固化成复现匹配所需的全部非空约束(引擎 AND 语义):

- **ToolName = ToolKind**(精确工具,主判别项;不同 kind 不会误命中)。
- **ActionType = ActionOfKind(ToolKind)**(与 kind 一致,供分组/展示)。
- 有命令(exec 类):**CommandPattern = `^` + regexp.QuoteMeta(cmd) + `$`**——锚定 + 转义
  元字符,严格全等(命令前缀/后缀/不同工具都不命中)。
- 无命令有路径(fs 类):**PathPattern = 首个 location 原值**(引擎 matchPaths 按「任一 location
  命中」算命中,当前请求必含该路径故自身可复现;多路径请求的完整集合无法用单条 glob 表达,
  取首个为最佳近似,见 §5.3「找不变量」:用已有「任一 location 命中」语义而非自造集合匹配)。
- 无命令无路径:仅按工具+动作匹配(可表达的最窄「同工具」语义)。

**分层**(沿用既有权限三层,反向依赖方向不变):
- 纯逻辑层 `permissions.ExactMatchRule(MatchRequest) Rule`——零 DB/零 ACP 依赖,单测直验形状。
- ACP hook:handler 加 `OnGlobalRule func(permissions.Rule)` 回调;`applyDecision` 给 "global" 档
  写满 session/project 内存记忆(本 session 即时放行,降级安全);`RequestPermission` 收到
  "global" 响应后、返回 ACP 响应前调 `emitGlobalRule`——在返回前完成持久化 + 刷新快照,使本轮
  内紧随的同标识请求也命中规则。
- Service:`startLive` 注册 `OnGlobalRule = s.persistGlobalPermissionRule`;后者把 Rule 转成
  `store.PermissionRule` 走既有 `CreatePermissionRule`(校验 + 入库 + `applyPermissionRulesToAll`
  刷新全部活跃 session)。handler 已另写内存记忆,故持久化失败也只降级到「本 session 放行」。

**层级与「项目」档对称**:"project" 在 service.RespondPermission 里写 DB(SetProjectAllowExternal)
后转发;"global" 因需请求细节(只在 handler 的 req 里有),改由 handler 经回调把规则交给 service
持久化——保持 ACP 请求形状留在 acp 层、DB 留在 service 层(干净依赖方向)。

## 改了哪些文件
- 改 `internal/permissions/permissions.go`:新增 `ExactMatchRule`(纯逻辑)。
- 改 `internal/permissions/permissions_test.go`:`TestExactMatchRuleShape`(6 例形状,含元字符
  转义/argv 拼接/多路径取首/无约束)+ `TestExactMatchRuleReproducesRequest`(exec/fs 准确匹配
  复现:同标识放行、不同标识/不同工具不命中)。
- 改 `internal/acp/handler.go`:`OnGlobalRule` 字段 + `applyDecision` 加 "global" 档(写记忆)+
  `emitGlobalRule` 助手 + `RequestPermission` 响应分支调 emit。
- 新增 `internal/acp/handler_global_test.go`:`onRespond("global")` 三组:exec 命令固化(放行 +
  OnGlobalRule 规则形状 + 记忆使后续不弹窗)、fs 路径固化(带 PathPattern)、OnGlobalRule=nil
  仍放行(降级安全)。测试用 channel 传 prompt id、收尾读回调结果,避免与 RequestPermission
  goroutine 的数据竞争(`-race` 干净)。
- 改 `internal/chat/chat.go`:`startLive` 注册 `OnGlobalRule` + 新增 `persistGlobalPermissionRule`。

## 验证
- `go build ./internal/...` / `go vet ./internal/...` 全绿。
  (`go build ./...` 的 `frontend/dist` embed 报错是预存在——前端未构建,与改动无关,已 stash 核实。)
- `go test ./internal/permissions/ ./internal/acp/ -race -count=1` 全绿。
- `internal/chat` 有 3 个预存在失败(`TestEmptyTurnDetectedAsError` /
  `TestRunPromptDisconnectEmitsCode` / `TestRunPromptBrokenPipeEmitsCode`,prompt 断连错误码相关)
  ——已 stash 核实与本次改动无关;本次未碰这些路径。

## 下一步
- 前端任务:PermissionCard 加「全局允许」按钮(`onRespond("global")`)+ i18n 文案。
- (可选)重复同标识请求多次点「全局允许」会产生重复规则;如需可在
  `persistGlobalPermissionRule` 加按 (tool/action/cmd/path) 去重(当前 KISS 不做)。
