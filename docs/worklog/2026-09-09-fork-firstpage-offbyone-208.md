# 2026-09-09 fix(chat): #208 二次重开——fork 首屏分页 off-by-one 吞掉最新 agent 回复

## 起因

用户报告(#208 最新跟评):「条漫生成任务 (fork)」会话,问「我们现在整体的进度是什么样的?」,
GUI 看到完整回复后切走再切回,回复消失;PWA 全新打开也没有。升级到最新版(含 2026-09-09 上午的
流式信任门修复)仍复现。

## 取证(全部基于生产数据,非推测)

1. **session 定位**:custom_title「条漫生成任务 (fork)」= `318fec7b`,fork 自 `81d281bf`
   (fork_base_seq=5032,自有 285 行)。用户当日问过**两次**同一句话:
   - seq 281(16:51:48):17 秒后 omp 被 SIGKILL(统一日志确认 `anon<omp>` termination,同秒两个
     pid)→ prompt failed: peer disconnected → **零行落库**(模型尚未产出首 token,行为正确)。
   - seq 282(16:53:24):16:54:34 回复落库(283/284 tool + **285 agent,1518 字符**,
     「# 整体进度全景(24 卷…)」)。
2. **DB 无缺行**:sqlite3 CLI 直接查 `DESC LIMIT 31` 返回 255..285,285 在。
3. **binding 复现**:server 模式二进制 + 生产 DB 副本,`/wails/runtime` 按前端同一 wire 格式
   调 `LoadMessagesPage(fork, 0, 30)` → 返回 31 行 **254..284,285 永远缺失**。变换 limit
   (3/1/5)同样:响应永远等价于 `seq < 285` 的查询——最新一行被吃掉。
4. **分层定位**:同 DB 直接调 `store.ListMessagesBefore(sid, 0, 31)` 返回 **32 行**(255..285,
   超出 limit+1 契约);chat 层复现缺失 → bug 在 chat 的 fork 合并层,不在 store、不在前端。

## 根因

`forkLineagePage`(internal/chat/chat.go)调 `ListMessagesBefore(..., limit+pre=31)` 想拿页预算
31 行;但 store 的 `ListMessagesBefore` **内部自己再 +1**(LIMIT limit+1=32,hasMore 探针)→ 返回
32 行;chat 层防御性截断 `own[:limit+pre]` 在**升序**切片上砍尾 → **永远砍掉最新的第 285 行**。

触发条件:fork 自有消息 ≥ limit+2(PAGE_SIZE=30 → ≥32 条)。该 fork 有 285 条 → 每次 DB 重拉
(idle 切回重拉、PWA 冷开、翻页)首页必丢最新 agent 回复——与 #208 原始症状「切回后只剩
tool call/thinking」逐字吻合,且解释了「再发一条消息,上一条就出现」(新回复把 285 挤到
第 2 位,不再是被砍的最新行)。

既有测试全过的原因:没有任何测试给 fork 塞过 >32 条自有消息(#197 测试用 3 条;游标代数测试
不覆盖首屏 own 满页场景)。

## 改法

- `internal/chat/chat.go` `forkLineagePage`:own 查询改传 `limit`(store 自加的 +1 恰好凑成
  页预算 limit+pre),删除已不可达的截断分支。一行语义修正,游标代数不变。

## 改了哪些文件

- `internal/chat/chat.go`:own 查询参数修正 + 注释说明根因。
- `internal/chat/fork_firstpage_test.go`(新增):
  - `TestForkFirstPageIncludesNewestOwnRow`:生产形状(32 条 own,最新为 agent 行),断言首页
    含最新 agent 行且 ≤ limit+1。
  - `TestForkPagingDeepOwnWalkNoLoss`:完全镜像前端 prepend 装配的分页全走查(own 33 + base 7,
    limit 10,跨 own/base 边界),断言装配视图与全量合并转录逐一相等——无丢失/重复/错序。
  - 两个测试 pre-fix 均 FAIL、post-fix PASS(git stash 验证)。

## 验证

- `go test -count=1 ./...`:15 包全 ok,0 FAIL。
- 端到端:server 二进制 + 生产 DB 副本 + 前端同款 binding 调用:修复前 last seq=284(tool),
  修复后 **last seq=285(agent,「# 整体进度全景…」)**。
- 前端回归:`App.fork-prefix-pagination.mount.test.tsx` 2 pass(#197 分页契约不回归)。
- 既有 fork 全家(TestFork* 14 个)全 pass。

### 三端覆盖

纯后端分页修复,binding 签名/事件未动:

- **桌面 GUI / 远程浏览器 / PWA**:三端同一 `LoadMessagesPage` 通道,server 模式端到端已验;
  前端零改动,无 UI 面。用户侧复核:重开「条漫生成任务 (fork)」应能看到 16:53 提问下的
  「# 整体进度全景」回复。

## 与前两轮修复的关系

#208 实为两个独立 bug 叠加,同症状:

1. 前端信任门(busy 切回重拉覆盖内存尾巴)——3a1df6b / 65651e4 已修,前端。
2. 后端 fork 首屏 off-by-one(DB 有行但 binding 吞最新行)——本次修复,后端。
   用户的这次复现是 2:turn 已 idle、PWA 冷开也丢 = DB 读路径问题,与流式无关。

另记(未修,后续任务素材):16:52~17:05 omp 被外部 SIGKILL ≥10 次(每次重连拉起后又被杀;
非 jetsam,非我方 reaper——reaper 只在 harness 退出后按 pgid 回收)。凶手待查,与丢回复无因果
但影响稳定性。

## 下一步

- 用户真机复核「条漫生成任务 (fork)」回复可见。
- 独立排查 omp 连环被杀(系统日志层面)。
