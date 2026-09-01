# #184 repeat 队列条目 Send Now 立即到期(循环不撤销)

日期:2026-09-02
状态:完成(代码 + 测试)

## 起因

QueuePanel 的「立即发送」(Send Now / queue-interrupt,Zap 按钮)对**循环条目**(#111,`repeatEveryMs > 0`)的行为是错的:点击后循环被静默撤销。

## 根因

`frontend/src/App.tsx` 的 `interruptQueue` 对所有队列条目走同一条链路:

```
RevokeQueueItem(sid, id)          // 删行
→ InterruptAndSend(sid, text, …)  // 打断当前 turn + 手动发送
```

对 repeat 条目,`RevokeQueueItem` 把行从服务端队列删掉,`RepeatEveryMs / SentCount / ScheduledAt` 随行全丢 = **循环被撤销**。且即使不删行,手动 `InterruptAndSend` 也会**双发**:队列行还在,本 turn 结束的 tail drain 会把同一条再发一次。

## 改法

`interruptQueue` 取到 `item` 后增加分支(`frontend/src/App.tsx`):

- `item.repeatEveryMs > 0` → `await ChatService.ScheduleQueueItem(sid, item.id, Date.now())` 立即到期,然后 `return`——**不 revoke、不 InterruptAndSend**。
- 否则维持既有 `Revoke + InterruptAndSend` 链路,一字未动(含 `setErrorMessage(null)/setNotice(null)`、乐观 `prompting` 状态)。

语义要点:

- **「立即」= 跳过剩余等待,不是立刻打断**:busy 时本 turn 结束由后端 tail drain 发送(idle 时后端 `idle + due → send now` 路径立刻发)。两端都由后端既有逻辑承接,前端零新增编排。
- **循环完整保留**:发送成功后 `rescheduleRepeat` 按 #176 修复(70500f1)从真实发送时刻重锚 `now + interval`,`SentCount / maxSends` 计数不变,循环继续。
- **stop-intent 不被消费**:`ScheduleQueueItem` 非 stop 语义,不像 `InterruptAndSend` 那样清 stop intent——repeat 到期发送不该改变用户的停止意图。
- 失败路径与既有风格一致:`catch → setErrorMessage(extractErrMsg(e))`。

后端零改动(`ScheduleQueueItem / InterruptAndSend / queue.go` 均不动);#176 重锚语义(70500f1)未回改;Send Now 按钮文案/位置/样式零改动(i18n 零新增);queue snapshot 事件链照常。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | `interruptQueue` 增加 repeat 分支 + 注释说明(#184) |
| `frontend/src/App.queue-repeat-send-now.mount.test.tsx` | 新增:真实 App→ChatView→QueuePanel 接线 mount 测试 |

## 验证

新增 mount 测试(真实 App 组件 + binding spy,scaffolding 同 `App.tab-limit.mount.test.tsx`;会话经真实侧栏点击路径打开,队列快照经真实 `chat:queue` 订阅灌入):

1. **repeat 条目** send-now → `ScheduleQueueItem` 以 ≈now 调用(断言与点击时刻差 < 2s),`RevokeQueueItem` / `InterruptAndSend` 均不被调。
2. **普通条目** send-now → `RevokeQueueItem` + `InterruptAndSend` 照旧(revoke 严格先于 interrupt),`ScheduleQueueItem` 不被调。
3. 既有 App/QueuePanel 全部 mount 测试零回归(全量 `bun test --isolate` 通过)。

门禁:`bun test --isolate` 全绿;`bunx tsc` 过。

三端说明(§4.7):本次为纯行为分支,无 UI/样式/文案变化——三张脸共享同一份 `App.tsx` 逻辑,`interruptQueue` 的分支行为在三端一致(差异只可能来自宿主事件通道,而 binding 调用路径相同);QueuePanel 渲染零 diff。逻辑接线由 mount 测试走真实 App 树覆盖;桌面 GUI / 远程浏览器 / PWA 的渲染面无任何改动,无需各自回归。

## 下一步

- 无遗留。#184 可关闭(由 orchestrator 处置)。
