# #184 审卡落档:repeat 队列条目 Send Now 立即到期 前端面(APPROVE)

- 日期:2026-09-02
- 任务:Task #28947(review #28946)
- 关联:#184(需求)、Task #28946(实现,commit `252c3dd` + worklog `e1aa755`)
- 基线:main 顶端 `332d053`;main HEAD `e1aa755`(两提交即评审对象)
- 结论:**APPROVE**(completed-ready;不 push、不关 issue,按任务流程)

## 评审范围与改动面

`252c3dd` 仅两个文件:`frontend/src/App.tsx` 单 hunk 纯插入(`interruptQueue` repeat 分支
+ 注释,15+/0-)+ 新增 `App.queue-repeat-send-now.mount.test.tsx`(216 行);`e1aa755` 仅
worklog。区间 `332d053..e1aa755` 合计 3 文件 289+,零删除。

## 清单逐条核验(diff 级)

1. **repeat 分支语义正确**(`App.tsx:1422-1429`):`(item.repeatEveryMs ?? 0) > 0` →
   `await ChatService.ScheduleQueueItem(sid, item.id, Date.now())` → `return`。不 revoke、
   不 InterruptAndSend、不手动发文本——行不删,循环状态(`repeatEveryMs/sentCount/
   scheduledAt`)随行保留,tail drain 不会把同一条再发一次(无双发)。分支位置正确:
   在 `item` 查找之后、正常链路状态突变之前,`return` 确认换分支(无「加了分支忘了走」)。
2. **正常链路一字未动**:diff 纯插入(15+/0-);`App.tsx:1430-1437`
   (`setErrorMessage(null)/setNotice(null)` + 乐观 `prompting` + `RevokeQueueItem` →
   `InterruptAndSend(sid, item.text, item.attachments ?? [])`)与改动前逐字节一致。
3. **后端零改动**:区间 diff 仅 App.tsx + 测试 + worklog;`internal/chat/queue.go`、
   `ScheduleQueueItem`、`InterruptAndSend` 均未触碰。
4. **#176 重锚未回改**:70500f1(`rescheduleRepeat` clamp `now+interval`)不在区间内,
   后端 `SentCount/maxSends/RepeatEveryMs` 结构与 `SetQueueItemRepeat` 原样;QueuePanel 的
   repeat 展示(`Repeat` 徽标 / 间隔文案,324/547/614/621 行)未触碰。
5. **测试 + 门禁**:新增 mount 测试覆盖 repeat send-now;全量 `bun test --isolate` 537
   pass / 0 fail(75 files,7849 expect),`tsc --noEmit` exit 0。
6. **Send Now 按钮零改动**:`QueuePanel.tsx` 不在 diff;`queue.interrupt` 文案 key、
   `data-testid="queue-interrupt"`、样式类原样;i18n 零新增。

## 「类型补丁」反模式扫(逐消费端验证运行时行为)

- **`repeatEveryMs` 全链路有人消费**:Go `QueueItem.RepeatEveryMs`(json tag
  `repeatEveryMs`,`internal/chat/queue.go:68`)→ `emitQueue` 快照 → 前端 `chat:queue`
  订阅 → `types.ts:199 QueueItem.repeatEveryMs` → `App.tsx:1422` 真实读取并决定分支。
  非死字段。
- **`ScheduleQueueItem` 绑定签名对齐**:Go `ScheduleQueueItem(sessionID, itemID string,
  scheduledAt int64)`(`internal/chat/queue.go:273`)↔ 前端 `ScheduleQueueItem(sid,
  item.id, Date.now())`,三参类型/顺序一致。
- **后端语义与注释相符**:`ScheduleQueueItem` 落库 `ScheduledAt=now` → `armQueueTimer` +
  `emitQueue` → `at<=now && !isBusy` 立即 `drainQueue`;busy 时由既有 turn tail drain 承接;
  发送后 `rescheduleRepeat` 按 #176 重锚——与 App.tsx 注释、worklog 语义逐条吻合。
  前端零新增编排,符合「胖后端」(§1.7)。
- **repeat 分支不置乐观 `prompting`**:正确设计而非遗漏——busy 时发送发生在 tail drain
  (非立即),假置 prompting 会错;真实状态由后端事件回流。worklog 已显式论证。

## 测试断言质量(锚定值,非字段存在)

- repeat 用例:`schedule` 恰 1 次,断言锚定值 `sid=="s1"`/`id=="qr"`/`|at-before|<2000ms`,
  `revoke`/`interrupt` 均 0 次。
- plain 用例:`revoke` toEqual `[{sid,id}]`、`interrupt` toEqual `[{sid,text:"hello"}]`,
  `schedule` 0 次。
- 走真实 App→ChatView→QueuePanel 接线(真实侧栏点击开 session、真实 `chat:queue`
  handler 灌快照、真实按钮 selector `[data-testid=queue-interrupt]`),非直呼函数。
- nit(不阻塞):注释称「revoke 严格先于 interrupt」但 210-211 行仅做 truthy 检查,未断言
  数组时序;顺序实际由未改动代码的顺序 `await` 保证,且 plain 链路本就是既有行为。

## 复验(基线 `e1aa755`,原始输出)

- `bun test src/App.queue-repeat-send-now.mount.test.tsx` → **2 pass / 0 fail**(10 expect)。
- `bun test --isolate`(全量)→ **537 pass / 0 fail**(75 files,7849 expect() calls)。
- `npx tsc --noEmit` → **exit 0**(0 error)。
- 环境备注:本评审 worktree 需先 `bun install` + `wails3 generate bindings -clean=true -ts -i`
  (gitignored 生成物,缺失时报 `Cannot find module '../bindings/...'`——mock 按 resolved
  path 拦截仍需真实模块可解析);与上一张审卡(#180)的环境踩坑一致,非代码缺陷。
  react-resizable-panels 的 `collapsedSize` 等 prop 警告为既有 mock shim 噪音,全量套件
  各 mount 测试同样出现,与本改动无关。

## 三端说明(§4.7)

纯行为分支,无 UI/样式/文案/组件结构改动;三张脸共享同一份 `App.tsx` 逻辑,binding 调用
路径一致,`interruptQueue` 分支行为三端同源。QueuePanel 渲染零 diff,响应式断点/远程守卫
(`__mdRemote`)/WS 事件通道(`remote:resync`)均无新增回归面;后端能力语义已单次核实
(`ScheduleQueueItem` 实现),不重复三端验证。

## 结论

六项清单逐条达标,红线零违反,类型补丁扫描通过,测试锚定值到位,复验全绿。**APPROVE,
停 completed-ready。**

## 改了哪些文件

- 新增:`docs/worklog/2026-09-02-repeat-send-now-review-184.md`(本文件,单文件单提交)

## 下一步

- 无。等待人工 push / 关 issue 决策。
