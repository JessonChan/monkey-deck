# 2026-08-30 调研:OMP「X 分钟后自动回传进度(bg_5)」与 ACP 协议的关系

## 起因

用户在 monkey-deck 用 OMP 作 harness 时,agent 偶尔说「5 分钟后自动回传进度(bg_5)」。需要确认:
1. ACP 协议对 harness 有没有 background 任务回调的协议支持;
2. OMP 源码里是否有 background 任务回调机制,「bg_5」「5 分钟」从哪来。

## 结论(先说答案)

**两件事都是 OMP 自己实现的,ACP 协议层面没有 background 任务回调。**

### 1. ACP 协议侧:没有任何 background/job 语义

-ACP v1 `SessionUpdate` 全集(stable schema,acp-go-sdk v0.13.5 `schema/schema.json` 实测):
  `user_message_chunk / agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / plan / available_commands_update / current_mode_update / config_option_update / session_info_update`
  (unstable 再加 `plan_update / plan_removed / usage_update`)。**没有 job/background 类更新。**
- `session/prompt` 是 request/response:turn 结束 = 返回 `stopReason`。**协议上不存在「turn 结束后 harness 主动发起的新通知流」承载后台结果**;server-initiated turn 也不在协议里。
- 唯一扩展口是 `_meta` 与 `ExtNotification`(类型为 `unknown` 的逃生舱);OMP 的 ACP 适配层 `extNotification` 是**空实现**(acp-agent.ts#L1190),没定义任何后台任务扩展。
- 官方规范 prompt-turn 页(agentclientprotocol.com/protocol/v1/prompt-turn)确认:turn 内 only `session/update` + `session/request_permission`,turn 尾 = prompt response。

结论:**monkey-deck 永远收不到「background 任务完成」的专用协议事件;ACP 不给这个承诺。**

### 2. OMP 侧:bg_N 是 `AsyncJobManager` 的进程内任务体系(纯 OMP 实现)

核心源码(`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/`,v17.4.2):

- **`src/async/job-manager.ts`**:`AsyncJobManager`,job id 生成 `bg_1/bg_2/...`(#resolveJobId)——**bg_5 就是它发的**。默认容量 15 并发、settled 后保留 5 分钟(DEFAULT_RETENTION_MS = 5*60_000,这也是「job 行 5 分钟后过期」的来源,hub.md 提示同源)。
- **三种 job 类型**:`bash`(bash 工具 `async:true` 或 auto-background)/ `task`(后台子代理)/ `eval`(eval cell)。
- **auto-background**(`src/async/auto-background.ts`):bash/eval 前台跑超过阈值(默认 60s,`bash.autoBackground.thresholdMs`/`eval.autoBackground.thresholdMs`)→ 转后台 job。工具结果里给模型的文案是英文 `Backgrounded as job bg_N; result will be delivered automatically.`(formatBackgroundNotice)——**「5 分钟后自动回传进度(bg_5)」这句中文是模型自己的转述**,不是 OMP 模板;模型引用的 bg_5 是真实 job id,「5 分钟」大概率来自模型对 poll 阶梯/poll 时长的理解,或纯估算。
- **「自动回传」的实现**(OMP 进程内,不经协议):
  1. job 完成 → owner-scoped delivery sink(`AsyncJobManager.registerDeliverySink`)→ `AgentSession.#deliverAsyncJobResult`(agent-session.ts#L1948)→ 格式化为 `async-result` custom message(`src/session/async-job-delivery.ts`,模板 `src/prompts/tools/async-result.md`:"Background job bg_N has completed. Resume your work…")→ 入 yield queue;
  2. yield queue idle flush(session 空闲时)→ `injectIdle` → **`this.agent.prompt(message)` 自起新的内部 turn**——模型看到结果继续干活;
  3. **ACP 模式的关键闸门**:`acp-client-bridge.ts#L39` 设 `deferAgentInitiatedTurns: true`,注释原文 *"ACP v1 clients cannot show server-initiated turns as busy after prompt response"*。效果:
     - **turn 进行中 job 完成** → 注入当前 turn(模型当下消化)+ `#waitForAcpPromptIdle` 在 agent_end 前最多 3 轮 drain(250ms 超时)已排队的交付,保证结果在本 turn 的 session/update 流里发给 client;
     - **turn 已结束才完成**(idle flush 想自起新 turn)→ `deferAgentInitiatedTurns` 拦下 → 排队为 hidden next-turn message(agent-session.ts#L6460/6481),**等下一条用户消息一起送进模型**。
- **中途进度**:`AsyncJob.onProgress` 回调只喂 job 行详情/TUI(bash 转发到 onUpdate 即 `tool_call_update`)。模型要看进度得自己调 `hub` 工具(`jobs`/`wait`,`src/tools/hub/jobs.ts`);`async.pollWaitDuration` 默认 `smart`,poll 等待阶梯 5s→10s→30s→60s→**300s(5m)** 封顶——阶梯顶格 5 分钟是「5 分钟」最硬的锚点。

### 3. 对 monkey-deck(client)的实际影响

- **能看见的**:`tool_call`/`tool_call_update`(bash 转后台那一刻,OMP 以 tool result + `Backgrounded as job…` 文案收口,monkey-deck 已有的 #109 tool-fallback-summary 渲染路径直接吃得到);turn 内完成的 job 结果 = 普通 `agent_message_chunk`/tool 流。
- **看不见的**:turn 结束后完成的 job —— OMP 不推(ACP 没通道,OMP 自己也选择 defer),结果**在用户下次发消息时才被模型消化、以模型转述回到对话流**。monkey-deck 侧无需也不应为此做任何「后台事件」预期;用户等 5 分钟没动静是协议形态使然,不是丢事件。
- 判定:`session/prompt` 返回 `end_turn` 后,client 就该回 idle;OMP 的后台 job 生命周期对 client 完全透明(只在 omp 进程内存 + 会话 JSONL 里)。

## 改了哪些文件

无代码改动。仅本调研日志。

## 验证

- ACP schema:本机 acp-go-sdk v0.13.5 `schema/schema.json`/`schema.unstable.json` 解析 `SessionUpdate.oneOf` 枚举;TS SDK `@agentclientprotocol/sdk` `types.gen.d.ts` 交叉一致;官方 prompt-turn 文档页核对。
- OMP 源码:直接读 `pi-coding-agent@17.4.2` 的 `src/async/`、`src/session/async-job-delivery.ts`、`src/modes/acp/{acp-agent,acp-client-bridge}.ts`、`src/tools/{bash,hub/jobs}.ts`、`src/config/settings-schema.ts`,链路逐段核对(bg_ 生成→delivery sink→yield queue→deferAgentInitiatedTurns 闸门→hidden next-turn 排队)。
- 未跑真 harness(纯源码调研,§5.1 不适用)。

## 下一步

- 无需 monkey-deck 代码动作:不建「后台任务事件」预期,不改 chat 层。
- 若未来想做 UI 上的「后台任务中」提示,唯一数据源是 turn 内 `tool_call_update` 的 async details(OMP 已带 `{async:{state,jobId,type}}`),可考虑在 tool 卡片透出「已转后台」状态;记 OPEN 不动工。
