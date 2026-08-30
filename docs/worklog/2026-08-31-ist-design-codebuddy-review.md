# 2026-08-31 设计:OMP/opencode 后台任务兼容(IST per-idle-epoch)+ codebuddy 四轮 ACP 深评

## 起因

用户在 OMP harness 下见到「5 分钟后自动回传进度(bg_5)」,前次调研(worklog 2026-08-30)已定论:
ACP 协议无 background 概念;bg_N/自动回传是 OMP AsyncJobManager 进程内机制,且 OMP 在 ACP 下
defer 后台结果到下条用户消息(idle 期零事件)。本次补查 opencode(拉取
/tmp/monkey-deck-reference/opencode @10765ff + 本机 1.18.25 二进制 strings 验证),发现其
BackgroundJob + task background:true(实验旗标 OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
**无 defer 闸门**:后台完成 → 父 session 自起新 turn → idle 期无条件推 session/update。
→ monkey-deck 三个 gap:idle 期事件不落库(markTurnDirty 在 currentTurnID=="" return,重开消失,
违反 §1.5)、无活动指示(busy=false)、idle reaper 5min 杀 harness(后台 job 进程内存态必丢)。

用户要求:只讨论不实现;设计只兼容 OMP 与 opencode 两形态;设计交 codebuddy(`codebuddy --acp`,
本机 v2.141.0)多轮深入 review,背景(非 ACP 协议能力、我们想加这功能)讲清。

## 设计(定稿 v4,round-4 APPROVE)

核心:**harness 无关的 client 侧归化 —— IST(Idle Synthetic Turn),per-idle-epoch 合成 turn**。
判据只有「事件到达时 client 是否在 turn 里」(busy==false && currentTurnID=="",同临界区一次读),
零身份分支。要点:

- **epoch**:上轮用户 turn 落定 → 下轮开始的整段 idle 期;`ls.epochID`(ist_<uuid>)只在 6 条硬
  收口清,quiesce 不轮转 turn_id(否则同一 messageId 被静默切开落两行碎片)。
- **触发集**:agent_message_chunk / agent_thought_chunk / tool_call / **tool_call_update**
  (漏 tool_call_update 则 8min 静默任务完成时永久卡 in_progress)。plan 系 idle 期丢弃;旁路事件
  (usage 等)不开 epoch 但刷 lastActivity;可归档四类额外刷 lastEpochEventAt(护栏判据)。
- **软收口**(quiesce 10s 硬编码)= persist + 停 timer + 清 currentTurnID,**不清 timeline、不调
  finalizeTurn**(不变量:entry 是其行 content 唯一权威,upsert 必须全量全文 —— 清了则续写
  " world" 覆盖 "Hello",当场丢数据)+ emit chat:bg waiting。
- **硬收口 6 条**(startTurn/断连/CloseSession/DeleteSession/reaper/Shutdown)清 timeline,照
  runPrompt 收尾原子结构(同 ls.mu 段快照+清)。
- **并发 Prompt 护栏**:runPrompt 失败(覆盖 transient+fatal 两支,quota 豁免)且
  now-lastEpochEventAt<20s → 不 teardown(会杀进程组丢全部后台 job)、IsAlive() 复核兜尸头;
  队列延迟检查点在 dequeueDue 之前 + 独立 deferredAt 截止定时器(2×quiesce,防饿死)。
- **指示**:独立 chat:bg 事件(active/waiting/off + lastEventAt 绝对时间戳)+ SessionBgStates()
  拉取 + remote:resync 补 pull;绝不走 chat:status(封闭联合渲染不出;SessionStatuses 恒返
  idle 反向覆盖;App.tsx 会把运行中 tool 强制收口)。
- **SCM 门控收紧**:Stage/Unstage/Discard/Commit/Merge/AICommit 判据 isBusy → isBusy||epochOpen
  (waiting 期必须锁,否则最危险的静默期反而不设防)。
- **零事件后台任务**:idleTimeout(硬编码 5min)后随 harness 终止 = ACP 无法感知后台任务的
  协议事实,不是 bug;waiting 态 + 静默分钟数让用户可判断。
- OMP 零成本兼容:defer 模式下 idle 期零事件,IST 永不触发(死路径)。

## codebuddy 四轮评审过程(纯 ACP 通道)

- 自建 driver(/tmp/cbreview):独立 Go module 借 acp-go-sdk v0.13.5,实现 Client 全回调
  (SessionUpdate/RequestPermission/fs/terminal 桩),spawn `codebuddy --acp`,多轮 Prompt 逐轮
  传入 review 指令;repo 的 probe.go 先行验证过 codebuddy conformance(probe_codebuddy_test.go)。
- **round 1(REQUEST CHANGES,6 must-fix)**:M1 触发集漏 tool_call_update;M2 per-quiesce
  turn_id 轮转写坏历史(messageId 切两半 → 两行碎片,直击 §1.5);M3 chat:status 封闭联合
  (types.ts:133)/Sidebar 只认 prompting(:857)/SessionStatuses 恒 idle(:1538)三重硬证据;
  M4 bg_active 冻结与刷 lastActivity 数学等价(纯多余)+ idleTimeout 实为硬编码(chat.go:419)
  无配置项(v1 文案承诺了不存在的能力);M5 idle 期并发 Prompt 失败 → teardownLive 杀进程组 →
  后台 job 全丢;M6 finalize 原子性/收口路径/plan 污染。全部抽验属实。
- **round 2(APPROVE with changes,6 阻塞 A-F + 自我推翻)**:A 软收口不得清 timeline(否则
  upsert 全量覆盖丢前半段,前端 replace-merge 当场可见);B drainQueue dequeue-before-send,
  检查点必须在 dequeueDue 前 + 唤醒源 + 消息归属(插回队头);C 护栏判据须时间戳
  lastEpochEventAt 非布尔 + 覆盖 transient/fatal 双支 + IsAlive 复核;D **推翻自己 round-1 的
  Resume 抑制子项**(runner.go:181-188 已结构性丢弃重放;#79 RotateOnce 是合并边界非抑制开关;
  手工标志有泄漏面);E 6 收口全 emit off + closed 清条目 + silentMs→lastEventAt;F isBusy 门控
  (SCM 六处)被 epoch 绕开。关键论断逐条抽验(isBusy 门控行号、closed emit、Resume 抑制、
  RotateOnce 注释)全属实;其「行号整体+199」为并行开发快照偏移,不影响结论。
- **round 3(仍需改动,4 阻塞)**:#1 epochActive 若按 currentTurnID 前缀判,waiting 期(最危险
  时段)解锁 → 独立 epochID+epochOpen,只在硬收口清;#2 队列延迟唯一唤醒源(软收口计时器)在
  持续输出时被无限推后 = 饿死 → 独立 deferredAt 截止定时器;#3 lastEpochEventAt 刷新集合未定义
  (旁路心跳会无限续窗)+ 护栏不得 AND epochOpen(startTurn 已先硬收口,AND 即废);#4 waiting
  无 emit 点永不可达。另附状态矩阵终审(prompting×active 不可能等)与 chat:bg 洪泛节流、
  R8/R9 补记。全部成立,吸收为 v4。
- **round 4(APPROVE)**:#1-#4 逐条 PASS,无新阻塞;附实现期三钉:N1 waiting→active 回升
  emit(epoch 重开/续写时发);N2 deferredAt 取首次延迟时刻不重置;N3 护栏命中后清 currentTurnID
  让下个事件开新 epoch 自愈。已钉进定稿。

## 改了哪些文件

- 无仓库代码改动(纯设计 + 评审,用户明确「不做任何实现」)。
- /tmp/cbreview/{design.md,v4 定稿;main.go,driver;sess/,codebuddy 会话}——临时产物不入库。
- 本 worklog。

## 验证

- opencode 侧:reference 浅克隆源码通读(BackgroundJob/task.ts/acp/event.ts/acp/service.ts/
  runtime-flags.ts)+ 本机 1.18.25 二进制 strings 实证(OPENCODE_EXPERIMENTAL_BACKGROUND_
  SUBAGENTS ×2、TaskTool.notifyBackgroundResult/injectBackgroundResult、"Background task
  completed: ${…}")。
- 评审通道:driver 与 codebuddy 四轮对话全部经真 ACP(stdio JSON-RPC),每轮 stop=end_turn;
  codebuddy 引用的关键行号逐条在本仓库抽验(类型封闭/Sidebar dot/SessionStatuses/isBusy 门控/
  closed emit/Resume 抑制/RotateOnce/quiesce 相关),round-1 M3/M4、round-2 A/D/F、round-3 #1
  均实证成立;发现其行号基线偏移(并行开发快照)并在定稿标注。
- 设计自检:状态矩阵(prompting/idle/closed × active/waiting/off × 护栏)无矛盾组合。

## 下一步

- 实现按定稿 v4(/tmp/cbreview/design.md,需先落库到 docs/ 或随实现 commit 携带):切原子
  commit(epoch 字段+触发集 → 软/硬收口 → 护栏+队列 → chat:bg+前端 → SCM 门控 → 三端回归);
  R5(seq 先读后写非事务)独立 commit 先行;实现期三钉(N1-N3)写进代码注释。
- OPEN:opencode 旗标行为(R1)实验确认;idleTimeout 是否提为设置项(独立小改动)。
