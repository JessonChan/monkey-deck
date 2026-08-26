# 2026-08-26 #111 队列循环发送(migration 0019 + dequeueDue 循环分支 + SetQueueItemRepeat + 前端循环档)

Task #24333(父 issue #24330;#24331/#24332 两次失败均为基础设施原因——opencode 升级窗口 + LLM 配额 5h 耗尽——非方案问题,本次原方案重派)。3 个原子 commit:`f7accbe`(store)/ `2bde4ac`(chat)/ `63b02d4`(frontend)。

## 起因

队列(#126A)只能一次性消费:每条消息 drain 发送后即出队。缺「按间隔反复发送」能力(如周期性提醒/巡检指令),且必须跨重启存活(队列真相在 SQLite)。

## 改法

### 1. store 层(`0019_queue_repeat.sql` + `internal/store/queue.go`)

- `queue_items` 加三列:`repeat_every_ms`(0=普通一次性;>0=每次成功发送后重排)、`sent_count`(成功发送计数)、`max_sends`(0=无限;N=到 N 自动清循环转普通)。
- **超出任务描述的两列,多加了 `max_sends` 一列**:任务把 migration 钉死为两列但同一条要求 maxSends 可选档——队列真相全在 SQLite,不落列则重启即丢,maxSends 语义不完整;任务同时授权「coder 按最 KISS 落」,三列即最 KISS 的完整实现。
- 行结构/List/Replace 读写同步补齐;roundtrip 测试覆盖三列(默认 0 + 显式值)。

### 2. chat 层(`internal/chat/queue.go`)

- **循环分支落位 drainQueue(发送成功后)而非 dequeueDue(发送前)**:是否消费取决于发送结果,只有 SendMessage 返回后才知道。净效果与任务描述一致——发送成功且 repeat>0 时条目不消失:`rescheduleRepeat` 原位(原 index,clamp 到队尾)回插。
- **重排公式钉死**:`scheduledAt = max(now, prevScheduledAt + repeat_every_ms)`——连续在线时 cadence=interval(prev+interval > now 分支);停机跨多周期后只发一次、重锚 now(now 分支),不补发。prev 取 dequeue 时刻的 scheduledAt。
- **sent_count 只在成功后 +1**;失败(busy 竞态/spawn 失败)走既有 `requeueAt` 原位回插,计数不动(既有语义零改动)。
- **maxSends 到 N 不回插**:dequeue 已消费该行,达到预算即「自动清循环转普通」=自然出队。
- **dequeue-before-send 不变量保持**:循环项发送期间短暂离队(turn 开始后毫秒级即回插),崩溃窗口内 at-most-once,与既有一次性语义一致。
- **SetQueueItemRepeat(sid, itemID, repeatEveryMs, maxSends) binding**:设/改/清(0);interval 硬校验 1min~24h,范围外拒绝,稳定错误码 `errQueueRepeatInterval`(`queue_repeat_interval_invalid:` 前缀,`errors.Is` 可判);maxSends<0 拒绝。不动 scheduledAt——循环只决定「发完之后」,下次到点仍由 #97 定时语义管。
- **锁纪律不变**:状态修改(读-改-写 store/arm/emit)全在 queueMu 内,SendMessage 在一切队列锁外。
- **syncQueueSnapshot 顺带 arm 定时器**:OpenSession 现在会 arm future 项的定时器——否则重启后定时/循环项要等无关 drain 触发才会被唤醒,循环项「重启后还在且继续发」的核心承诺会破(#97 一次性定时同样受益,顺手修正)。
- wire QueueItem 透出 `repeatEveryMs`/`sentCount` 进 chat:queue 快照(maxSends 留内部,前端无 UI 档)。

### 3. 前端(QueuePanel + App/ChatView + i18n + CSS)

- **schedule 编辑行加循环档 select**(不重复/每5min/每30min/每1h/自定义):预设档选中即提交;自定义分钟数 1~1440 前端门 + Apply/Enter 提交。自定义输入用**非受控 defaultValue+ref**——沿用本文件已文档化的 React 19 + happy-dom onChange 边缘模式(保存时读 DOM 值)。
- **循环徽标**:Repeat 图标 + 间隔人话(`formatRepeatInterval`:整小时→"1小时/1h",否则分钟)+ 「已发 N 次」里程(sentCount>0 才显示),与 #97 倒计时徽标**并存**(循环项同时有下次到点与间隔)。徽标内嵌 ✕ 一键取消(不打开编辑行)。
- `onSetRepeat` 为**可选 prop**:既有 5 个 QueuePanel mount 测试文件(13+ mounts)都以最小 props 挂载,必选 prop 会全部打断;App 侧始终接线。无 prop 时 select 禁用(降级只读)。
- App.setQueueItemRepeat → `ChatService.SetQueueItemRepeat(sid, id, ms, 0)`(maxSends 无 UI 档,固定 0=无限);ChatView 透传。
- i18n zh+en 11 键;CSS 徽标/档位样式 + ≤768px 触控(档位区 wrap 全宽、select/number 40px、✕ 6px padding,沿用 #126B 家族)。

## 验证

- **后端**:`go build ./...` / `go vet ./...` clean(仅存量 macOS 链接器 warning);`go test ./...` 全绿;新增测试 `-race -count 2` 通过:
  - `internal/store/queue_test.go`:三列 roundtrip。
  - `internal/chat/queue_repeat_test.go`(8 个,全 fakeChat,§5.1 不启真 harness;快间隔 60ms 经 store 直写行——binding 的 1min 下限由它自己的校验测试钉):重排公式(连续在线 cadence=interval、position 保持、双条目次序)/跳过追赶(跨 5 周期只发 1 次、重锚 ~now 不落过去)/maxSends=2 到 N 清循环(队列清空、无第 3 发)/userStopped 跳过循环项(保留未发、计数 0)/Revoke 删循环项/并发 5 drain 守卫不重入(恰好 1 发)/interval 校验(59_999、24h+1、负值拒;1min、24h 恰过;errors.Is 稳定码;快照透出两字段)。
- **前端**:`wails3 generate bindings`(SetQueueItemRepeat 出现)+ `bun run build`(tsc+vite)零错误;`bun test`:
  - QueuePanel 全家 7 文件 37/37(含新增 repeat 7 例:徽标与倒计时共存/里程显隐/✕ 取消不经编辑行/预设即交/自定义种子+Apply+Enter/越界拒绝+提示/无 prop 禁用)。
  - 全量失败集与干净 HEAD 基线**逐名 diff 为零新增**(存量失败均为 sttClient/mermaid 导出等环境依赖项,与本改动无关)。
  - i18n locales 奇偶测试过(zh/en 键一致)。
- **acceptance gate**:`wails3 task build` 过(前端 tsc/vite 零 TS 错误 + darwin 二进制产出);`frontend/dist` stub 本地补齐(embed 需要,不入库)。
- **三端矩阵(§4.7/§5.6)**:后端/binding 能力由单测+生成 binding 覆盖一次;`chat:queue` 本就在远程事件闭集(`remote_attach_desktop.go`),新增字段经 JSON 序列化自动到达远端(向后兼容,旧客户端忽略新字段)。桌面 GUI=同一代码路径;远程浏览器/PWA=同一事件通道,UI 改动全部条件化于 QueuePanel 内(≤768px 规则沿用 #126B 断点,>768px 桌面布局零变化)。真机冒烟(桌面入队→设循环→徽标/倒计时→✕ 取消;重启后循环继续)待用户侧。

## 下一步

- 真机冒烟:循环 1min 档实际跑几轮(徽标里程递增、到点续发、Stop 抑制、重启后继续)。
- maxSends 前端档(如「发 3 次后停」)暂无 UI,binding 已就绪,需要时加。
