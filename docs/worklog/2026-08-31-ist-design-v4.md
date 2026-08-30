# monkey-deck「harness 后台任务」兼容设计(定稿 v4,round-4 APPROVE)

> v4 变更(吸收 round-3 review,verdict「仍需改动」4 条阻塞全采纳,均为补定义量级):
> - #1:epoch 生命周期改独立字段 ls.epochID(含 ist_ id)+ epochOpen 标志,只在 6 条硬收口
>   清;SCM 门控 waiting 期必须锁(半堵=不堵);上界 ≈5min(reaper 兜底);顺带解决软收口后
>   复用 id 无处可取。currentTurnID 恢复纯「本轮用户 turn」语义。
> - #2:队列延迟装独立截止定时器(deferredAt 起算 2×quiesce 硬上限),不依赖软收口计时器
>   唤醒(持续输出时软收口计时器被不断推后 = 无唤醒源 → 饿死)。
> - #3:lastEpochEventAt 只由可归档事件刷新(1.2 集合);删冗余判据;护栏不得 AND epochOpen
>   (startTurn 已先硬收口,AND 会废掉护栏);1.5/1.6 两个语义分别命名(lastEpochEventAt=
>   最近后台事件;epochOpen=epoch 开到硬收口)。
> - #4:active→waiting 转换由软收口 quiesce 计时器 emit chat:bg(前端不起轮询,不 emit 则
>   waiting 永不可达)。
> - 补记:chat:bg 洪泛节流(状态变化才 emit,或 ≥1s 节流);R8 硬收口后迟到 tool_call_update
>   归因新 turn;R9 IsAlive 只验进程不验连接(护栏跳过 reconnect 后无自愈触发点,接受)。
> - round-4 验收 APPROVE,附实现期三钉(N1 waiting→active 回升 emit = epoch 重开/续写时发
>   active,状态变化即发;N2 deferredAt 取首次延迟时刻,重复延迟不重置;N3 护栏命中后清
>   currentTurnID,让下个后台事件开新 epoch 自愈)。

> v3 变更(吸收 round-2 review,verdict APPROVE with changes,阻塞项 A-F 全采纳,并接受
> reviewer 对 round-1 M6-Resume 子项的自我推翻):
> - A:钉死软收口不变量 —— quiesce 软收口**不清 timeline、不调 finalizeTurn**,只 persist +
>   停 timer + 清 currentTurnID;只有 6 条硬收口路径才清 timeline(resetBuffers 语义)。
> - B:drainQueue 延迟检查点移到 dequeueDue **之前**;唤醒源 = 软收口 quiesce 计时器,设硬
>   上限(2×quiesce 后无条件放行);并发拒绝的队列项**插回队头**(复用 requeueAt),notice
>   文案「已放回队列,稍后自动重发」。
> - C:M5 护栏判据 = 新增 ls.lastEpochEventAt 时间戳(now-lastEpochEventAt<quiesce 容差),
>   不用布尔;覆盖 transient + fatal/default 两个失败分支(quota 豁免);决策后 IsAlive()
>   复核,死了 fall through 回 teardown。
> - D:删除 resumeReplayActive(runner.go:181-188 已有结构性抑制;post-RPC 重放由既有 #79
>   RotateOnce 机制覆盖;手工标志有泄漏面,整块不要)。
> - E:6 条硬收口路径全部 emit chat:bg off;前端收到 closed 时顺手清 bg 条目(防御纵深);
>   chat:bg payload 的 silentMs 改为绝对时间戳 lastEventAt(前端 timeAgo,不起轮询)。
> - F:SCM 门控(SessionStage/Unstage/Discard/Commit/MergeSession/AICommit)判据从 isBusy
>   扩展为 isBusy || epochActive —— 后台 agent 在写文件时与 turn 中一样危险,收紧。
> - 采纳 nice-to-have:quiesce 硬编码 10s 不配置化(G);「开 epoch 清 currentPlan」删除
>   (死代码,idle plan 已丢弃 + runPrompt 收尾已清);finalize 兜底语义并入「硬收口调
>   persistTurn」一条;R6 补「远程断线重连后侧栏其它会话的 bg 点靠 SessionBgStates 对账,
>   且 remote:resync 回调要加 pull bg 状态」。
>
> 行号基线注意:round-2 reviewer 读到的是并行开发下的偏移快照(其引用比本树 +~199);本稿
> 行号以当前树为准,实现时一律重锚。

## 0. 背景与约束

monkey-deck 是 Wails3(Go 后端 + React 前端)桌面 ACP **client**,stdio JSON-RPC 驱动编码型
agent(harness):opencode / OMP(oh-my-pi)/ codebuddy。本地 SQLite 唯一真相(§1.5)。
纪律:纯 ACP(§1.1)、KISS(§5.3)、零 harness 身份分支、§4.4 人话呈现、三端验证(§4.7)。

### 已实证事实(源码级)

1. **ACP 无 background 概念**。SessionUpdate 全集(v1+unstable)= message/thought chunk、
   tool_call(_update)、plan(_update/_removed)、available_commands_update、current_mode_update、
   config_option_update、session_info_update、usage_update。session/prompt 是 req/resp;无
   server-initiated turn;唯一扩展口 _meta 与 `_`-前缀方法,两 harness 均未用。
2. **OMP(v17.4.2)**:AsyncJobManager(bg_N;bash/task/eval),"回传"= 进程内自起新 turn 喂
   LLM。**ACP 适配层 deferAgentInitiatedTurns=true:turn 后完成的 job 不推 client,押到下条
   用户消息** → OMP 下 client idle 期零事件,本设计代码路径永不触发(零成本死路径)。
3. **opencode(1.18.25 已验二进制)**:BackgroundJob + task 工具 background:true,实验旗标
   OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS 默认关。开后:后台子代理完成 → 父 session 注入
   synthetic message → **自起新 turn,无条件推 session/update,不管 client idle 与否**。
   ACP prompt 是 runUntilIdle 语义。
4. **两家后台 job 均进程内存态、非持久**(harness 死 = job 丢)。

### monkey-deck 现状(两轮 review 均已核)

- handleEvent(chat.go:2526)主键归并:message 按 messageId+role(messageKey:2640,RotateOnce
  fallback),tool 按 toolCallId;turn 内 flushTurn(1s 防抖)+ persistTurn reconcile。
- idle 期事件 emit 可见但不落库(markTurnDirty 在 currentTurnID=="" return,turnpersist.go:77);
  下轮 resetBuffers 清 timeline → 重开消失(违反 §1.5)。
- busy 仅 runPrompt 期;SendAndWaitSync 置 currentTurnID 不置 busy(OR 判据已覆盖)。
- closeIdle(1801)判 lastActivity;idleTimeout 硬编码 5min(chat.go:419),无 setting。
- 前端 status 封闭联合(types.ts:133),Sidebar dot 只认 prompting(Sidebar.tsx:857);
  SessionStatuses()(1538)恒返 idle;App.tsx:674-686 idle 时把 in_progress tool 强制收口。
- isBusy(2866)门控 SCM 写操作(Stage/Unstage/Discard/Commit/Merge/AICommit)。
- Resume 同步窗口结构性丢弃重放事件(runner.go:181-188);post-RPC 重放由 #79 RotateOnce
  覆盖(runner.go:214-226)。
- drainQueue 是 dequeue-before-send(queue.go),失败才 requeue;唤醒源 = runPrompt 收尾/
  schedule timer/schedule 且 idle/重连成功。

### 设计目标

- G1: idle 期事件不丢(落库、重开可见)。
- G2: 用户能感知后台活动。
- G3: 不破坏现有 turn 语义、零身份分支、不违背 ACP。
- G4: reaper 不误杀有活动的 harness;零事件任务的边界如实文档化。

## 1. IST —— per-idle-epoch 合成 turn

**核心:harness 无关的 client 侧归化。** 判据只有「事件到达时 client 是否在 turn 里」。

### 1.1 idle epoch 与 epoch turn_id

- **epoch**:上一轮用户 turn 落定 → 下一轮用户 turn 开始之间的整段 idle 期。
- **epoch 生命周期字段(round-3 #1)**:新增 `ls.epochID`(string,ist_<uuid> 形态)+ epoch
  开启状态,**只在 6 条硬收口清**;软收口不清(见 1.3)。epoch 开启时 currentTurnID :=
  epochID(让现有 markTurnDirty/flushTurn 管线无缝复用),软收口清 currentTurnID 时 epochID
  保留 → 复用同一 id 重开。currentTurnID 恢复纯「当前写入目标 turn」语义(用户 turn 或
  epoch),不再兼作 epoch 生命周期标志。
- **epoch turn_id**:即 epochID,epoch 内第一条可归档事件到达时生成一次,整个 epoch 复用;
  下个 epoch 换新。**quiesce/事件间隔不轮转 turn_id**(修 round-1 M2:轮转会让被静默切开的
  同一 messageId 落两行碎片)。
- **持久化**:完全复用现有管线(markTurnDirty→flushTurn 1s 防抖 + 硬收口时 persistTurn)。
  不加表/列/迁移(messages.turn_id/entry_key + 0017 部分唯一索引已够)。

### 1.2 触发与归档集合

idle 期(判定见 1.5)到达 → **开启 epoch**(置 currentTurnID=ist_xxx),进 timeline、走既有
merge/flush:
- `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update`
  (tool_call_update 必须触发:8 分钟静默长任务完成时它单独到达,不触发则 tool 永久卡
  in_progress —— round-1 M1)。

idle 期到达 → 不开 epoch,走旁路:
- `usage_update`:照常 UpdateSessionUsage。
- `session_info_update` / `available_commands_update` / `current_mode_update` /
  `config_option_update`:照常旁路。
- `plan` / `plan_update` / `plan_removed`:**丢弃**(epoch 无主可钉;runPrompt 收尾已清
  currentPlan,无污染源;「开 epoch 清 currentPlan」的双保险是死代码,已删)。
- **任何 kind:刷新 ls.lastActivity**(取代被删除的 bg_active 冻结,数学等价、状态更少)。
- **仅上述可归档四类:额外刷新 ls.lastEpochEventAt**(round-3 #3 —— 护栏判据的刷新集合;
  旁路事件(usage_update 等)不刷,否则心跳会无限续护栏窗,与 waiting 判据互打)。

### 1.3 软收口与硬收口(不变量,round-2 A)

**不变量:timeline entry 一旦创建,就是它那行 content 的唯一权威,直到 epoch 最终(硬)收口;
任何 upsert 的 content 必须是该 entry 的完整累积全文。**

- **软收口**(quiesce 10s 静默,**硬编码不配置化**):= persistTurn(当前 timeline)+ 停
  flushTimer + 清 currentTurnID(**保留 epochID,epoch 仍处开启态,只是转 waiting**)+
  **emit chat:bg waiting**(round-3 #4:前端不起轮询,不 emit 则 waiting 永不可达;洪泛时
  按状态变化 emit / ≥1s 节流)。**不调 resetBuffers、不调 finalizeTurn**(finalizeTurn 是
  「轮结束收口」语义,会把 entry 标 final)。timeline 保留 → 后续续写 chunk 累积在原 entry
  上,upsert 全文覆盖 → "Hello"+" world" 合成 "Hello world",无丢失;前端 replace-merge
  (streamMerge 整段替换)与切窗丢缓存重载两条路径都被此不变量救活。
  - 若软收口时清了 timeline(错误实现):续写从零累积 → DO UPDATE 用 " world" 覆盖 "Hello"
    → 前半段当场丢失且前端立即可见 —— 实现与 review 都盯这条。
- **硬收口**(清 timeline 的最终收口,共 6 条,全部照 runPrompt 收尾 2331-2345 的原子结构:
  同一 ls.mu 临界区内「finalizeTurn() 快照 + 停 flushTimer + 清 currentTurnID」,锁外
  persistMu 写库):
  1. startTurn(resetBuffers 前;顺序必须是「finalize epoch → resetBuffers」,反向会把
     epoch 残留 entry 归属用户 turn 或被清掉;同一 sendMu 临界区);
  2. harness 断连(health watcher / peer-disconnected);
  3. CloseSession(1733);
  4. DeleteSession;
  5. reaper closeIdle(1801);
  6. ServiceShutdown。
  3-6 尽力 finalize + 停 timer,失败仅记日志(1s 防抖已把丢失窗口压到 ≈1s)。
- **epoch 重开**:软收口后同 epoch 再来事件 → 复用**同一个 ist_ id** 重开(timeline 未清,
  续写无缝);硬收口后不存在重开(下个事件开新 epoch)。

### 1.4 idle 判定

`busy==false && currentTurnID==""`,两字段在同一 ls.mu 临界区一次读(runPrompt 收尾同段清
两者;SendAndWaitSync 不置 busy 已被 OR 覆盖)。

### 1.5 并发 Prompt 护栏(round-2 C)

- 新增 `ls.lastEpochEventAt`(毫秒,ls.mu 保护):**仅由 1.2 的可归档事件刷新**(round-3 #3)。
- **护栏条件**(单一时间戳比较,**不得 AND epochOpen** —— startTurn 已先硬收口 epoch,等到
  prompt 失败时 epochOpen 必为 false,AND 上去整条护栏作废):runPrompt 失败且
  `now-lastEpochEventAt < 2×quiesce(20s)` → **不 teardown、不 reconnect**:
  - 失败分类覆盖 **transient 与 fatal/default 两支**(quota 豁免不变):并发拒绝最可能落
    fatal(prompt_error.go 分类里它既非 quota 也不匹配 transient 正则),只护 default 会漏。
  - **IsAlive() 复核**:护栏命中后调 ls.chat.IsAlive();进程已死 → fall through 回原
    teardown 路径(否则「后台任务仍在运行」的 notice 对着尸头撒谎)。
  - 通知:emit notice「后台任务仍在运行,消息已放回队列」。
- **队列交互(round-2 B)**:
  - epoch 活跃检查放 `dequeueDue` **之前**(drainQueue 是 dequeue-before-send,消费后再
    "延迟"就没了 requeue 兜底);
  - **独立的截止定时器(round-3 #2)**:延迟时按 deferredAt 装定时器,释放条件 =
    `now-deferredAt ≥ 2×quiesce` 或护栏未命中。不能依赖软收口计时器唤醒 —— 持续输出时它被
    不断推后等于无唤醒源,队列项会静默饿死。
  - 并发拒绝后被 dequeue 的用户消息 **requeueAt 插回队头**(现有实现),notice 文案如实
    「已放回队列,稍后自动重发」。
- SendMessage 直发路径(startTurn 已先落库用户消息):并发拒绝时该用户消息已在 DB 且无人
  回复 —— 护栏把它插回队列由 drain 重发(重发走 queue 路径,不重复落库 —— 实现时用队列项
  引用已有消息 ID,避免二次 AppendMessage;此细节实现时定)。

### 1.6 SCM 门控收紧(round-2 F)

SessionStage/Unstage/Discard/Commit、MergeSession、SessionAICommit 的判据从 `isBusy(sessionID)`
改为 `isBusy(sessionID) || epochOpen(sessionID)`(读 1.1 的 epoch 开启标志,**不是**
currentTurnID 前缀 —— 软收口已清后者,按前缀判则 waiting 期解锁,恰是最危险的 8 分钟静默
时段;round-3 #1)。**waiting 期必须锁**:epoch 从开启到硬收口全程视为「后台 agent 可能在写
文件」。上界顾虑消除:reaper 在 lastActivity+5min 硬收口(§3),最长锁 ≈5min。理由:这些
门控注释明确「turn 进行中拒绝,避免与 opencode 写文件竞争 git index」——后台 agent 写文件
时同样危险,而 epoch 期间 busy==false,原门控形同虚设。

## 2. 后台活动指示(round-2 E)

**不走 chat:status**(封闭联合渲染不出;SessionStatuses 恒返 idle 会反向覆盖;App.tsx
674-686 会把运行中 tool 强制收口)。新增:
- 事件 `chat:bg`:payload {sessionId, state: "active"|"waiting"|"off", **lastEventAt**(绝对
  时间戳,前端 timeAgo 渲染「已静默 N 分钟」,不起轮询)}。
  - active:最后可归档事件 < quiesce;
  - waiting:≥ quiesce 静默且 epoch 未被用户 turn 打断;
  - off:6 条硬收口路径**全部 emit**;前端收到 `closed` 时顺手清 bg 条目(防御纵深 ——
    reaper 杀掉后无人再推 chat:bg,否则灯永久停在 waiting 撒谎)。
- 拉取通道 `SessionBgStates()`(照 SessionStatuses 模式);**remote:resync 回调加 pull bg
  状态**(侧栏给所有 session 画点,resync 只重开当前会话,断线期间其它会话的 bg 靠 pull
  对账;事件广播本身经 remote/server 自动生效)。
- 前端:Sidebar dot 的 bg 次级色点(不动 prompting 主指示);ChatView 顶部轻量「后台任务
  进行中/等待中(已静默 N 分钟)」条;bg 提示文案写明「停止不影响后台任务」(StopSession
  在 epoch 期 turnCancel==nil 走 idle,会把运行中 tool 强制收口 —— 既有路径的同一个谎,
  文案交代而非新增机制)。三端同事件流。
- **任何 epoch 路径不 emit chat:status**。

## 3. idle reaper 与静默任务(如实陈述)

- handleEvent 对所有事件刷 lastActivity → 有事件流出的后台任务不会被杀(杀点=最后事件+5min)。
- **完全零事件的后台任务会在 idleTimeout(硬编码 5min)后随 harness 终止。这是 ACP 无法
  感知 harness 内部后台任务的协议事实的直接后果,不是 bug。**waiting 态 + 静默分钟数让用户
  可判断;后续若真有需求,idleTimeout 提为设置项(独立小改动,不捆本设计)。
- opencode 旗标:harness 编辑页 env 注入
  OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1,零代码,文档说明(上游实验特性,不固化 UI)。

## 4. 不做什么

- 不做 job 级 UI(ACP 无通道);不做完成推送;不给 OMP 写适配(死路径);
- 不加表/列/迁移;不做 resumeReplayActive(结构性抑制 + RotateOnce 已覆盖,round-2 D);
- 不改 AGENTS.md 阶段边界;quiesce 不配置化。

## 5. 风险与开放问题(定稿残留)

- R1(开放,不阻塞):opencode runUntilIdle 会因本轮内完成的后台注入推迟 prompt response,
  属合理(模型还在消化);1.5 护栏先行,实验确认后可收紧。
- R2(已覆盖):竞态由「finalize 原子性不变量 + sendMu 串行 + ls.mu 单临界区读」三层覆盖。
- R3(接受):epoch 内 timeline 驻留内存到下次用户 turn,与长 turn timeline 同量级。
- R4(接受):侧栏排序轻微抖动(UpsertTurnMessage→TouchSession 改 updated_at,同 promptedAt
  组内被后台 chunk 顶动);确认可接受。
- R5(独立修,不捆):messages seq 先读后写不在事务内(messages.go:59),IST 提高空闲写
  频率放大暴露;修法 = UNIQUE(session_id,seq) 或挪事务,独立 commit。
- R6(实现期):三端回归清单 —— GUI dot、远程 WS 断线重连对账(SessionBgStates +
  remote:resync pull)、PWA ≤768px 指示条布局;含「断线期间其它会话 bg 点对账」。
- R7(接受):transient 自动重试会在护栏生效前先打 ≤4 次(并发拒绝若被误分类为 transient);
  IsAlive 复核兜底,记录在案。
- R8(接受,补记 round-3):硬收口后迟到的 tool_call_update 归因到新 turn;epoch 内原行可能
  留 in_progress(finalizeTurn 已标 final 则被覆盖,否则残留)——前端 closed 兜底收口。
- R9(接受,补记 round-3):IsAlive 只验进程存活不验连接健康;护栏跳过 reconnect 后无后续
  自愈触发点(用户下条消息走 ensureLive 兜底)。
