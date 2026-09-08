# #197 fork 翻页补 base 前缀(oldestSeq 缺失语义修复)

日期:2026-09-09
关联:#197、#172 Phase 3(水位/血缘视图)、#208(busy 切回跳过重拉)、#189(水位回填)

## 起因

用户直报:fork 对话向上翻页拿不到继承的历史前缀——own 页翻尽后应续拉 base 源前缀,实测永无 base 前缀。fork 家族最后一个功能缺口。

## 根因

两段式,都在前端 `App.tsx`:

1. **缺失游标的错误恢复**(`loadMoreMessages`):`oldestSeqRef.current[sessionId] || 0`——游标缺失时盲发 `beforeSeq=0`。后端契约(有单测钉死)是 `beforeSeq<=0` = 「最新一页」:fork 行返回 base 尾 + own 的最新合并页。这本身没错,**错在拿到结果后无条件 prepend**——最新页的内容本来就在屏幕上,prepend 即重复;且每次点击都重新推导同一个最新页,永远走不到 base 头。
2. **粘性缺失态**(#208 留下的洞):「切走时内存节省丢弃缓存(含 oldestSeq/hasMore/items)→ 切回时目标 busy → 跳过重拉」。此后该 session 没有页、没有游标、没有 hasMore——翻页路径整个死掉,turn 结束后也不自愈(#208 的设计是「下次空闲切回再重拉」,用户停在会话上就永远卡住)。fork 行表现为:继承的 base 前缀不可达。

**后端排除**:`forkLineagePage` 的游标代数经单测实证**无 off-by-one/重复段**(详见单测小节)——候选 A 怀疑的「合并页探针/slice(1) 跨页边界」问题不存在,后端零改动。

## 修法(用户给的两个候选,组合落地)

### 1. 缺失游标 → replace 自愈(候选 A 的正确形态,`loadMoreMessages`)

游标缺失 = 页缓存的 provenance 已丢。wire 调用保持 `beforeSeq=0`(后端契约不动:openSession 首拉和该恢复路径都依赖「0 = 最新合并页」;**不改后端 0 的语义**——那会让 fork 行首拉从 base 头开始,破坏 #189 的首屏懒加载),但响应**替换**时间线(等价 fresh-open),不再 prepend 重复。任何原因导致的游标丢失,一次点击内自愈:页 + 游标 + hasMore 全部恢复,base 前缀重新可达。

### 2. busy→idle 边自愈(候选 B,消除粘性缺失态)

实现落点:**`chat:status` 事件处理器**的回合结束分支(`idle`/`error`/`closed`)内——turn 结束 **push** 是权威自愈信号:该时刻增量落库已完成,全量重拉即权威快照,一步恢复页 + 游标 + hasMore。触发条件:push 所属 session 恰是当前选中、且不在 `loadedSessionsRef`(= #208 跳过重拉的 precisely 这个状态);缓存未被丢弃的 busy 切回(#208 场景 4)与用户已切走的 session 都不进此分支。

**两个关键防坑**(开发中实测踩到):

1. **快照合并不得触发自愈**。第一版用 effect 监听 `statusBySession` 的 busy→idle 翻转,结果 #208 场景 1/2 立即回归:`openSession` 内的 `syncSessionStatuses` 快照合并把 push 设的 prompting 清掉,伪翻转触发自愈重拉,流式尾巴被 DB 页冲掉。改为**只认 turn-end push**后,#208 四场景逐条复核不进自愈分支。
2. **defer 到 macrotask + 急写 status 镜像**。handler 同 tick 内 `statusBySessionRef`(effect 提交的镜像)还是旧值,直接调 `openSession` 会被其 busy 门(读该镜像)拦掉;`setTimeout(0)` 后镜像已由被动 effect 刷新,但与 React 调度存在竞态——故 turn-end 状态在分支内**急写镜像**(turn-end 是终态,无 `started` 瞬态风险),再 defer 调用,确定性通过 busy 门。

busy 期间依旧不拉(#208 语义保持:不破坏流式尾巴);自愈的重拉等价一次空闲重开。

## 单测(先红后绿)

**前端** `App.fork-prefix-pagination.mount.test.tsx`(新):mock 按字节移植 `forkLineagePage` 契约(own 分支 `beforeSeq<=0` 取最新窗口、base 尾填负偏移、limit+1 探针),驱动**真实** App 分页状态机:

1. **walk 钉死**(修复前后都绿,回归钉):fork 行(own=3, base=50, PAGE_SIZE=30)首拉 = 最新合并页(base 尾 src-24..50 + own);一次点击跨过合并页边界无缝续接 base;53 行逐行断言「每行恰一次」(无重无漏);base 顶到头即停(按钮消失);游标调用日志精确 `[0, -27]`。
2. **自愈钉死**(修复前红:turn 结束后无重拉、load-more 缺席、base 不可达;修复后绿):复刻 #208 漂移场景——打开 fork(游标 -27)→ 切走丢弃 → 后台 turn(事件重建尾巴)→ busy 切回(不重拉,尾巴存活)→ **turn-end push** → 断言重拉(第 2 次拉取)、持久化尾巴存活、base 尾回归、load-more 回归、再点一次直达 base 头 `src-1`,游标日志 `[0, 0, -26]`。

脚手架同 `App.busy-switch-back.mount.test.tsx`(mock 先于 App 动态 import);另加:虚拟列表几何 stub(VIEWPORT=5000/行高 10px,53 行全量入窗,DOM 断言确定性)、IntersectionObserver 无操作 stub(杜绝自动翻页竞态)、`SessionStatuses` 快照 mock(真后端 busy 时报 prompting,防止快照合并伪清 busy 状态)、bubble 精确文本匹配(行级匹配会与时间戳数字碰撞:`src-50`+`01-01…` 读作 `src-5001…`)。

**后端** `internal/chat/fork_lineage_test.go` +`TestForkLineagePageWalkNoDupNoGap`:同一形态(own=3/base=50/limit=20)逐页走完整翻页——3 页(合并边界页/纯 base 中间页/base 顶页)、hasMore 位 `[true,true,false]`、逐页严格递增、拼装 = 全量 53 行([-50..-1]∪[1..3],无重无漏,-1→1 恰一个接缝)、末页恰 13 行无 +1、base 顶 `-50`(= 源 seq 1)终止。**设计上是绿的就落绿**:它实证后端游标代数正确(含首拉契约 `LoadMessagesPage(fork,0,20)` = `[-18..3]` 21 行探针窗),把「后端要不要改」从推断变成实证。

## 改动文件

- `frontend/src/App.tsx`(`loadMoreMessages` 缺失游标 replace 自愈;`chat:status` 回合结束分支 + push 驱动的自愈)
- `frontend/src/App.fork-prefix-pagination.mount.test.tsx`(新)
- `internal/chat/fork_lineage_test.go`(+`TestForkLineagePageWalkNoDupNoGap`)

后端 `chat.go` **零改动**(单测实证协议正确,见上)。

## 验证

- `go vet ./...` 干净;`go test ./...` 全绿(全包 ok,无 FAIL)。
- 前端 `bun run build`(= `tsc && vite build`)零错误;`bun test` 全量 558 pass / 21 fail,与**修复前基线(main 34e5f2f,stash 对比)完全同一批 21 fail**(happy-dom 环境既有问题:clipboard 通道、KaTeX、coarse-pointer 模拟、5000ms alarm 等),零新增失败;净增 2 个通过测试。#208 四场景零回归(busy 首开不拉、漂移尾巴存活、空闲切回重拉、受保护切回单次拉取——自愈只认 turn-end push 且要求缓存已丢弃,四场景均不进该分支);`App.*.mount.test.tsx`、`ChatView.*`、翻页/fork 既有测试全绿。
- #189 回归:walk 钉死测试即 #189 场景(fork 行重开首屏 = 完整合并历史的第一窗),绿。
- 三端(§4.7):本修复是共享前端状态机逻辑(无布局/CSS/`isRemoteClient`/断点分支),三端跑同一份 `App.tsx`;mount 级行为测试已覆盖该逻辑,三端无定向改动,不另做各端回归。

## OPEN / 下一步

- **OPEN(openSession 拉取失败毒化)**:`openSession` 在 `await` 前就把 session 加入 `loadedSessionsRef`;若 `LoadMessagesPage` 拒绝,重试打开会因「已加载」跳过拉取,seed/hasMore 也不建——非 fork 专属,不在本任务面,留记录。
- 真机冒烟(桌面 app 实操 fork 会话翻页到 base 头)留人复验后可关 #197。
