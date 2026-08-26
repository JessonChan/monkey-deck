# 2026-08-26 Review #24347 审 #24346:#46 步骤2 错误分类器+重试+payload —— REQUEST_CHANGES(P2×2 / P3×4,无 P1)

## 起因

Task #24347:审查 #24346(4 commits:`c61ce76` 分类器 / `5c64363` chat 处置 / `7aed54f`
前端契约 / `b650dc7` worklog+§5.4 #13 回写)是否满足 issue #24345 DoD。后端为主
(internal/acp + internal/chat),前端仅核契约(呈现细节归前端 reviewer / 步骤 3)。

方法:反向追踪——不顺着 commit 叙事走,从分类判据/新字段/新分支的定义点出发逐调用点
核实消费链;SDK 假设(`RequestError.Error()` 的 JSON 全文匹配、`toReqErr` 的
data.error 包装)对照本机 acp-go-sdk **v0.13.5 源码**逐行验证,不轻信注释;所有门
亲自重跑(worktree 自建:`bun install` + `wails3 generate bindings` 补 gitignored
中间产物,否则 embed/tsc 双双起不来)。

## 逐点核对(DoD 清单)

### 1. 分类器五族覆盖 + 探针真实文本 —— 过

- `TestDiagnoseQuotaExhaustedZh` 用探针 §B **wire 原文**(`-32603` + "Internal error: "
  前缀 + `data.errorName`),断言锚定值:Class=quota、`ResetAt=="2026-08-26 16:32:32"`
  (探针 §A 事件 1 时刻)、RootCause=剥壳后供应商原文、`Retryable==false`。
  `TestDiagnoseQuotaExhaustedVariants` 再钉事件 2(21:32:49)+ en 三变体
  (usage limit / quota exceeded / exceeded your current quota——OpenAI 措辞)。
- 429 限流("429 Too Many Requests"/"rate limit reached")、5xx("503")、网络
  ("timed out"/"fetch failed: ECONNREFUSED"/"socket hang up")、未知(nil +
  "something failed")、peer 断("peer disconnected" + **data 埋 broken pipe 的
  RequestError**,SDK toReqErr 形态)各自有独立用例。五族+peer 断全覆盖。
- 分类序 peer_disconnected > quota > transient > fatal 正确(IsPeerDisconnected
  优先,§3.3 语义不被文本误判稀释;"rate limit"归 transient 不归 quota,与探针 §D
  一致)。`errorName=="APIError"` 未作主判据 ✓(探针 §D 明示弱信号)。
- SDK 假设验证:RequestError.Error() marshal `{code,message,data}` 全文
  (errors.go:17-40)→ `matchAny(err.Error())` 对 message+data 都命中 ✓;
  `promptRootCause` 的 "Internal error"(无冒号)→ `data.error` 回落链与
  toReqErr(errors.go:71-81)构造逐行对得上,broken pipe 用例实证
  RootCause=="write |1: broken pipe"。

### 2. quota=零重试不拆连接 / transient=N≤3 退避 —— 行为过,参数偏离 DoD(→P2-2)

- quota:runPrompt switch(chat.go:2313-2322)不 teardown / 不 startReconnect /
  不 drainQueue;`promptWithRetry` 对非 transient 直接返回(attempts=1)。
  `TestRunPromptQuotaExhaustedKeepsConnection` 断言 `isActive` 保持、`count()==1`、
  **排队行原样保留**(`ListQueueItems` 仍 1 行,50ms 后无新 Prompt)——「不续发」
  有锚定断言,不是只看代码。
- transient:`attempts > promptRetryLimit` 计数核算过:1→2→3→4,第 4 次失败后
  4>3 返回,总尝试=1+3=4,测试 `count()==1+promptRetryLimit` 与 payload
  `Attempts==4` 双锚定;重试途中撞 quota 立即停(Attempts==2)有专门用例。
  退避 `select { turnCtx.Done / time.After }` 感知用户 Stop ✓;重试期间零中间
  status(对前端不可见)✓。
- **P2-2:退避基数偏离 DoD**。DoD:「1s/2s/4s 量级,勿超」;实现
  `promptRetryBackoff = 2 * time.Second` → 实际 2s/4s/8s(总加等 14s)。worklog
  如实记录但未给偏离理由。最坏叠加(每次重试的 Prompt 重新进入 harness 内部
  ~33s 重试链):4×33s + 14s ≈ 2.5min 静默 prompting,比 DoD 刻意压制的
  「不叠加过长」更糟一档。改回 1s 基数(1/2/4,总 7s)或补记用户拍板理由二选一。

### 3. payload 契约 + 前端兜底链 —— 后端全链路通;前端消费是步骤 3(→P3-3)

- `emitErrorDiag` 携 code+RootCause+ResetAt+Attempts;`omitempty` wire 兼容;
  types.ts 镜像字段名逐字一致(rootCause/resetAt/attempts);zh/en 两个新 code
  都有 key,`App.tsx:572` 的 `t(`chat.error.${s.code}`)` 路径不露裸 key;
  `agent_turn_incomplete` 及其 i18n 逐字未动(error_code_test 全量过)。
- 后端消费链完整(非类型补丁):payload 值有测试锚定(RootCause==供应商原文、
  ResetAt==探针时刻、Attempts==1/2/4)。**前端侧 rootCause/resetAt/attempts
  当前零消费**(grep 仅 types.ts 定义)——GUI 现在只显示通用配额文案、**不含
  重置时刻**,探针 §C-3「用户丢信息」只修了一半。 coder 明确派给步骤 3
  (ErrorCard 插值),commit message/worklog 均如实声明,非隐瞒;但**#46 关闭
  前提 = 步骤 3 必须落地**,此处记录为跟踪项(P3-3,转前端 reviewer)。
- 「code→i18n→rootCause 原文兜底」中的第三环(缺 key 时回落原文)同样未实现,
  与步骤 3 同批。

### 4. 门禁 —— 全绿(亲跑)

- `go build ./...` / `go vet ./...` 干净;`go test -short -count=1 ./...` 16 包全过。
- 新增用例 `-race` 干净(`TestDiagnose*|TestRunPromptQuota*|TestRunPromptTransient*|
  TestSendAndWaitSyncQuota`)。
- chat 包全量 `-race` 有 4 例失败(EmptyTurn×2 / DisconnectEmitsCode /
  BrokenPipeEmitsCode)——**在 `c61ce76~1`(改动前)同样失败**,预先存在、未动,
  worklog 声明属实。
- 前端 `tsc && vite build` 零 TS 错;`bun test --isolate` 362/362。

### 5. 状态机 / 边界(自查加项)

- busy 清理:quota/transient 分支都在收尾段 `ls.busy=false`(chat.go:2284)之后,
  错误态不残留 busy,下条 SendMessage 不被 stale busy 拒绝 ✓。
- default 分支(peer 断/未知)与改前**逐字节同语义**(diff 对照),§3.3 回归边界
  未稀释 ✓;cancelled 优先于分类(err!=nil && turnCtx.Err()!=nil 先走取消收尾)✓。
- SendAndWaitSync quota 分支不 teardown、attempts=1 ✓(有测试)。

## 发现汇总

| 级别 | 发现 | 位置 | 建议 |
|---|---|---|---|
| P2-1 | **§3.7 硬约束**:新增注释全中文——chat.go(StatusPayload 字段/emitErrorDiag/promptWithRetry/switch 分支)、internal/chat/prompt_error_test.go、types.ts。同 PR 里 acp/prompt_error.go 却是英文,自身不一致 | internal/chat/chat.go 等 | 触及即转英文,机械修复 |
| P2-2 | 退避 2s/4s/8s(14s)超出 DoD「1s/2s/4s 量级,勿超」 | chat.go:2246(`promptRetryBackoff=2s`) | 基数改 1s,或 worklog 补拍板理由 |
| P3-1 | `SendAndWaitSync` 文档注释仍写「任何失败都拆连接」,quota 分支后已不成立 | chat.go:2148 | 一句话改注释 |
| P3-2 | sync 路径非 quota 失败仍发泛化 `harness_disconnected`(无分类 payload、无重试),与 runPrompt 不对称;worklog 已声明「其余原样」属刻意收窄 | chat.go:2197-2204 | 记录即可,后续按需对齐 |
| P3-3 | 前端镜像字段零消费(GUI 不显重置时刻),#46 关闭前提=步骤 3 ErrorCard 落地 | frontend(步骤 3 范围) | 转前端 reviewer 跟踪 |
| P3-4 | 观察项:a) 定时队列 timer 触发时 idle-after-quota 仍会 drain 一次(每条计划消息撞一次墙,有界,语义可接受);b) 瞬态重试整 Prompt 重发,若首试是 SDK 层网络超时(harness 侧可能仍在跑)存在窄的双发窗口,用户可 Stop 打断 | queue.go:595 / chat.go:2222 | 知悉即可,不阻塞 |

## 结论

**REQUEST_CHANGES**(仅 P2×2:注释语言硬约束 + 退避参数超 DoD;均为小改,无功能性
缺陷)。分类器判据/优先级、quota 不拆连接三连(不 teardown/不重连/不续发)、N≤3
重试不变量、payload 锚定测试、SDK 假设验证、回归边界保留、门禁全绿——核心实现
质量高,与探针事实一致。P2 修完(约半小时机械改动)即可转 APPROVE。

## 验证

- 全部门禁命令与输出见 §4;SDK 源码对照见 §1;预先存在 race 失败的 parent-commit
  复跑证据见 §4。
- 本 review 未改任何产品代码;worktree 生成的 bindings/dist 为 gitignored 中间产物,
  `git status` clean。

## 下一步

- coder:修 P2-1(注释转英文)+ P2-2(退避基数对齐 DoD 或补理由)±P3-1 注释,
  复跑 `go test -short ./...` + `-race` 新用例后请求复审(快审)。
- 前端 reviewer:步骤 3(ErrorCard 插值 ResetAt/RootCause/Attempts + 兜底链)派发时
  接 P3-3 跟踪。
