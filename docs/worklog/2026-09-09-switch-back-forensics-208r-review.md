# 2026-09-09 #208r 全卡复核记录:取证 worklog(befdcef)+ 测试 pin(15ad74e)——APPROVE

> **结论:APPROVE。** 两笔产出均通过反相核实;完成结论「已由 65651e4 修复,本卡补取证+测试」成立;本审卡零代码改动,唯一产出即本 worklog。

## 审什么

前卡 #29232 落 main 两笔:15ad74e(67 行 `App.busy-switch-back.mount.test.tsx` 增量,T9/T10)+ befdcef(90 行取证 worklog)。按核查清单逐项反相核实,不信叙事,以 main 内容 + 本机实测为准。

## 核查结果

### ① pin 真实钉死 —— 通过

- **T9**(busy + tool-only 尾,无 streaming 标记):锚定值断言——`loadCount("s1")` 恒 1(不重拉)、`live-tool` 在、`db-history` 不在;busy 状态镜像是唯一门信号,正对用户复现路径「输出中切走切回」的信号形态。
- **T10**(切走期间 turn 结束 → 切回):两段锚定——away 期间 background idle 不触发 heal 重拉(`loadCount` 恒 1,钉 selected-only 守卫);切回后 `loadCount=2`、`db-history` 在、`away-live-tail` 不在(权威 DB 愈合重建尾)。idle 变体覆盖成立。
- **无重复无矛盾**:文件共 10 mount 场景,1-4 为 3a1df6b 既有、5-8 为 65651e4 既有(streaming 尾门控 / 完成走 DB / resync gap / gap 后续流),T9 的「busy 是唯一信号」与 T10 的「非 selected 不 heal + idle 切回走 DB」均是新形状;`sessionDrop.test.ts` 9 纯函数测试与 T9/T10 无交集无矛盾。
- **本机实跑**:`bun test App.busy-switch-back.mount.test.tsx sessionDrop.test.ts` → **19 pass / 0 fail**(42 expect)。

### ①b 反向证明抽查(本审卡实测,非转述)—— 通过

- 变异一:删 `(targetBusy ||)`(App.tsx:1247)→ **恰好 T9 fail,9 pass**。
- 变异二:删 turn-end heal 的 `selectedSessionIdRef` 守卫(App.tsx:821-824)→ **恰好 T10 fail,9 pass**。
- 两处变异后均已还原(`git status` 干净)。commit message 的反向证明主张属实。

### ② 全量回归 —— 通过(零回归)

- 9 个 `App.*.mount.test.tsx` 全量批次:**38 pass / 6 fail**,6 fail 与基线在案逐一对应:worktree-guard 4 fail + 1 unhandled error(隔离单跑同样 4+1,既有环境性,真实 runtime binding 先于 mock 求值,旧 worklog 已记录)、cmd-digit-tabs 1 fail / panel-collapse 1 fail(隔离单跑分别 4/0、5/0 全绿,happy-dom 跨文件共享态批次 flaky)。
- `bun run build`(tsc && vite build):exit 0,仅既有 chunk-size warning。
- 环境备注:worktree 会话恢复再次清掉 gitignored 产物,按 `bun install` → `wails3 task bindings` 顺序恢复后可跑(与被审 worklog「下一步」的环境备注一致,已再证)。

### ③ worklog 反相核实 —— 通过

- **窗 2 × 三条件门自洽**:65651e4 门 = `cachedItems != null && 无 gap && (busy || streamingTail)`(App.tsx:1244-1250 实读命中)。窗 2 判定(前端重拉/信任路径,DB 完整)与门语义一致:busy 侧信任内存(T9 钉),idle 侧重拉权威 DB 且 persistTurn 先于 idle(T10 钉愈合);DB 缺尾(窗 1)若为真则 idle 侧也会丢,取证证明 DB 不缺尾 → 判窗 2 是唯一自洽分支。
- **六场景矩阵抽核 5 格**(行号逐一实读命中,超出 ≥3 格要求):格 1(trustMemory :1244-1250 + T9)、格 2(T6+T10 + heal selected-only/macrotask :821-828)、格 3(resync 打 gap :897-903 + syncSessionStatuses :918 + T7 强形式)、格 4(内容事件清 gap :387-394 + T7/T8)、格 5(cachedItems==null 必拉 :1245/1248 + 各场景首开 loadCount=1)。规格细节:hasStreamingTail(sessionDrop.ts:27-32,尾部 8 项窗口)、eager 状态镜像(:728)、skip 不进 loadedSessionsRef(:1251)均属实。「格 3/6 无字面独立用例、由 T7 强形式合取覆盖」的观察项定性(非缺格)与 §5.3 精神一致。
- **证据链完整在文**:生产 DB 路径(含空格目录名警示)、快照路径与两份 DB 辨伪、锚点 SQL、尾部 10 行原始行(seq 1312 len 781 尾部 agent 行)、复现窗 15 turn + 全库当日扫描、4 个历史非 agent 收尾 turn 的排除论证——链条可独立重放。

### ④ 范围判定 —— 通过

两笔 commit 触面:`15ad74e` 仅测试文件、`befdcef` 仅 docs,`App.tsx`/后端零 diff。窗 1 未触发 ⇒ persistTurn/turnpersist.go 不动是**正确分支结论**而非缺漏;后端时序主张(chat.go:2659 persist 先于 idle emit)属 Go 侧事实,本审卡不复核 Go 实现,但其前端可观测推论已被 T10 实测钉住。worklog 结论置顶「已由 65651e4 修复,本卡补取证+测试」与任务要求措辞一致。

### ⑤ 分支契约 —— 本审卡遵守

本审卡 worklog 提交落在 workspace 预建的本卡规范分支 **`agent/fe-reviewer/825384b5`**(worktree `825384b5` 的 checked-out 分支),未自建任何带后缀分支(前卡 MON-737 教训)。

## 改了哪些文件

- `docs/worklog/2026-09-09-switch-back-forensics-208r-review.md`:本记录(唯一变更)。

## 验证

见 ①②③ 各节;全部为本机实跑:目标 19/19、变异抽查 2/2 精确命中、全量 38 pass/6 fail(全基线)、隔离重跑全绿、build exit 0。变异与产物还原后 `git status` 干净。

## 下一步

- 停 **completed-ready**:不 push、不关 issue、不再派卡。
- 用户侧动作不变(沿用被审 worklog):真机复验 #208;再复现先跑其尾部 SQL 分流,窗 1 才开 persistTurn 时序任务。
