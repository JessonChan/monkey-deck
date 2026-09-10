# #213 Repeat 点 Send Now 整屏刷新感:Profiler 取证 + 渲染收敛

日期:2026-09-11
状态:进行中(取证完成,修复实施中)
任务:Task #29261(issue #213,流程 coder→fe-reviewer→APPROVE)

## 起因

QueuePanel 对 repeat 条目点「立即发送」(Send Now,#184 语义 = `ScheduleQueueItem(≈now)`)后,对话区出现「整屏刷新感」。逻辑正确、渲染面积过大。按 issue 要求先 React Profiler 定位重渲源,取证后再动手。

## 取证方法

临时探针(取证后已移除):真实 App 树 + `React.Profiler`(App / ChatView 两级)+ ChatRow/AgentMarkdown 渲染计数器(`__mdProbe`)+ scrollTop 写入栈追踪,在 happy-dom mount 测试里按后端真实事件时序回放一次 repeat Send Now:

```
click → ScheduleQueueItem(now)
→ chat:queue 快照 A(行 scheduledAt=now)      // ScheduleQueueItem 出站
→ chat:queue 快照 B(行出队)                   // drainQueue.dequeueDue
→ chat:status prompting                        // runPrompt 开 turn
→ user_message_chunk(drain 落地的用户消息)
→ agent_message_chunk(回复开始)
→ chat:queue 快照 C(rescheduleRepeat 重挂行)  // turn 尾
→ chat:status idle                             // turn 结束
```

两个场景:A = 贴底(默认);B = 上翻到 scrollTop=600(锚点模式)。种子 12 对 user/agent 消息(现实间隔,每条间隔 >1ms)。

## 取证结果(修复前)

| 阶段 | App 提交 | ChatRow 重渲 | markdown 重解析 | ChatView max ms |
|---|---|---|---|---|
| queue 快照 A(scheduled→now) | 1 | 0 | 0 | 0.4 |
| queue 快照 B(出队) | 1 | 0 | 0 | 0.2 |
| **status→prompting** | 1 | **24(全部可见行)** | **12(全部 agent 行)** | 4.5 |
| drained user msg | 2 | 2 | 1 | 1.5 |
| agent chunk | 2 | 1 | 1 | 0.6 |
| queue 快照 C(重挂) | 1 | 0 | 0 | 1.1 |
| **status→idle** | 2 | **26(全部可见行)** | **13(全部 agent 行)** | 5.0 |

三嫌疑逐一裁决:

1. **虚拟列表锚点重算+强制滚底:锚点机制本身无罪,但揪出一个 id 碰撞真 bug**。锚点模式下 scrollTop=600 穿越整个事件爆发全程不变;唯一一次跳变(600→60)复现在「多条 user 消息同一毫秒落库」:streamMerge 给 user item 的 id 是 `u-${Date.now()}`(协议提供了 messageId 却不用,违反 §5.3「尊重数据源」),同毫秒 id 碰撞后 `restoreScroll` 的 `findIndex` 命中第一条同名行 → 锚点恢复到错误位置 → 整屏内容平移 = 「刷新感」的直接来源之一。drain 发送路径本身没有强制滚底(滚底只在用户主动 send/enqueue 的 `scrollToBottom()`)。
2. **queue 双快照:无罪**。三次快照各 1 commit,0 行重渲,单次 ≤1.5ms——快照不是渲染面积问题,无需合并。
3. **status 连锁:主犯**。两个放大器:
   - `forkBusy={props.status === "prompting"}` 传给**所有** ChatRow(含 `canFork=false` 的行),status 翻转一次 = 破掉全部可见行的 memo → 每行 ReactMarkdown 全文重解析(修后预期 ≤1 行);
   - turn 结束 idle 收口(App.tsx `chat:status` handler)对 `cur.map(...)` **无条件** `{...it, streaming:false}` 新建 agent/thought item 对象——早已 `streaming:false` 的历史行也换新身份 → 又一次全部可见行 memo 破裂 + markdown 重解析。

## 改法(对应裁决)

| 文件 | 改动 |
|---|---|
| `frontend/src/components/ChatView.tsx` | ① `forkBusy` 只传给 fork 行(`rowCanFork ? prompting : false`),status 翻转最多重渲 1 行;② `AgentMarkdown` memo 化(text/sessionId/streaming 浅比较),残留重渲不再重解析 markdown |
| `frontend/src/App.tsx` | idle/error/closed 收口 map 改为「值不变即保身份」:未 streaming 的 agent/thought 与非中间态 tool 原样返回,全部不变时返回原数组 |
| `frontend/src/lib/streamMerge.ts` | user item id 从 `u-${Date.now()}` 改为 `u-${ev.messageId || Date.now()}`(对齐 agent 分支既有形态),锚点 id 稳定且免同毫秒碰撞 |

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/components/ChatView.tsx` | ① `rowCanFork` 提取,`forkBusy` 只传 fork 行(其余行恒 false,status 翻转不再破 memo);② `AgentMarkdown` 套 `memo`(text/sessionId/streaming 浅比较),残留重渲不再触发全文 markdown 重解析 |
| `frontend/src/App.tsx` | `chat:status` idle/error/closed 收口:map 改「值不变即保身份」,仅真正 streaming/中间态的 item 换新对象;全部不变时返回原数组 |
| `frontend/src/lib/streamMerge.ts` | user item id `u-${Date.now()}` → `u-${ev.messageId \|\| Date.now()}`(对齐 agent 分支既有形态) |
| `frontend/src/lib/streamMerge.test.ts` | 新增:#213 user id 基于 messageId 的回归测试(RED 实证:stash 修复后转红) |
| `frontend/src/components/ChatView.virtual.mount.test.tsx` | 新增:#213 Send Now 事件爆发(2× 状态翻转 + queue 快照 + 追加 drain 消息)全程上翻位置不动 + FAB 常驻的锚点契约测试 |

## 验证

**修复后同探针复测**(同一事件时序、同一场景):

| 阶段 | rows 重渲(修复前→后) | markdown 重解析(前→后) | ChatView max ms(前→后) |
|---|---|---|---|
| status→prompting | 24 → **0~1** | 12 → **0** | 4.5 → **0.3~0.4** |
| status→idle | 26 → **1**(末回合挂 duration,合法内容变化) | 13 → **1**(同上) | 5.0 → **0.5~1.0** |
| queue 快照 ×3 | 0 → 0(原本就干净) | 0 → 0 | ≤1.5 → ≤1.5 |
| drained user msg / agent chunk | 2/1 → 0~2 | 1 → 0~1 | ≤1.5 → ≤1.5 |

锚点模式 scrollTop=600 全程保持(修复前唯一一次 600→60 跳变由 id 碰撞引入,已修)。Send Now 一次点击的渲染面积从「两次全窗 markdown 重解析(每次 12-13 条、阻塞 4.5-5ms)」收敛为「≤2 条合法内容行的最小重渲」,全部 commit ≤1.5ms。

**门禁**:
- `bunx tsc --noEmit` 0 错误;`bun run build` 通过(仅既有 chunk >500kB 警告,与本次无关);
- 新增 streamMerge 回归测试 RED/GREEN 双态实跑(stash `streamMerge.ts` 修复 → 该测试转红,恢复 → 全绿);
- `bun test --isolate` 前端全量:603 pass / 4 fail——4 条失败全部位于 `App.worktree-guard.mount.test.tsx`(#199),stash 本次全部改动后在干净 HEAD 上同样复现(同 4 条),系既有失败与本卡无关;ChatView.virtual 12/12(含新增爆发契约测试)全绿;
- 探针(临时插桩 + `App.sendnow-profiler.probe.test.tsx`)取证后已全部移除,`git diff` 复核仅剩上述修复;
- 后端零改动(不涉 Go 门禁);bindings 未受影响(无导出签名变化)。

### 三端说明(§4.7)

本次为纯渲染收敛(组件 memo / prop 作用域 / item 身份),无布局、样式、文案、DOM 结构变化,无 `isRemoteClient()` 分支、无新增依赖;三张脸共用同一 React 树,行为一致。渲染行为由真实 App/ChatView mount 测试覆盖;桌面 GUI / 远程浏览器 / PWA 渲染面零 diff,无需各自回归。

## 下一步

- 流程走 fe-reviewer,APPROVE 后本卡 completed-ready。
