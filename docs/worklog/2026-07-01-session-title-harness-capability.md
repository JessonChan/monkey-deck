# 2026-07-01 会话标题来源排查 + 注释去 harness 名(改用「harness 能力」措辞)

## 起因

排查 session `4980ceec-7290-4e98-8f6c-52e21969d20e`(harness=omp)的标题 `Add session search to sidebar`
怎么来的——首条用户消息是中文,标题却是干净英文祈使句,明显不是用户输入。此前认知是
「omp 不会返回标题」,与现象矛盾。

## 根因(三重交叉验证:omp 源码 + 实时 ACP 探测 + DB 31 个 omp session 比对)

1. **标题确实是 harness 生成的**,不是 monkey-deck 本地造。`titlegen.FallbackTitle` 只做归一化
   (压空白 / 解包 code fence / 去引号 / 提 `title:` 标签),**绝不翻译**——中文输入永远产不出英文标题。
2. **omp 能生成标题,但很不稳定(~15%)**:
   - omp 经在线 smol 模型生成标题(默认 `providers.tinyModel="online"` → `generateTitleOnline` →
     priority.json 的 smol 角色 `zai-glm-4.7`/`gemini-flash-lite`…),**异步**(`generateSessionTitle(...).then()`,
     不阻塞 turn),失败静默 `return null`,不 fallback。
   - DB 31 个 omp session 里仅 4 个拿到 LLM 标题;**0 个「omp 生成了但 monkey-deck 漏抓」**——
     monkey-deck 的 push(session_info_update)+ pull(session/list)两条通道抓取完全正确,没竞态漏抓。
     omp 自己的 session/list 也只 10/50 有标题。
   - opencode 对照:`session/list` **19/19 全有标题(100%)**。
3. **结论推翻旧认知的措辞**:不是「omp 不返回标题」,而是「omp 标题生成不稳定(在线 smol 凭据/
   网络问题),opencode 稳定」——两者**不一样**,故不满足「相同则统一代码」的前提。本地兜底标题
   (`titlegen.FallbackTitle`)对 omp 仍是必需的(~85% 的 session 靠它)。

### session_info_update 的处理已统一(无需改码)

- 处理链路只有一处、完全 harness 无关:`handler.go:349 SessionUpdate`(所有 harness 共用入口)
  → `flattenUpdate:412`(union 分派,无能力门控)→ `chat.go:1320`(写库 + 推前端)。
- **notification 不需要声明能力**(区别于 `session/list` RPC 需 `sessionCapabilities.list`)。
  harness 发了就处理,不发这条分支永远不触发、挂着无害——这正是标准 ACP client 写法:
  对每个标准 `SessionUpdate` variant 都无差别挂处理器。omp 额外会推 session_info_update
  (end-of-turn/bootstrap),opencode 不推,但对 monkey-deck 透明。
- 小毛刺:resume 时 `runner.go:134-141` 临时把 OnEvent 换 no-op(防历史重放),同步发在 resume
  调用期间的 session_info_update 会丢;但 omp 的 bootstrap 更新是 setTimeout 延后发,落到恢复后
  的 handler,无实际问题。

## 改法

只改注释,把标题/session_info 相关注释从「opencode 实证…」改成中性「harness 能力」措辞,
不提具体 harness 名。代码逻辑**零改动**(本就 harness 无关)。其余出现的 `opencode`/`omp` 是
真实具体机制(opencode.json model 注入、`reapStrayOpencode` 进程回收、集成测试 `exec.LookPath`
、harness 注册表),非「harness 能力」抽象,不动。

## 改了哪些文件

- `internal/acp/runner.go`:`SessionTitle` 注释。
- `internal/chat/chat.go`:`ChatConn.SessionTitle` 接口注释、`maybeAutoTitle`/`syncSessionTitle`
  /`mergeCommitMessage`/`runPrompt` 内联标题注释、`handleEvent` 的 session_info 注释。
- `internal/chat/title_test.go`:2 条测试注释。
- `internal/chat/queue_test.go`:`fakeChat.title` 字段注释。
- `internal/titlegen/titlegen.go`:包文档 + `FallbackTitle` 注释。

## 验证

- `go build ./internal/... .` ✅
- `go test ./internal/chat/ ./internal/titlegen/ ./internal/acp/ -count=1` ✅ 3 packages ok
- 实时 spawn `omp acp`:`sessionCapabilities.list={}`、`session/list` 对该 acp_session_id 返回
  `Add session search to sidebar`(与 DB 一字不差)。
- 实时 spawn `opencode acp`:同能力,`session/list` 19/19 有标题。
- grep 确认标题相关注释已无 `\b(opencode|omp)\b`(剩余命中均为 prompt/Compile 子串误报或非标题语境)。

## 下一步

- 不做代码统一(前提不成立)。本地兜底标题保留。
- memory 需更新:旧认知「omp 不返回标题」修正为「omp 标题生成不稳定 ~15%(在线 smol),
  opencode ~100%;两者均走 session/list;omp 额外推 session_info_update;monkey-deck 抓取 0 漏抓」。
- 若想提升 omp 标题命中率,是 **omp 侧配置**(给 smol 角色配有效 provider 凭据),非 monkey-deck bug。
