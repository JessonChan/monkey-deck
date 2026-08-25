# 2026-08-25 SessionStatuses 只读 pull API + resync 快照 merge(修 #134/#127)

## 起因

#134(PWA 对话已结束但状态卡「对话中」)与 #127(PWA 打开 busy session 显示 idle → 发送报错)是同一架构缺口的镜像:**`chat:status` 是纯推送制,remote 客户端错过事件(WS 断线 / 连接晚了)后,前端 `statusBySession` 没有任何后端快照对账通道**。§1.8 设计是「WS 只重连不回放」,所以修法不是回放事件,而是给一条**只读 pull API**,resync 时拉快照 merge。

## 改法(改了哪些文件)

- **`internal/chat/chat.go`**:新增导出方法 `ChatService.SessionStatuses() map[string]string`——从后端真相(`s.active` + `s.reconnects` + `reconnectGiveUp`)派生每个 live session 的当前状态,不重放事件:
  - busy turn 进行中 → `"prompting"`(#127:错过 prompting 的客户端据此锁 composer/走队列);
  - 自动重连进行中 → `"reconnecting"`;重连耗尽 → `"error"`(侧栏错误点,发消息经 ensureLive 清 giveUp 重试,§3.3);
  - 否则(活但空闲)→ `"idle"`(#134:丢了 idle 事件的客户端据此解卡);
  - **不在快照里 = 无 live harness**:调用方必须把该 session 缓存的 `prompting/reconnecting` 视为陈旧丢弃(turn 确已结束)。
  - 锁序 `s.mu.RLock → ls.mu.Lock`,已核查无反向持锁路径(无死锁)。
- **`frontend/src/App.tsx`**:
  - 新增 `syncSessionStatuses()`:拉快照 merge 进 `statusBySession`——快照内按后端真值覆盖;**快照外**只清陈旧的活跃态(`prompting`/`reconnecting` → `idle`),展示态(error/notice/readonly)保留(无 harness 也有语义)。幂等(changed 守卫),拉失败静默保留缓存。
  - `remote:resync` handler 调用之(重连对账主路径)。
  - `openSession` 在 `OpenSession` 后调用之(#127 的打开路径:首连 resync 早于用户点开 session,打开时必须再对一次账;桌面端为 no-op——快照与推送流一致)。
- **`frontend/src/types.ts`**:`StatusPayload.status` union 补 `"reconnecting"`(后端 `statusReconnecting` 一直在发,类型层此前没对齐)。
- **bindings**:`wails3 generate bindings` 重新生成(`frontend/bindings/` 不入库);`SessionStatuses` → `$Call.ByID(894245602)`,返回 `{ [_ in string]?: string }`。

设计取舍(与 issue 建议方案的差异):不动 `OpenSession` 签名(issue 方案 A)——返回值变更牵连面大;独立只读方法(方案 B 变体)+ 前端在 resync/openSession 两个时机 merge,覆盖同一批场景且桌面/远程同代码路径。

## 验证

- **后端**:`go build ./...` / `go vet ./...` 干净(仅存量 macOS 链接器 warning,与本次无关);`go test ./...` 全绿。新增 `internal/chat/session_statuses_test.go`(mock fakeChat,§5.1 不启真 harness):
  - `TestSessionStatusesBusyTurn`(repro #127):SendMessage 起 turn、Prompt 阻塞中(不消费任何 status 事件)→ 快照报 `prompting` ✓;
  - `TestSessionStatusesIdleAfterTurn`(repro #134):release 放行 turn 结束 → 快照翻 `idle` ✓;
  - `TestSessionStatusesDerivedStates`:idle / reconnecting / give-up→error / 关闭后缺席 / 空表非 nil(wire 形状稳定)✓。
- **前端**:`bun run build`(tsc + vite)通过。
- **三端矩阵(§4.7/§5.6)**:
  - **桌面 GUI**:无 UI/布局改动,merge 在事件不丢的桌面上是 no-op(快照与推送一致);openSession 增加一次内存快照拉取,无感。
  - **远程浏览器**:**本改动的主战场**。binding 经 server 模式实测:隔离 HOME + `WAILS_SERVER_PORT=9347` 起 `-tags server` 二进制(不碰运行中的桌面实例与真实数据,§5.6),curl `POST /wails/runtime`(`methodID 894245602`)→ 返回 `{}`(空库无 live session,wire 往返 ✓);resync merge 逻辑由状态矩阵单测 + 类型检查覆盖。真实断线重连 E2E(起 turn → 断 WS → 重连验状态解卡)留待手动,与 M2「待真机实测」同 convention。
  - **PWA**:与远程浏览器同一代码路径(resync/openSession),≤768px 断点未触及;真机验证同上留待用户侧。
- 后端能力(binding wire)按 §5.6 统一验一次,三端只各确认本端通道:GUI=webview binding(随构建)、浏览器=HTTP runtime(curl 实证)、PWA 同浏览器。

## 下一步

- 手动/真机验证:桌面跑 turn → 手机 PWA 断网重连,确认状态点解卡(#134);桌面 turn 中 PWA 打开该 session,确认 composer 锁定/入队(#127)。可关 issue。
- issue #134 提的「prompting 超时 N 分钟无事件主动对账」兜底未做(可选,当前 resync+open 双时机已覆盖已知场景);若真机仍发现卡态再补。
