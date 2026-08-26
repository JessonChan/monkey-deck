# 2026-08-26 #46 步骤2 后端:Prompt 错误根因提取 + 分类器 + N≤3 重试 + emitError payload(Task #24346)

## 起因

- #46(配额耗尽的识别与呈现)步骤 1 是探针(已完成,见
  `2026-08-26-quota-exhaustion-probe-46.md`);本条是**步骤 2:后端落地**。
- 探针实证的现状缺陷:runPrompt 对「非取消的 Prompt 错误」一刀切
  `teardownLive + emitError(ErrCodeHarnessDisconnected) + startReconnect`,
  对配额耗尽三步全错——误杀健康 harness(JSON-RPC error response 到达 = peer
  活着回答了)、无意义重连(重 spawn 恢复不了配额)、丢掉「何时重置」的关键信息。

## 改动

### 1. 分类器:`internal/acp/prompt_error.go`(新)

- `DiagnosePromptError(err) PromptErrorInfo`:纯函数,输出
  `{Class, RootCause, ResetAt, Retryable}`。
- 四类:`peer_disconnected`(既有 IsPeerDisconnected 两信号,优先级最高)>
  `quota_exhausted`(文本锚定:zh「已达到…使用上限…重置」+ en usage limit /
  quota exceeded 系)> `transient`(429/5xx/超时/连接抖动系,唯一 Retryable)>
  `fatal`(其余,保持既有处置)。
- **锚定按探针 §D**:判据是配额文本里的重置时刻(稳定锚),`data.errorName
  =="APIError"` 只作背景不当主判据(其它 API 错误同名);"rate limit" 归
  transient 不归 quota(短窗限流会自愈,配额要等数小时)。
- `RootCause` 提取:`*RequestError` 剥掉 "Internal error: " 前缀的 message
  (配额文本在此);SDK toReqErr 包装本地 OS 错误时(message 是泛化
  "Internal error")回落 `data.error`(broken pipe 文本在此);其余 err.Error() 原样。
- `ResetAt`:数字日期时间(zh+ISO)优先,英文 "resets at 9am/on Monday" 尾捕
  兜底;**原文透传不做时区换算**(供应商本地时间就是用户该看到的文本)。
- 测试 `prompt_error_test.go`:探针两条真实事件原文 + mock wire 形态 + broken
  pipe data 埋信号 + en 变体 + 边界(nil/fatal/不误判)。

### 2. chat 服务:`internal/chat/chat.go`

- `StatusPayload` 新增 `rootCause` / `resetAt` / `attempts`(omitempty,旧
  payload wire 兼容);新 `emitErrorDiag(sessionID, code, diag, attempts)` 与
  既有 `emitError` 并存(§4.4:根因是人话文本,不是协议 JSON)。
- 新错误码:`provider_quota_exhausted`(不拆连接族)、`provider_transient_error`
  (瞬态重试耗尽);`harness_disconnected` / `agent_turn_incomplete` /
  empty_turn / cancelled 各路径**原样未动**(探针 §D 回归边界)。
- `promptWithRetry`(runPrompt 内层):仅 transient 重试,上限
  `promptRetryLimit=3`(首次之外 N≤3),指数退避
  `promptRetryBackoff`(2s 起步翻倍,生产最大加等 2+4+8=14s,测试注入 1ms);
  退避等待感知 turnCtx(用户 Stop 立即中断走取消收尾);重试对前端不可见
  (维持 prompting,无中间 status,与 harness 内部重试同哲学);返回总尝试数
  attempts。
- runPrompt 失败收尾 switch:
  - **quota**:不 teardown、不重连、**不 drainQueue**(每条排队消息都会撞同一堵
    墙、各触发 harness 内部 ~33s 重试链);emitErrorDiag 带 ResetAt/RootCause。
  - **transient 耗尽**:teardown + startReconnect + drainQueue(与既有非配额
    失败一致),但错误码/根因/尝试数用真实诊断。
  - **default(peer 断 / 未知)**:原路径逐字保留。
- `SendAndWaitSync`(同步驱动路径):quota 同样不拆连接 + emitErrorDiag;
  其余原样。
- `fakeChat` 增 `errSeq`(按次消费的 Prompt 错误序列,供重试路径注入)。
- 服务级测试 `internal/chat/prompt_error_test.go` 5 例:quota 保连接+payload+
  队列不续发、瞬态重试后成功(前端不可见)、重试耗尽(attempts=4+teardown)、
  重试途中撞 quota 立即停、sync 路径 quota 不拆连接。复用
  `statusRecorder/captureStatuses`(reconnect_test.go)保持 -race 干净——注意
  既有 error_code/empty_turn 测试的裸 struct 捕获在 -race 下本就报(预先存在,
  未动)。
- 注:chat 包测试注入纯文本 error(分类是 err.Error() 全本锚定,与
  RequestError JSON 含同一文本等价),chat 不直接 import SDK(§2.1)。

### 3. 前端契约(类型镜像 + 兜底文案,人话呈现留给步骤 3)

- `frontend/src/types.ts`:`StatusPayload` 镜像 `rootCause?/resetAt?/attempts?`。
- locales zh/en:`chat.error.provider_quota_exhausted` /
  `provider_transient_error` 通用兜底文案(code 驱动路径先通,i18n 键已存在,
  不会显示裸 key);步骤 3 的专用 ErrorCard(插值 ResetAt/Attempts)另派。

## 验证

- `go build ./...` / `go vet ./...` 干净;`go test -count=1 ./...` 全绿
  (testcache 清空后全量);新增测试 `go test -race -run "TestRunPromptQuota|
  TestRunPromptTransient|TestSendAndWaitSyncQuota"` 通过(race 干净)。
- 前端:`npm run build`(tsc + vite)通过;`bun test --isolate` 362/362。
  (注:`npm test` 在本 worktree 有 35 例预先存在失败,stash 干净树复跑同样失败
  ——bun/npm 环境差异,与本改动无关;项目脚本本体是 bun test。)
- 回归确认:disconnect 族(error_code_test)、empty_turn、queue/reconnect
  全量既有用例未动且通过。
- 三端(§4.7):本条为纯后端 + 类型/文案契约;桌面 GUI / 远程浏览器 / PWA 共用
  同一 event payload(新增字段 omitempty,旧前端零影响),无需逐端冒烟——步骤 3
  改 ErrorCard 呈现时再按矩阵验。

## 下一步

- #46 步骤 3(前端呈现):ErrorCard 插值 ResetAt/RootCause/Attempts 的双语
  人话呈现(「配额已耗尽,将于 {resetAt} 重置」),三端验证。
- 观察 quotaPatterns 的误报/漏报面(真实事件目前只有 bigmodel zh 文本 +
  mock;en 变体是按常见措辞预置,遇到新形态再补锚点)。

## 踩坑

- 执行中 worktree 被外部重置一次(中断重试机制),全部改动丢失且无 stash;
  按上下文完整重建(内容逐字节复现,Go test cache 命中佐证)。后续同类中断
  宜先 `git add` 落暂存区防丢。
