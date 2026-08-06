# 2026-08-06 ACP 协议合规系统审计 + ProbeHarness conformance 探针

## 起因
最初问题:ProbeHarness 不能覆盖我们实际使用的全部 ACP API(只跑 Initialize→NewSession→Prompt→Close),junie「发送成功但无回复」的坑在添加前自检里测不到。决定做一次系统性协议合规审计:逐一验证代码用到的全部 ACP 协议面(client 合规性 + harness conformance 测法),既保证我们自己合规,又定位哪些 harness 不合规。

## 根因 / 协议调研
用 5 个 scout 并行验证 24 个协议面(client→agent RPC 7 + agent→client 回调 6 类 + SessionUpdate 11 变体),对照 `/tmp/monkey-deck-reference/agent-client-protocol` 的 v1 spec + schema + v2 RFD。发现:

- **client 侧 6 个合规硬伤**(违反协议 MUST/SHOULD 或功能缺失)。
- **ProbeHarness 3 个 conformance 盲区**:session/resume(是否违规重放)、session/cancel、session/set_config_option——全是 baseline 或高频路径却零覆盖。
- **junie resume 违规重放历史**(违反 session-resume.mdx MUST NOT replay)+ 不发 messageId,两者叠加致 fallback merge 粘连(用户看到的「发送成功无回复」根因)。Codex 疑似同类(resume 期间歇检出)。

关键协议事实:`session/resume` 在 v1 是 **MAY**(optional capability,agent 可只声明 loadSession);v2 升 **MUST**(baseline,session/load 被移除、重放折进 resume 的 replayFrom)。

## 改法

### A. client 协议合规硬化(6 处)
- `runner.go`:resume 前校验 `sessionCapabilities.resume`(session-setup MUST);initialize 校验回传 protocolVersion 不匹配即关(initialization SHOULD close);RefreshConfig probe 的 close 加 `sc.Close!=nil` 门控。
- `capability.go`:ProbeCapabilities 的 close 同上门控。
- `handler.go`:permission 取消返 `(Cancelled, nil)` 不再返 `ctx.Err()`(避免 SDK 转成 -32800 丢掉 cancelled outcome,prompt-turn.mdx:328 MUST);plan_update 的 file/markdown 变体(Items==nil)return false 跳过(不再 emit nil-entries 误清 plan);read_text_file 实现 line(1-based)/limit 窗口 + 负 limit 防护(`*req.Limit > 0`,防切片 panic)。

### B. LoadChatSession→ResumeChatSession 重命名(名副其实)+ resume 能力门控
- `runner.go`:函数重命名(实际走 session/resume)+ 上面 A 的 resume/version/close 门控。
- `chat.go`:`runner.LoadChatSession(...)` 调用点配套改名 + 注释。
- `sessions.go`/`runner_test.go`/`migrations/0001_init.sql`:配套注释措辞(LoadSession resume → Resume)。

### C. ProbeHarness 补 3 个 conformance 探针(`probe.go`)
- `SetConfigWorks`:用 model currentValue round-trip,验返回全量(零 LLM prompt)。
- `CancelHonored`:发 prompt + 第一条 session/update 事件即 `conn.Cancel` notification(onEvent 触发,非固定延迟——避免快速 harness <delay 完成的假阴性),验 `stopReason=cancelled`。
- `ResumeReplays`:resume 同 session + drain 3s,验响应窗口内无历史 message/tool/plan 重放。
- ConformanceReport 加 3 字段。省 token:set_config/resume 零 LLM prompt,cancel 用 "hi" 近零。

### D. 集成测试 + 修 pre-existing 过时签名
- 新 `probe_integration_test.go`:遍历内置(omp/opencode)+ 从 live SQLite 读 user harnesses,每个跑 ProbeHarness 出报告。
- 修 `integration_test.go`/`resume_test.go` 过时签名(NewChatSession/ResumeChatSession 少 onElicitation、Prompt 多 timeout)——这俩签名演进后没更新,integration build 一直是坏的。

## 改了哪些文件
- `internal/acp/runner.go`、`internal/acp/handler.go`、`internal/acp/capability.go`、`internal/acp/probe.go`
- `internal/chat/chat.go`、`internal/store/sessions.go`、`internal/store/migrations/0001_init.sql`、`internal/acp/runner_test.go`(重命名配套)
- 新 `internal/acp/probe_integration_test.go`;改 `internal/acp/integration_test.go`、`internal/acp/resume_test.go`

## 验证
- 默认 `go test ./internal/...` 全绿(14 包);integration `-tags` 编译干净。
- 多轮实测 7 个 harness(omp/opencode/jcode/junie/kimi/codex/reasonix):
  - **junie resume 重放 5/5 稳定检出**(ResumeReplays=true,drain 3s 后完全可靠)——用户最初的坑现在有专门探测器,添加前自检直接标红。
  - cancel 修探针后所有能跑的 harness cancelHonored=true(合规)。
  - omp/opencode/kimi/codex resume 合规(不重放);jcode 启动不稳;reasonix 命令配置错(`-y` 参数)。
- glm-5.2 + kimi 两轮代码 review 交叉验证:**无阻塞 bug,client 改动合规**。两 reviewer 都独立指出负 limit panic(#1)和 cancel 固定延迟竞态(#3),这回合正好修了。

## 下一步 / OPEN
- **#2 resume 缺失时降级 session/load**:kimi 指出只声明 loadSession 的 v1 合规 harness 会被 resume 硬门控误伤。但 v2 resume 升 MUST、load 移除——朝 v2 走,resume 是正道,降级 load 是维护一条 v2 要废弃的路径。**当前所有 harness 都支持 resume,非阻塞,记录为已知、暂不搞**(真遇到 loadSession-only harness 再补)。
- **#4 initialize version 校验**:`!=` 严格相等在 SDK v1 下正确,但 SDK 升 v2 后会误杀合规回 v1 的 harness。留 TODO,升 v2 时改「回传版本 ∈ 支持集合」。
- **#5 resume 探针**:drain 3s 对「重放靠帧触发」的 harness 抓不到(junie 内部定时器够,Codex 疑似帧触发间歇漏);resume 本身失败(rerr!=nil)时 ResumeReplays=false 会把更严重的失败记成合规——建议加 `resumeFailed` 字段。
- **#6 set_config 探针**依赖 `Category=="model"`,category 可选时静默跳过(测试用 HasModelOption 同源门控不误报)。
- junie 命令 `junie acp` 是错的(进 CLI 任务模式),正确入口 `junie --acp=true`(README/worklog 里多处要改)。
