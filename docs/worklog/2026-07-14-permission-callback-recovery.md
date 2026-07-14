# 2026-07-14 权限回调提示明确化 + 失败自动恢复

## 起因
Task #15115「修复 ACP terminal 回调(提示明确化 + 失败自动恢复)」。

**任务标题与正文的歧义处理**:标题写「terminal 回调」,但正文 4 条验收项 + 效率提示全部
指向「会弹用户提示、有 allow/deny 默认策略、有可选项」的回调 —— 即 `RequestPermission`:
1. 「提示明确化:回调用户提示补充上下文(哪个工具/动作/目标、需决策内容、可选项)」
2. 「超时降级(按默认策略放行或拒绝)」—— allow/deny 是权限裁决语义
3. 效率提示「在提示构造点补上下文」—— 提示构造点只存在于 `RequestPermission`
   (`internal/acp/handler.go` 的 `PermissionPrompt` 构造),ACP 的 `CreateTerminal`/`KillTerminal`
   等是真 stub(无用户提示、无 allow/deny、无可选项,§0 标注阶段 0 不支持)。

故按「详细验收项优先于标题关键词」解读,实现落在 `RequestPermission` 回调路径,不动 Terminal
stub 与其它回调。理由已在此记录(§6.1 文档先于代码 / 歧义尽力解释并注明)。

## 设计(聚焦 RequestPermission,三件事)
**1. 提示明确化** —— `PermissionPrompt` 除 title/toolName/options 外,补决策上下文:
- `actionType`(read/write/exec/other,由 ToolKind 派生,复用 `permissions.ActionOfKind`)
- `command`(exec 类从 RawInput 抽取,复用 `permissions.ExtractCommand`)
- `locations`(涉及路径)
- 不在后端拼最终文案(i18n 是前端的活,§4.4),只暴露结构化字段,前端用人话渲染。

**2. 失败自动恢复**(Task 三子项全覆盖):
- **可配置重试次数**:`permRetries`,用户未响应时按它额外重发提示(retries+1 轮),总预算
  `permTTL` 均分各轮;应对「提示丢失/用户没看到」。`SetPermissionRecovery(retries, policy)` 配置。
- **超时降级**:`permTimeoutPolicy`("allow" 默认 / "deny"),总预算耗尽按策略取 allow 选项放行
  或 reject 选项拒绝;harness 没给 reject 则 cancelled。零值(空串)视作 allow(直接 `&Handler{}`
  构造的集成测试默认放行,不致误拒)。
- **异常捕获不中断主流程**:`dispatchPrompt` 用 `recover()` 包裹 `OnPermission`,事件分发链路上
  的 panic 不冒泡到 ACP 调用方(否则连接被 teardown)。

**3. 日志** —— 关键节点记 slog:触发(dispatched,含 tool/action/command/locations)、
重试(no response, re-notify)、用户响应(responded)、取消(cancelled by context)、
超时降级(degrade to allow/deny/cancel)、分发异常(dispatch panic recovered)。

## 改了哪些文件
- `internal/acp/handler.go`:
  - `PermissionPrompt` 加 `ActionType`/`Command`/`Locations` 字段。
  - `Handler` 加 `permRetries`/`permTimeoutPolicy` 字段 + 常量(`defaultPermRetries=1`、
    `defaultPermTimeoutPolicy="allow"`、`permSubIntervalFloor`)+ `timeoutPolicyAllow` 归一函数。
  - `NewHandler` 初始化恢复默认;新增 `SetPermissionRecovery` setter。
  - `RequestPermission`:记忆/规则短路不变;弹窗分支改为「构造富上下文 prompt → 多轮重试等待
    (每轮 dispatch + select(response / ctx.Done / 子超时))→ 耗尽按策略降级」。
  - 抽出 `buildPermissionPrompt` / `dispatchPrompt`(带 recover)/ `removePending` 辅助。
- `internal/acp/handler_recovery_test.go`(新增):5 组测试锁定新行为 ——
  上下文字段、重试 3 轮、deny 降级、deny 无 reject→cancelled、dispatch panic 被 recover。
- `frontend/src/types.ts`:`PermissionPrompt` 加 `actionType`/`command`/`locations`。
- `frontend/src/components/ChatView.tsx`:`PermissionCard` 渲染动作徽标 + 命令/路径上下文块
  (readable,非裸 JSON,§4.4),带 `data-testid`。
- `frontend/src/i18n/locales/{en,zh}.json`:`permAction{Read,Write,Exec,Other}` /
  `permCommandLabel` / `permPathsLabel` 文案。
- `frontend/src/index.css`:`permission-sub` / `permission-action` / `permission-context` 等样式。

## 验证
- `go build ./...` / `go vet ./...` 全绿(仅 macOS 链接器 SDK 版本警告,与改动无关)。
- `go test ./...` 全绿:新增 handler_recovery 5 组 + 既有 perm/rules/memory 回归全过。
- `wails3 generate bindings` 重生成(本 worktree 缺 `frontend/bindings/`,非签名变更,仅为本地可编译)。
- `cd frontend && bun run build`(tsc + vite production)通过,无类型/编译错误(仅预存在 chunk>500kB 警告)。
- `frontend/dist/index.html` 临时 stub(go:embed 要求目录非空,被 .gitignore 排除不入库)。

## 下一步 / OPEN
- `SetPermissionRecovery` 当前是代码级可配(Handler setter + 默认值),未接 DB/设置 UI。
  若要用户可配,后续在权限设置面板加「重试次数 / 超时策略」两项 + store 表(本任务范围外,KISS)。
- 手动 wails3 dev 验证:执行命令类工具时权限卡显示「执行命令 + 命令文本」;长时间不点会
  重发提示(retry),最终按策略降级并记日志。
