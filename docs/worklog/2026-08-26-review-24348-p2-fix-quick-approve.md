# 2026-08-26 Review #24349 快审 #24348:P2 修复确认 —— APPROVE(关闭 #24347 审查环)

## 起因

Task #24349:快审 #24348(2 commits:`6fd243c` 代码修复 + `e57532c` worklog)是否闭合
review #24347 的两个 P2(+顺手 P3-1)。按 #24347 结论「P2 修完即可转 APPROVE」,
本次为机械核验 + 门禁亲跑,不做新一轮全量审查。

## 逐点核对

### P2-1(§3.7 注释转英文)—— 过

- **穷举核验,非抽样**:提取 #24346 三个代码 commit(`c61ce76`/`5c64363`/`7aed54f`)
  新增的全部含中文注释行(去重后 87 条:chat.go 83 + types.ts 3 + acp 1),逐条与
  HEAD(`6fd243c`)比对——**86 条已转英文,零残留**;唯一剩余的中文行在
  `internal/acp/prompt_error.go`,是探针 §B **wire 原文引文**(配额错误的 JSON-RPC
  message 原文,分类器文本锚定的事实基础、测试 fixture),属数据引用非描述性注释,
  保留正确(翻译即破坏锚定)——与修复 worklog 声明一致,#24347 本就认定 acp 包英文。
- `queue_test.go` errSeq 字段注释(#24346 新增、review 清单未列)一并转了,超出
  要求范围,好。
- types.ts 的 `code?` 行中文注释为 #24346 之前已有、本次 diff 未触及,无「触及即转」
  义务,合规。
- 译文语义逐条对照(chat.go StatusPayload 三字段 / 两个新错误码 / emitErrorDiag /
  promptWithRetry / runPrompt switch 三分支 + default 内两条被移动过的 §4.4/§3.3 /
  SendAndWaitSync 文档+quota 行内 / prompt_error_test.go 全部 / errSeq):机械翻译
  忠实,§ 引用保留。

### P2-2(退避基数对齐 DoD)—— 过

- `chat.go:428`:`promptRetryBackoff: 1 * time.Second` ✓(原 2s)。
- 退避数学亲核(`promptWithRetry`,chat.go:2256):`wait = promptRetryBackoff <<
  (attempts-1)`,attempt 1/2/3 失败后分别等 **1s/2s/4s**(共 7s),attempt 4 失败时
  `attempts > promptRetryLimit(3)` 返回,总尝试 = 1+3 = 4。**1s/2s/4s 恰为 DoD
  「1s/2s/4s 量级,勿超」原值**;字段注释同步改「1+2+4=7s, per DoD」。
- 附带收益属实:最坏叠加(harness 内部 ~33s×4 重试链 + 客户端退避)从 ~2.5min 降到
  ~2.3min。

### P3-1(SendAndWaitSync 文档如实)—— 过

新文档(chat.go:2157-2162):「quota exhaustion keeps the connection… every other
failure tears it down, caller's retry reconnects via Resume in ensureLive」——与实际
行为逐行对得上(quota 分支 emitErrorDiag 后直接 return 不 teardown;其余走
teardown)。与 runPrompt 处置一致的说法成立。

### 行为无其他改动 —— 过(逐字节证明)

- **注释剥离 diff**:对 58fa8d1→6fd243c 的 3 个 Go 文件剥掉 `//` 注释后 diff,
  唯一非空白差异 = `promptRetryBackoff: 2s → 1s` 一行;其余全是注释重排产生的空行。
- `prompt_error_test.go` 同法核验:代码零改动(纯注释)。`queue_test.go` 1 行注释。
  `types.ts` 3 行注释(tsc 过即证契约未变)。

## 门禁(全部亲跑,worktree 自建 gitignored 中间产物:bun install + wails3 generate
bindings(仓库根)+ bun run build)

- `go build ./...` exit 0(ld 的 macOS 版本 warning 为本机环境噪音,非错误)。
- `go vet ./...` exit 0。
- `go test -short -count=1 ./...`:**16/16 包全过**。
- 新用例 `-race`(`TestDiagnose.*|TestRunPromptQuota.*|TestRunPromptTransient.*|
  TestSendAndWaitSyncQuota.*`,acp + chat):**11/11 PASS**,race 干净(避开
  `TestRunPrompt*` 字面宽匹配会连带的 error_code_test.go 预先存在 race 失败,
  #24347 §4 已记录)。
- 前端:`bun run build`(= `tsc && vite build`)过——types.ts 纯注释改动,tsc 即足;
  bun test 属前端 reviewer 范围,本次不重跑(#24348 worklog 自记 362/362)。

## 结论

**APPROVE**。P2-1/P2-2/P3-1 全部闭合,证据为穷举比对而非抽样;除退避常量(本次
修复目标)外零行为改动,回归面最小。#24347 审查环关闭。

跟踪项(继承 #24347,均不阻塞本次):

- P3-3:前端 ErrorCard 插值 rootCause/resetAt/attempts —— 仍在前端步骤 3。
- P3-2/P3-4:记录项(sync 路径泛化错误码 / 定时队列 idle-after-quota 单次 drain /
  SDK 层超时窄双发窗口),知悉。

## 验证

- 全部命令与输出见上;核对方法:注释穷举提取比对(rg CJK + 逐条 rg -F 查 HEAD)、
  剥注释 diff 证零行为改动、退避位移数学手推。
- 本 review 未改任何产品代码;worktree 生成的 bindings/dist 为 gitignored 中间产物,
  `git status` clean(仅本 worklog 新增)。

## 下一步

- #46 步骤 3(前端 ErrorCard 插值 + i18n 兜底链)派发时由前端 reviewer 接 P3-3。
