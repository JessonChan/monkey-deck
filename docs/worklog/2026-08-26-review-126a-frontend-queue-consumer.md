# 2026-08-26 Review:#126A 前端:队列退化事件消费者(d6f6ad3)

复审对象:main 上 `d6f6ad3`(refactor(frontend),#126A 三连 commit 的前端段)。
Frontend reviewer 视角。后端两段(`1b9262a` store / `a622a87` chat)已由
backend review 覆盖(见 `2026-08-26-review-126a-server-side-queue.md`,其明确
声明「前端(d6f6ad3)不属本次 review 面」)——本条补上该面。

任务指定重点:双轨残留 / chat:queue 消费 / resync 对账 / 乐观更新竞态 /
QueuePanel props 不回归。

## 结论:PASS(1 处注释缩进收尾已修,余为 note)

## 逐项核验(按任务重点)

1. **双轨残留——零残留**:
   - `setQueueBySession` 全仓仅两处:chat:queue 事件 handler(App.tsx:660,
     全量覆盖 + `items ?? []` 归一)与 `evictSessionCache` 的 drop(1588)。无任何
     本地增删改路径。
   - 旧队列机构已删净:`drainSession`/`armScheduleTimer`/`userStoppedBySessionRef`/
     `drainingBySessionRef`/`scheduledTimersRef`/`drainSessionRef` 全仓 0 引用;
     chat:status handler 里的 drain 触发已移除;popout 快照不再打包/还原 queue
     (producer 1803 起 & snapshot effect 双侧对齐)。
   - `queueBySessionRef` 保留但只读(interrupt/revoke 查条目),render-time 同步
     (`ref.current = state`)与 selectedSessionIdRef/sessionsByProjectRef 等 8 处
     既有模式一致。
2. **chat:queue 消费——成立**:
   - 订阅挂在 boot effect(首个 effect,先于 popout effect 触发的 OpenSession,
     声明序保证初始快照不丢);cleanup 有 offQueue;effect deps 已同步移除
     drainSession。
   - wire 对齐:Go `QueuePayload{sessionId,items}` / `QueueItem{id,text,
     attachments,omitempty,scheduledAt}` 与 TS `types.ts` 镜像逐字段核对一致
     (attachments 的 `omitempty` → TS `attachments?: Attachment[]` + 消费侧
     `?? []`);`acp.Attachment` 五字段镜像齐(镜像省略 text/uri——
     buildAttachments 从不产出,无损)。绑定签名与本 worktree 现生成的
     `wails3 generate bindings -ts` 产物核对一致(5 个 CRUD 方法全数出现)。
   - 后端行为与前端注释互证:Enqueue 不 drain 不 arm 定时器(「主动入队永不
     抢跑」成立);Schedule/Reorder 的「idle + 到点 → 立即发」确实后端化
     (queue.go 275-277 / 310 附近 `go drainQueue`)。
3. **resync 对账——结构上成立**:
   - `remote:resync` handler 对已加载的选中 session 强制重开
     (loadedSessionsRef.delete + openSessionRef)→ OpenSession 无条件推队列权威
     快照。
   - 后台 tab 的镜像在 WS 断连期间可能落后,但 `queue` 派生切片**只渲染选中
     session**(App.tsx:359,无 tab 角标等其它消费面),且切 tab 必经
     openSession → 无条件 `ChatService.OpenSession`(921)→ 镜像在可见前自愈。
     陈旧镜像没有用户可见面。桌面端(事件通道常活)与 popout(各自 OpenSession)
     同理覆盖。
4. **乐观更新竞态——设计消解,逐 callback 核验**:
   - enqueue/sendMessage(prompting 分支)/edit/schedule/reorder:纯 binding,
     失败只 setError,无本地乐观变更;队列真相只经事件回流。
   - revokeQueue:后端成功才回填 composer(失败条目仍在队,防同文双份)——
     与注释声明一致。
   - interruptQueue(见 notes):乐观置 prompting 与「Revoke 成功但
     InterruptAndSend 失败 → 消息丢」两处,均与 #126A 前行为逐行等价(git
     show 核对旧实现:同样先移除、同样失败只 setError)——非回归。
5. **QueuePanel props 不回归——成立**:
   - Props 接口逐字段未变(queue/onInterrupt/onRevoke/onEdit/onSchedule/
     onReorder);组件内 0 处引用已删除的 mentions/images/audios 字段,仅渲染
     id/text/scheduledAt;async callback 赋给 void 返回 prop 是 TS 合法协变。
   - #126B 移动端适配(≤768px CSS / move 按钮 / aria-label)原样;
     6 个 QueuePanel mount 测试文件全绿。
6. **类型补丁反模式检查——无**:新类型逐消费端确认——`QueuePayload` →
   事件 handler;`QueueItem.attachments` → interruptQueue 读出喂
   InterruptAndSend(后端测试锚定 `promptAttachmentsAt(1)[0].Path=="a.go"`);
   `Attachment` → buildAttachments 产出端。无「字段存在但无人读」。

## 发现与处置

- **[fixed] F1(外观,d6f6ad3 引入)孤儿注释缩进错位**:chat:status handler 里
  移除 drain 触发块时,替代注释留在 8 空格缩进、漂浮在 `if (idle)` 块闭合后
  (读起来像在块内)。归位到 handler 语句级 6 空格。零行为变化。
- **[note] interruptQueue 两步失败语义**:Revoke 成功 + InterruptAndSend 失败
  (spawn 失败等)→ 条目已出队且未发出,文本仅存输入历史(↑ 可找回)。与
  #126A 前行为等价,不改;真要救可在 catch 里 re-enqueue,收益/复杂度比低。
- **[note] interruptQueue 撞上 drain**:镜像读取与点击间条目恰被后端 drain
  → Revoke 报 "queue item not found" 错误横幅,而该消息实际正被发送。罕见、
  无害(状态已是 prompting),记录。
- **[note] turn 间隙 busy 竞态窗口略 widen**:旧 drainSession 在 idle 事件
  handler 内同步置 prompting(近零窗);现在 prompting 由后端 drain 的推送
  驱动(绑定 RTT + turn 启动延迟,几十 ms)。窗口内直发撞 busy guard → 报错
  横幅 + 文本可从输入历史找回。自愈、可恢复,记录不修。
- **[note] 无 App 级 chat:queue 消费链测试**:queue 相关测试全是 QueuePanel
  props 级;事件→镜像→渲染链靠实现 worklog 的 server 模式 E2E(WS 实收
  `{sessionId,items:[...]}`)锚定。App.tsx 无 mount 测试基建,超出 review
  收尾范围,记录。
- **[note, backend follow-up] Go 侧 `SaveSessionSnapshot` doc comment 仍写
  「items/queue/draft/livePlan/permission」**:queue 已不打包,doc 陈旧。属
  后端文件,留给 backend reviewer 顺手改。
- **[note, 预存在] QueuePanel 多个按钮仍用原生 `title`**(save/cancel/
  schedule/edit/interrupt/revoke;§4.5 禁原生 title)——非 d6f6ad3 触及
  (diff 仅注释),前序 review 已放行,维持记录。

## 验证

- `bunx tsc` 干净;`bun test --isolate` 262 pass / 5 fail——5 个全在
  NewSessionModal(workdir/base-ref 选择器),与 queue 无引用关系,且 #126A/
  #126B worklog 均记录干净 HEAD 同样 fail(预存在);d6f6ad3 后 frontend/
  零提交(git log 证实),失败与本次 review 面无关。i18n zh/en 622=622 键
  完全同步(queue.* 两侧一致);d6f6ad3 未新增用户可见文案(错误文案来自
  后端 extractErrMsg)。
- 本 worktree 重新生成 bindings(wails3 v3.0.0-beta.3)核对签名一致。
- 三端(§4.7/§5.6):本 review 唯一代码改动为注释缩进(零行为变化),三端
  无行为面改动;d6f6ad3 本身的三端矩阵(桌面 GUI 单测+类型、远程浏览器
  /wails/runtime + WS 实证、PWA 未触及断点)已在实现 worklog 覆盖,本条
  复核其记录完整性,无重复执行必要。

## 下一步

- 无阻塞项。可选:backend reviewer 顺手更新 SaveSessionSnapshot doc;桌面
  真机冒烟(入队→Stop→定时→重启存活)仍待用户侧(与后端 review 同一条)。
