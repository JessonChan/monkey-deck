# 2026-09-01 CodeBuddy 冒烟 + resume→loadSession 降级落地

## 起因

用户在 CodeBuddy(腾讯 `codebuddy --acp`)上遇到报错:
`start acp session: resume session: harness does not advertise sessionCapabilities.resume`。
怀疑:是不是 Monkey Deck 对能力声明返回值的默认处理有误,该报错是误判?

## 冒烟(三次递进实证,全部真连本机 codebuddy v2.141.0,`codebuddy --acp`)

1. **声明位**:原生 wire 抓包 —— CodeBuddy 的 `initialize` 响应 `agentCapabilities` **连
   `sessionCapabilities` key 都没有**(只有 promptCapabilities/mcpCapabilities/loadSession/
   delegateToolsSupport/mainAgentSupport)。SDK `UnmarshalJSON` 缺省补 `sessionCapabilities:{}`,
   `Resume` 指针保持 nil。**我们 `sc.Resume != nil` 判 un-declared 是正确解析,非误判。**
   → 声明层结论:CodeBuddy 确实不声明 resume,不是我们解析错。
2. **能力层(同进程)**:直接发 `session/resume` 依旧成功(configOptions=4)。
3. **能力层(跨进程 + 上下文)**:进程 A newSession + prompt 设密语 "BANANA" → 杀进程;
   进程 B 用存的 session id `session/resume` → 再问密语 → **答出 "BANANA"**。
   → 结论:CodeBuddy 是 **under-declare(实现了 resume 但没声明)**,且跨进程恢复上下文完整。

**定性**:这不是「声明了但实际没有」,而是「没声明但实际有且好用」。我们协议层面没判错,
但被「只看声明位就硬拒绝」挡在一个本体可用的能力外。历史决策见
`docs/worklog/2026-08-06-acp-conformance-audit.md:51`(当时担忧 resume→load 降级维护 v2 要废弃的路径、
非阻塞暂缓;CodeBuddy 正是当初标记的「真遇到 loadSession-only / 不声明 resume 的 harness 再补」场景)。

## 改法(找不变量:resume 尝试优先,RPC 失败才降级)

`internal/acp/runner.go` `ResumeChatSession`:
- **删掉**「`SessionCapabilities.Resume == nil` 即 shutdown + 报错」的硬门控 —— 声明不再是硬前置。
- **always 尝试 `session/resume`**(对正常声明 resume 的 opencode/omp 零成本;对 CodeBuddy 一次成功调用。
  协议只要求「UNSUPPORTED 时不得调用」,attempt 是 best-effort)。
- **仅当 resume RPC 真正失败(`resumeErr != nil`)才降级**:若 harness 声明 `loadSession`
  → `session/load`(保留上下文的重放恢复);未声明 loadSession → 才报错。
  **绝不降级到无上下文的 session/new**(§1.4/§7:丢历史不可接受)。
- 抑制窗(`handler.OnEvent` 丢窗口内历史重放)跨 resume+load 保持活跃再统一 restore,
  避免 load 重放把 DB 已有历史重复渲染(与 resume 抑制同一不变量)。
- 两个响应类型不同(ResumeSessionResponse vs LoadSessionResponse),取 `ConfigOptions` 用局部变量收敛。

## 改了哪些文件

- `internal/acp/runner.go`:resume 硬门控 → 尝试优先 + loadSession 降级。
- `internal/acp/probe_fakeagent_test.go`:fake harness 增 `undeclared-resume-works`(CodeBuddy-like,
  resume 不声明但 RPC 成功)与 `load-only`(resume 不声明且 RPC 失败 + loadSession 可用)两态;
  新增 `TestResumeChatSessionUndeclaredResumeWorks` / `TestResumeChatSessionFallsBackToLoad`。

## 验证

- **单测**(§5.1 用 re-exec helper-process fake harness,无真 codebuddy/key/网络):
  - `TestResumeChatSessionUndeclaredResumeWorks` PASS —— 未声明 resume 但 RPC 成功 → `chat session loaded`。
  - `TestResumeChatSessionFallsBackToLoad` PASS —— 日志 `session/resume failed, recovered via session/load`。
  - 既有 `TestProbeHarnessOmittedAgentInfo`/`TestProbeHarnessDeclaredFork` 不回归(fake 两态向后兼容来自 env mode)。
- `go test ./internal/acp/... ./internal/chat/...` 全绿;`go test ./...` 全绿;`go vet` /
  `go vet -tags integration ./internal/acp/` 干净。
- 三端(§4.7):纯 Go 后端逻辑改动,无前端/协议面/响应式/remote 守卫触及;GUI/浏览器/PWA
  共用同一 binding 通道与 React 树,无回归面。

## 下一步

- 用户在桌面 GUI 实际 reopen 一次 CodeBuddy 会话,确认端到端(放行后体验)。
- 若未来出现「resume RPC 失败且无 loadSession」的 harness,错误信息已是人话,可另议导入类方案(见
  `2026-07-01-decline-import-historical-chats.md` 的 load 批量重放路径,不在本期范围)。
