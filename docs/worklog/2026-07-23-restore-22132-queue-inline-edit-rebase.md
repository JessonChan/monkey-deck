# 2026-07-23 恢复 #22132 QueueItem.scheduledAt + 队列 inline 编辑:rebase onto main + 重跑 gate + 重合并

## 起因
Task #22133。#22132「QueueItem 扩展 `scheduledAt` + QueuePanel 队列消息 inline 编辑」原本落在
失败分支 `agent/coder/5e6dfe8c-failed`(4 个 commit,基点 `4065efc`):

- `9ff0e59` feat(queue): QueueItem.scheduledAt + onEditQueue wiring for inline edit
- `6de853d` feat(ui): QueuePanel inline edit (edit -> textarea -> save) + queued-time
- `da7ef17` test(queue): QueuePanel inline-edit + scheduledAt mount tests
- `cea8d65` docs(worklog): QueueItem.scheduledAt + 队列 inline 编辑(Task #22132)

期间 `main` 前进了 2 个 commit(#22131「主动入队列按钮(并列发送)+ ⌘⇧↩ + App enqueue 路径」
feat `51134e3` + docs `ad359f8`),在 `App.tsx`/`ChatView.tsx` 引入了一条**新的并列入队路径**
`enqueueMessage` / `onEnqueue`(与既有 `sendMessage` 里 `statusRef==="prompting"` 分支的隐式入队
并列)。本任务把 #22132 的 4 个 commit **rebase 到最新 main(`ad359f8`)**,重跑 gate,重新合并为
线性历史。

## rebase 结果:零文本冲突,但需语义调和(关键)

4 个 commit **直接 cherry-pick 零文本冲突**:#22132 改的区域(types.ts / App.tsx 入队与 editQueueItem /
ChatView.tsx Props 透传 / QueuePanel.tsx / i18n / index.css / 新测试)与 #22131 改的区域(App.tsx
新增 `enqueueMessage` 块、`onEnqueue` 透传)在文本层**相邻而非重叠**,git auto-merge 全部成功落地。

**但这是「同一条语义链上的两条入队路径」,rebase 后必须做语义调和**(否则会出现「队列里有的条目有排队
时间、有的没有」的不一致):

```
入队路径(两条,都产 QueueItem):
  (A) sendMessage 里 statusRef==="prompting" 分支(App.tsx,回合进行中隐式入队)
  (B) enqueueMessage(#22131 新增,主动入队列按钮 / ⌘⇧↩,idle/prompting 都入队)
        ↓ 都 push 进 queueBySessionRef.current[sid]
QueuePanel 按 item.scheduledAt 显示「排队于 HH:mm」(#22132)
```

#22132 原 commit 只给路径 (A) 的 `QueueItem` 加了 `scheduledAt: Date.now()`;#22131 的路径 (B)
**是 #22132 离开后才进的 main**,原 #22132 看不到它。rebase 后若不调和,路径 (B) 产出的
QueueItem 无 `scheduledAt`,QueuePanel 的「排队于 HH:mm」对这批条目不显示——与 #22132 的设计目的
(每条队列消息都标注入队时刻)矛盾。

**调和**:在 rebase 第一个 commit(`feat(queue): QueueItem.scheduledAt + onEditQueue wiring`)里,
**同时给 `enqueueMessage` 的 item 构造加 `scheduledAt: Date.now()`**(与 `sendMessage` 那处完全对称)。
这是 rebase 时「把特性补到新出现的同义路径上」的标准动作,不是新功能,不另开 commit。

其余 3 个 commit(UI / 测试 / worklog)原样落地,无需调和。

## 改了哪些文件
- 仅本条 worklog(4 个功能/测试/文档 commit 已由 cherry-pick 落地,首个 commit 含上述 rebase 调和)。

## 提交形态
cherry-pick 保留原 4 个原子 commit(2 feat + 1 test + 1 docs),新 SHA:
- `eef121f` feat(queue): QueueItem.scheduledAt + onEditQueue wiring(rebase 调和:`enqueueMessage`
  路径也加 `scheduledAt`)
- `5cdfd1a` feat(ui): QueuePanel inline edit + queued-time
- `33cc761` test(queue): QueuePanel inline-edit + scheduledAt mount tests
- `81edceb` docs(worklog #22132)
- 本条 = docs(worklog #22133 restore)

## 验证(gate 全绿)
- `make bindings`(`wails3 generate bindings`,无 `-d`)成功:2 Services / 67 Methods / 10 Models,
  输出到 `frontend/bindings`(前端 import 期望处;bindings 不入库)。
- 前端:`bun install` + `bun run build`(tsc + vite production)**clean**(仅既有 chunk-size > 500kB
  警告,非错误)。
- 前端测试:`bun test` → **102 pass / 0 fail** / 6250 expect() calls,含 #22132 新增的
  `QueuePanel.edit.mount.test.tsx`(编辑→保存写回、取消不触发 onEdit、Enter 保存 / Esc 取消 3 条)。
- `go build ./...` ✅(仅 macOS linker 版本警告,非错误;本任务纯前端,无 Go 改动)。
- `go vet ./...` ✅(干净)。

## 下一步(沿用 #22132)
- 桌面 app 实测(`wails3 dev`):主动入队列按钮 / ⌘⇧↩ 入队后,队列面板该条显示「排队于 HH:mm」;
  点编辑→改文本→保存,队列该条文本更新且保留排队顺序与 scheduledAt;取消还原;Enter/Esc 快捷键。
- 多平台抽检(macOS WebKit 优先):编辑态 textarea 高度 / 焦点 / 暗色主题渲染。
- 复核:两条入队路径(sendMessage 隐式 / enqueueMessage 主动)产的 QueueItem 现在都有
  `scheduledAt`,QueuePanel 排队时间标签覆盖全量队列条目。
