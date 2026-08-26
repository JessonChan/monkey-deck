# 2026-08-26 修 review #24347 P2×2 + P3-1:注释转英文 + 退避基数对齐 DoD(Task #24348)

## 起因

Review #24347(见 `2026-08-26-review-24346-prompt-error-classifier.md`)对 #24346 判
REQUEST_CHANGES,两个 P2 + 顺手 P3-1,均为小改、不改行为(除退避常量):

- **P2-1(§3.7 硬约束)**:#24346 新增注释全中文,与同 PR 的 acp/prompt_error.go(英文)
  自身不一致。
- **P2-2**:`promptRetryBackoff = 2s` → 实际退避 2s/4s/8s(总 14s),超出 issue DoD
  「1s/2s/4s 量级,勿超」;最坏叠加(4×33s harness 内部重试链 + 14s)≈2.5min 静默。
- **P3-1**:`SendAndWaitSync` 文档注释仍写「任何失败都拆连接」,quota 分支落地后已不成立。

## 改法

1. **P2-1 注释转英文**(机械翻译,语义逐条保留,含 §4.4/§3.3 引用):
   - `internal/chat/chat.go`:StatusPayload 三字段(RootCause/ResetAt/Attempts)、
     两个新错误码常量(ErrCodeProviderQuotaExhausted/ErrCodeProviderTransient)、
     emitErrorDiag 文档、SendAndWaitSync 文档 + quota 分支行内注释、promptWithRetry
     文档、runPrompt switch 三分支(classify 前置/quota/transient/default,含 default
     内被本 PR 移动过的 §4.4/§3.3 两条——「触及即转」)。
   - `internal/chat/prompt_error_test.go`:文件头 + 全部用例/助手注释。
   - `internal/chat/queue_test.go`:errSeq 字段注释(review 清单未列,但同为 #24346
     新增中文注释,一并转)。
   - `frontend/src/types.ts`:StatusPayload 三字段行内注释。
   - acp 包本就英文,wire 原文引文(中文配额文本)是数据引用非注释,保留。
2. **P2-2 退避基数**:`NewChatService` 的 `promptRetryBackoff: 2s → 1s`,实际退避
   1s/2s/4s(总 7s),对齐 DoD;字段注释同步改「1s … 1+2+4=7s, per DoD」。
   判断:无需为 2s 辩护——DoD 明确「勿超」,2s 无额外收益(重试针对 429/5xx 抖动,
   1s 级退避足够让供应商侧限流窗口转过),直接改 1s。
3. **P3-1**:`SendAndWaitSync` 文档改为如实描述:失败处置与 runPrompt 一致——quota
   不拆连接(harness 活着,#46),其余拆连接、调用方重试经 ensureLive Resume 重连
   (§5.4 #16)。因触及顺手转英文(§3.7)。

## 改了哪些文件

- `internal/chat/chat.go`(注释 + 1 处常量 2s→1s)
- `internal/chat/prompt_error_test.go`(注释)
- `internal/chat/queue_test.go`(注释 1 行)
- `frontend/src/types.ts`(注释 3 行)
- `docs/worklog/2026-08-26-review-fix-24348-p2-comments-backoff.md`(本条)

## 验证

- `go build ./...` / `go vet ./...` 干净(linker 的 macOS 版本 warning 为本机环境噪音,
  非错误)。worktree 先补 gitignored 中间产物:`bun install` + `wails3 generate
  bindings`(注意须在仓库根跑,在 frontend/ 下会生成嵌套 `frontend/frontend/bindings`)
  + `bun run build` 产 dist 供 embed。
- `go test -short -count=1 ./...` 16 包全过。
- 新用例 `-race -run 'TestDiagnose.*|TestRunPromptQuota.*|TestRunPromptTransient.*|
  TestSendAndWaitSyncQuota.*' ./internal/acp ./internal/chat` 全过(注意:字面
  `TestRunPrompt*` 会连带 error_code_test.go 的 TestRunPromptDisconnect/BrokenPipe——
  review §4 已记录的预先存在 race 失败,本次 `git stash` 后在 HEAD 复跑确认同样失败,
  非本次引入、未动)。
- 前端:`bun run build`(tsc + vite)零错;`bun test --isolate` 362/362。
- 三端说明(§4.7):本次仅注释与一个后端重试常量,无 UI/布局/交互/事件改动;
  前端唯一改动 types.ts 为纯注释,desktop GUI/远程浏览器/PWA 三端渲染与行为不受影响
  (tsc+bun test 全过即证契约未变)。

## 下一步

- 请 reviewer 快审(review #24347 结论:P2 修完即可转 APPROVE)。
- P3-3(前端 ErrorCard 插值 rootCause/resetAt/attempts)仍在前端步骤 3 跟踪。
- P3-2/P3-4 为记录项,不阻塞。
