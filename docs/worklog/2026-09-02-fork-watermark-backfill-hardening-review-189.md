# Review #28960 — #189 fork 水位回填 + ForkSession 加固(后端面)✅ APPROVE

- **日期**: 2026-09-02
- **角色**: backend reviewer
- **对象**: `188082c`(`fix(store): backfill fork_base_seq watermark for pre-0024 forks (#189)`)+ `454669a`(`fix(chat): fail loud on fork watermark persist failure (#189)`)+ `21ef1f7`(worklog)。

## 起因

水位机制(0024,`a7c9b9b`)落地前的存量 fork 行只有 `forked_from`、`fork_base_seq=0`;`LoadMessagesPage` 守卫(`ForkBaseSeq<=0` 落回 own-only)使这类行重开后空历史。单卡打包四件事:①migration 0025 存量回填;②水位写入 Warn→FATAL;③`srcMaxSeq<=0` 建行前防御守卫;④三组测试。

## 审查方法

按「类型补丁」反相追踪:从每个新增物(0025 SQL、FATAL 分支、防御守卫、两个新测试)的定义点出发逐个确认真实消费端与行为通路,不信 commit message 叙事;测试逐条核断言是锚定值还是存在性断言;独立跑 vet + 全量 `go test ./internal/...` + 新测试 verbose 复跑。

## 逐项验证

1. **① migration 0025**(纯数据 UPDATE,无 schema 变更):
   - 公式与规格逐字一致:`MAX(seq) WHERE session_id=forked_from AND created_at <= 行 created_at`(含边界)。边界方向的健全性独立论证:`AppendMessage`/`UpsertTurnMessage` 的 `seq` 与 `created_at` 均在插入时同刻单调赋值(`messages.go:15/28/59/70`),replay 只会把 `created_at` 刷向**更晚**——重构只可能**低估**(前缀截断的安全方向),不可能把 fork 后源消息算进边界(高估需 post-fork seq 配 pre-fork 时间戳,在该写入模型下不存在)。
   - 单位可 Compare:`sessions.created_at` 与 `messages.created_at` 均为 `INTEGER NOT NULL`(`0001_init.sql:10/21/35`),无字符串/整型混比。
   - 关联子询相关名正确:子询 FROM 仅 `messages`,`sessions.*` 落到外层行;源已被删的 fork → 子询 NULL → `COALESCE` 保持 0(血缘关,不造前缀);`forked_from IS NOT NULL AND != ''` 双守卫;`fork_base_seq IS NULL OR <= 0` 保护已有真实水位(0024 列 `NOT NULL DEFAULT 0`,NULL 分支纯防御性,无害);二次执行幂等(WHERE 把已回填行排除)。
   - 消费端通电:回填值正是 `LoadMessagesPage` 的 `se.ForkBaseSeq <= 0` 守卫(chat.go:2206)读取的字段——DB 列是承重通路,字段不是摆设。runner `ReadDir("migrations")` 按文件名自动发现(store.go:148),升级启动即跑;所有 `New()` 测试在空表上已实际执行过该文件。
2. **② 水位写入 FATAL**(chat.go:1184-1187):失败 → best-effort `DeleteSession(fresh.ID)` + `fork: persist fork watermark: %w`,与相邻 `UpdateSessionACP` fatal(1195-1198)模式逐字同构。清行安全性核过:`store.DeleteSession` 仅删 `sessions` 行(242-245),无文件系统副作用——fork 行此刻可能已带源 worktree 路径,删行不触源 worktree。`fresh.ForkBaseSeq = srcMaxSeq` 移到 fatal 之后,失败路径不返回半填充对象。已知取舍:harness 侧 fork RPC 已成功,清行留孤儿 forked ACP session——与既有 `UpdateSessionACP` fatal 完全相同的已接受代价,非新债。
3. **③ `srcMaxSeq<=0` 守卫**(chat.go:1153-1155):位置在 `MaxSessionMessageSeq` 之后、**Fork RPC 与建行之前**——比规格「建行前」更严(不浪费一次 harness RPC)。理论不可达(hasMsgs 已过、seq 从 1 起)定性准确,属防回归护栏。
4. **④ 三组测试**:
   - 回填边界 `TestMigration0025ForkWatermarkBackfill`:同 0020 replay 模式(读同一 embed FS 真文件重放);时间戳/seq 全钉死不依赖墙钟;锚定值断言 `3/0/7/0`(含恰好压边界的 seq3 计入 `<=`)+ 幂等复跑断言。非「字段存在」断言。
   - 原子性注入 `TestForkSessionWatermarkPersistFatal`:trigger `BEFORE UPDATE … WHEN NEW.fork_base_seq>0 → RAISE(ABORT)` 经独立句柄建在临时库文件上,注入精确命中水位一步(前置 CreateSession 是 INSERT、worktree/forked_from UPDATE 时 fork_base_seq 仍 0 均不触发;DELETE 清理不触发 BEFORE UPDATE);断言锚定:错误同时含 wrap 前缀**与注入 cause**(证明失败来自水位步而非误伤)、`fresh==nil`、项目仅剩源 session。
   - 血缘零回归:既有 `fork_lineage_test.go` 3 用例 + fork 全套(declared/undeclared/busy/missing/source-error)+ fakeagent e2e,verbose 复跑全 PASS。

## 独立验证(本机复跑)

- `go vet ./internal/...` 干净;`go test ./internal/...` **15 包全绿**;`TestMigration0025ForkWatermarkBackfill`、`TestSessionColumnsCount`、`TestForkSessionWatermarkPersistFatal` 及全部 fork/lineage 用例 verbose 复跑逐条 PASS。
- `go build ./...` 报 `frontend/dist` embed 缺失——worktree 未构建前端的既有引导态,与本 diff 无关且未被触及(internal 包经 vet 编译全过)。
- 三端(§4.7):纯 Go 后端数据修复,binding 签名与事件零变化,三端同效;后端能力验证按矩阵统一做一次,无需分端回归。改动面未越任务红线(runner.go/前端零改动)。

## 非阻塞观察

- created_at 边界重构对「源在 fork 后被 replay 刷新旧消息 created_at」的存量行会低估水位(前缀少几条更早消息)——方向安全、且公式为规格明文规定,接受;真机复验(升级启动后重开 `7f3d43e0`)仍是最终裁决,worklog 已留人。
- `fork_base_seq IS NULL` 分支在 `NOT NULL` 列上恒假,纯防御,保留无害。

## 结论

**APPROVE**。四项规格全部落地且行为通路逐点核实,测试为锚定值断言,注入精确命中目标步,全量测试独立复跑绿。按流程停 completed-ready:不 push、不关 issue。

## 下一步

- coder 流程侧收尾(completed-ready 状态流转)。
- 留人:桌面 app 升级启动后真机复验 `7f3d43e0` 历史恢复 + 新 fork 无回归,回写 worklog 后关 #189。
