# 2026-09-09 #208r 切回丢尾取证分流与 65651e4 差距审计(续作卡)

> **结论置顶:已由 65651e4 修复,本卡补取证+测试。** 取证判定**窗 2(前端重拉信任路径)**;六场景矩阵审计**无缺格**;15ad74e pin(T9/T10)已覆盖用户复现路径与 idle 变体,**不新增测试、不改代码**——本卡唯一产出即本 worklog(15ad74e 落库时尚无 worklog,在此补齐)。

## 起因

#208 重开(2026-09-09)。前卡 MON-735 于 15:02 把测试 pin 落 main(`15ad74e`),15:20 死于 429 限流,取证结论散落在 commit message 里、没有 worklog。本卡为续作:补取证分流、65651e4 门控差距审计、窗判定与工作日志。

## 任务一:取证分流(判定窗 2)

### 数据源与证据链

- **真实生产 DB**:`~/Library/Application Support/Monkey Deck/monkey-deck.db`(注意目录名带空格;小写 `monkey-deck/` 目录下是另一份陈旧数据,勿混淆)。
- **快照**:`/tmp/md-forensics-29234/live.db`(602MB,前卡 15:06 复制,本卡复用);同目录 `monkey-deck.db`(106MB,15:00)是**另一份陈旧数据集**(锚点 session 0 行),非生产镜像。
- 真机 DB 与快照内容一致(锚点 session 均 1312 行,尾部相同)。

### 锚点 turn 尾部 10 行原始行(复现 turn,session `616938fc-9c0f-41da-b772-0a2d9d2bfb44`)

```sql
SELECT seq, role, kind, turn_id, entry_key, length(content)
FROM messages
WHERE session_id='616938fc-9c0f-41da-b772-0a2d9d2bfb44'
ORDER BY seq DESC LIMIT 10;
```

```text
1312|agent|agent_message_chunk|7b6c8820-6436-4dd4-ba49-209917b6fb60|msg:bf27e58a-1576-47b6-85d3-5e0541b8ab17:agent|781
1311|tool|tool_call|7b6c8820-6436-4dd4-ba49-209917b6fb60|call_e0f0a12673554878a58e348a|1300
1310|tool|tool_call|7b6c8820-6436-4dd4-ba49-209917b6fb60|call_37318fd0797d4ce6af67b900|3261
1309|tool|tool_call|7b6c8820-6436-4dd4-ba49-209917b6fb60|call_b4ce4173e7294e47b7bfe19c|1707
1308|agent|agent_message_chunk|7b6c8820-6436-4dd4-ba49-209917b6fb60|msg:3d27f760-9e28-48b8-93cb-82f96a2eb5d3:agent|73
1307|thought|agent_thought_chunk|7b6c8820-6436-4dd4-ba49-209917b6fb60|msg:3d27f760-9e28-48b8-93cb-82f96a2eb5d3:thought|10138
1306|user||||7
1305|agent|agent_message_chunk|f1e50690-11b6-44f2-b7e8-c5514061edaf|msg:24bb0b90-d642-4483-8bd2-17bbe30dcaca:agent|1061
1304|thought|agent_thought_chunk|f1e50690-11b6-44f2-b7e8-c5514061edaf|msg:24bb0b90-d642-4483-8bd2-17bbe30dcaca:thought|6033
1303|tool|tool_call|f1e50690-11b6-44f2-b7e8-c5514061edaf|call_cfa7a0ce4bb64277b156c1e6|2225
```

锚点 turn(seq 1307–1312,起始 10:02:58)**尾部有完整 agent 行**:seq 1312,len 781,entry_key 与 turn_id 匹配,与 issue 描述"数据库里实际有"吻合 → **窗 2**。全部 6 行 created_at 同为 10:02:58(turn 末批量收敛可见,见下节结构)。

### 复现窗全量扫描(加固判定)

- 锚点 session 最近 15 个 turn(2026-09-03 → 09-09,覆盖复现窗与 idle 变体):**全部以 `agent_message_chunk` 行收尾**,零缺尾。
- 整库 09-09 当日全部 session 逐 turn 末行扫描:唯一非 agent 收尾是 `55d9bb4d`/turn `96a2eb20`(codebuddy harness,14:11:25,末行 tool_call)。该 turn 无完成迹象(prompted 14:10:23,末行 14:11:25,快照 15:06),且同 session 在 09-02/09-06/09-08 还有 3 个同形态 tool 收尾 turn——是该 session/harness 的**用户停止/工具收尾常态**,不是 #208 签名 session(其 thought/agent 行均在库),**不构成窗 1 证据**。
- 全 session 历史仅 4 个非 agent 收尾 turn,全部停在 2026-08-28(2 个 plan 类合法收尾 + 2 个八月底旧 turn),远在复现窗外。

### 结构佐证(窗 1 为何不可能对完成 turn 发生)

`internal/chat/turnpersist.go`:持久化 = 1s 防抖增量 flush(#125)+ **turn 末 reconcile**(`persistTurn`,`ls.mu` 内快照 timeline + `persistMu` 串行 upsert,幂等收敛)。且 `runPrompt` 中 **persistTurn 严格先于 idle emit**(`chat.go:2659` → 成功/取消路径的 `emitStatus(idle)` 在其后;`SendAndWaitSync` 同序 2537→2564)⇒ 前端收到 idle 时刻 DB 必为 final 全量。"turn 结束 idle 后切走切回"变体重拉必完整。

**判定:窗 2(前端重拉/信任路径),窗 1(persistTurn/buildTurnItem 快照缺尾)在复现窗内无实例,不加后端竞态测试。**

## 任务二:65651e4 差距审计(定稿六场景矩阵,无缺格)

逐格核对 issue #208 定稿(2026-09-02 参考实现注释)的实现位与测试位:

|格|场景|实现位|测试位|
|---|---|---|---|
|1|桌面 streaming 中切走切回(busy)|`App.tsx:1244-1250` trustMemory 命中→跳过重拉|T1/T2/T4 字面钉死;**T9** 钉 busy 唯一信号形态(tool-only 尾,反向证明:删 `targetBusy` 恰好挂 T9)|
|2|桌面 turn 结束后切回(idle 无 streaming)|idle 收口 streaming→trustMemory 失败→权威 DB(persist 先于 idle)|**T6**(完成后切回走 DB)+ **T10**(切走期间 turn 结束→切回 DB 愈合,且 turn-end heal 仅 selected 触发,反向证明:删 selected 守卫恰好挂 T10)|
|3|PWA 锁屏中 turn 结束,回来(gap+idle)|`remote:resync` 标 gap(loaded+selected+known,`App.tsx:897-903`)→trustMemory 必败→DB;`syncSessionStatuses` 对账陈旧状态(:918)|无独立用例;由 **T7 强形式**(gap 压过 busy+streaming 尾,信内存条件更苛刻仍走 DB)∧ T6/T10 idle 语义**合取覆盖**——门是纯合取式,强形式为真则本格为真|
|4|PWA 锁屏回来 turn 仍在进行(gap+busy)|gap→DB 局部快照;gap 后内容事件清 gap(`App.tsx:388-393`,四种内容类 kind 全清)并续流|**T7** + **T8** 字面钉死|
|5|首次打开(无缓存)|`cachedItems==null`→trustMemory 必败→DB|各场景首开 pull 断言(T2 `loadCount=1`)|
|6|turn 结束后 PWA 断线错过 idle(gap+陈旧状态)|同格 3 + 状态快照对账|同格 3 合取覆盖|

规格细节逐项核对:`statusBySessionRef` push 急切镜像(:728,eager 写)✓;`hasStreamingTail` 尾部 8 项 agent/thought streaming(`sessionDrop.ts:27-32`,streamMerge 维护、与 status 时序解耦)✓;skip 的 session 不进 `loadedSessionsRef`(:1251 仅 pull 时加入),靠 turn-end healing(selected-only、macrotask 延迟,:821-828)或下次 idle 切回权威 DB 恢复 ✓。

**未覆盖格:无。** 观察项(非缺格):格 3/6 没有字面独立用例,靠 T7 强形式合取覆盖;按 §5.3 不堆近重复用例,保持现状。

## 任务三分支

窗 2 + 审计无缺格 → 按分支规则:15ad74e pin 已覆盖用户复现路径(用户签名="输出中切走切回丢最后一条,只剩 tool/thinking"= T2 漂移路径;busy 无 streaming 标记形态 = T9;idle 后切走切回变体 = T10),**不新增测试,零代码改动**。

## 改了哪些文件

- `docs/worklog/2026-09-09-switch-back-forensics-208r.md`:本记录(唯一变更;`App.tsx`/后端零 diff)。

## 验证

- `bun test ./src/App.busy-switch-back.mount.test.tsx ./src/lib/sessionDrop.test.ts`:**19 pass / 0 fail**(3a1df6b 4 场景 + 65651e4 4 场景 + 15ad74e pin T9/T10 = mount 10;纯函数 9)。
- 全量 `bun test --isolate`:**586 pass / 4 fail / 1 error**,4 fail + 1 error 全部在既有 `App.worktree-guard.mount.test.tsx`(真实 runtime binding 先于 mock 求值,旧 worklog 已记录的既有失败,与本卡无关)。另:`App.cmd-digit-tabs` / `App.panel-collapse` 在多文件并行时偶发串扰失败,**单文件重跑全绿**(happy-dom 跨文件全局态串扰,既有 flaky,与本卡无关)。
- `go build ./...` + `go vet ./...`:干净;`go test ./...`:exit 0,15 包全 ok。
- `bun run build`(tsc && vite build):零错误(仅既有 chunk-size warning)。
- 三端说明:本卡零代码改动(纯取证+审计+文档),无 UI/样式/协议面变化,不触发三端回归;取证覆盖的是桌面真实 DB 路径,mount 测试已覆盖桌面挂载链路与 remote:resync(PWA)分支。

## 下一步

- 交 fe-reviewer 复核,APPROVE 后停在 completed-ready(不 push、不关 issue)。
- 用户真机复验 #208 场景;若再复现:先跑本 worklog 的尾部 SQL 分流;若出现 DB 缺 agent 行(窗 1)再开 persistTurn 快照时序任务(测试风格参照 `fork_lineage_test.go`)。
- 环境备注:worktree 会话恢复会丢 gitignored 产物,需按序恢复 `bun install` → `wails3 task bindings` → `bun run build`,mount 测试才能跑(依赖生成的 bindings 源文本解析)。
