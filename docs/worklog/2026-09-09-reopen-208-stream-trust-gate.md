# 2026-09-09 fix(chat): #208 重开——流式信任门补 tailStreaming + eventGap

## 起因

Issue #208 在 `3a1df6b` 后重开。重开跟评指出原实现只落地了定稿三条件中的 busy 单条件:

1. `statusBySessionRef` 是 effect 提交镜像,状态推送与 effect 提交之间存在窗口;
2. 定稿要求的 `tailStreaming`(尾部 agent/thought 仍有 streaming 标志)未实现;
3. PWA 断线场景的 `eventGapRef`(事件链断开后内存不再可信)未实现;
4. 需要先查 SQLite 分流:DB 有 agent 行则前端重拉/渲染问题;DB 无 agent 行则继续查 `persistTurn` 快照竞态。

## 取证分流(本机生产 DB)

对重开前最接近复现时间的完成 turn(2026-09-09 10:02:58,session
`616938fc-9c0f-41da-b772-0a2d9d2bfb44`)直接执行跟评要求的尾部查询:

```sql
SELECT seq, role, kind, turn_id, entry_key, length(content)
FROM messages
WHERE session_id='616938fc-9c0f-41da-b772-0a2d9d2bfb44'
ORDER BY seq DESC LIMIT 10;
```

结果最新行为:

```text
seq=1312 role=agent kind=agent_message_chunk
turn_id=7b6c8820-6436-4dd4-ba49-209917b6fb60
entry_key=msg:bf27e58a-1576-47b6-85d3-5e0541b8ab17:agent
length(content)=781
```

同 turn 的 thought/tool 行都在它之前。因此该复现分支里 **DB 已有最终 agent 行**,问题落在前端重拉信任判定,不是 `persistTurn/buildTurnItem` 缺尾;本次不新增后端快照竞态测试。若后续复现查得 DB 确实缺 agent 行,再按跟评要求另开 persist 时序任务。

## 改法

核心不变量按定稿执行:**内存比 DB 新 ⇔ 事件流未曾断开**。

- `sessionDrop.ts` 新增 `hasStreamingTail(items)`:只看尾部 8 项中的 agent/thought
  `streaming===true`。该标志由 `streamMerge` 的事件边界维护,不依赖 `chat:status`
  推送或 React effect 提交时序。
- `App.tsx` 新增 `itemsBySessionRef`,让稳定的 `openSession` callback 能同步读目标
  session 的当前缓存。
- `App.tsx` 新增 `eventGapRef`:
  - `remote:resync` 一到就把已加载/当前/已知 session 标记为 gap(PWA WS 断线不回放,内存可能缺尾巴);
  - 该 session 后续收到内容类事件(agent/thought chunk、tool call/update)时清除标记,证明事件链重新活着。
- 重拉门控改为:

  ```ts
  trustMemory = cachedItems != null
    && eventGap !== true
    && (targetBusy || hasStreamingTail(cachedItems));
  pullMessages = !loaded && !trustMemory;
  ```

  busy 状态镜像也改为在收到 `chat:status` push 时立即写入 ref,effect 只继续负责快照合并后的提交路径,进一步压缩状态延迟窗口。

效果:

- 桌面流式中,即使 prompting 推送晚到/丢失,只要事件已经重建出 streaming 尾巴,切回不信 DB 局部快照;
- turn 结束(idle)会收口 streaming,下一次 idle 切回仍走权威 DB,兼顾 #197 的分页 cursor 自愈;
- PWA 断线重连后 `remote:resync` 强制 DB 重载;重载后新到内容事件继续追加,不把可能缺口的内存当真相。

## 改了哪些文件

- `frontend/src/lib/sessionDrop.ts`:`hasStreamingTail` 纯函数。
- `frontend/src/lib/sessionDrop.test.ts`:streaming 尾部/窗口边界/ finalized 回归。
- `frontend/src/App.tsx`:items ref、event gap ref、status push 急切镜像、openSession 三条件信任门。
- `frontend/src/App.busy-switch-back.mount.test.tsx`:保留 3a1df6b 的 4 个场景,新增无状态推送、turn 结束、resync 强制 DB、resync 后续流 4 个场景。
- `docs/worklog/2026-09-09-reopen-208-stream-trust-gate.md`:本记录。

## 验证

- `bun test ./src/App.busy-switch-back.mount.test.tsx ./src/lib/sessionDrop.test.ts`:17 pass / 0 fail
  (mount 文件 8 pass,包含原 4 场景 + 新 4 场景;纯函数 9 pass)。
- `bunx tsc --noEmit`:0 错;`git diff --check`:干净。
- `bun run build`:通过(既有 chunk-size warning)。
- 状态对账回归:`sessionStatusMerge` 9 pass;#197 fork 分页 mount 2 pass。
- 全量 `bun test --isolate`:582 pass / 4 fail / 1 error。4 个失败均在既有
  `App.worktree-guard.mount.test.tsx`(真实 runtime binding 先于 mock 求值,旧 worklog 已记录),
  与本改动无关;本卡相关测试全绿。

### 三端覆盖

本次是纯打开/重拉逻辑,无 UI 面、无响应式样式变更:

- **桌面 GUI**:真 App → Sidebar → openSession mount 链路覆盖事件流切走/切回;
- **远程浏览器**:同一 binding/event 消费路径,`remote:resync` 分支经同一 App handler 覆盖;
- **PWA**:`remote:resync` 事件 gap 强制 DB、重载后内容续流的两个场景已专门覆盖。

未做实机长输出手工走查;建议用户在桌面/PWA 各跑一次「长回复输出中切走→等 5s→切回」与「锁屏跨越 turn 后回来」复核视觉不闪、不丢。

## 下一步

- 用户真机复验 #208 重开场景;若再复现,先执行跟评 SQL 并按 DB 有/无 agent 行继续分流。
- 后续若拿到 DB 缺 agent 行的复现,为 `Prompt 返回与 SessionUpdate 回调并发归并` 增加后端时序测试。
