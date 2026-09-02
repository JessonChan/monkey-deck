# #189 fork 水位回填 + ForkSession 加固

日期:2026-09-02
关联:#189、#172 Phase 3(水位机制,`a7c9b9b` / 0024)

## 起因

水位机制 0024(`a7c9b9b`,09-01 16:26)落地**之前**创建的 fork 行只有 `forked_from`,`fork_base_seq=0`。`LoadMessagesPage` 的血缘守卫(`ForkBaseSeq<=0` 落回 own-only)让这类存量 fork 行重开后**空历史**——血缘数据本身没坏,只是水位缺失。真机实例:`7f3d43e0`("Remove CSV export…")。

## 改动

### 1. 迁移 `0025_session_fork_watermark_backfill.sql`(纯数据增量,无 schema 变更)

```sql
UPDATE sessions
SET fork_base_seq = (
    SELECT COALESCE(MAX(seq), 0) FROM messages
    WHERE session_id = sessions.forked_from AND created_at <= sessions.created_at
)
WHERE forked_from IS NOT NULL AND forked_from != ''
  AND (fork_base_seq IS NULL OR fork_base_seq <= 0);
```

语义:水位重构为「fork 行 created_at 之前(含等于)源的最大 seq」——防止 fork 之后源新增消息混入血缘前缀(与运行时水位捕获同一不变量)。边界形态:源在边界内无消息 → COALESCE 保持 0(血缘关,与现状一致,不强行造前缀);已有真实水位的行(>0)不动;非 fork 行不动。`sessionColumns` 仍 28 列,列数守卫测试注释同步(0001..0025,0025 纯数据)。schema_version 由 runner 按文件名自动推进,无别处需要同步。

### 2. `chat.go` `ForkSession` 水位写入 Warn → FATAL(#189)

`SetSessionForkBaseSeq` 失败不再 Warn 吞掉:`DeleteSession(fresh.ID)` 清行 + 返回 `fork: persist fork watermark: %w`。论证同 Phase 3 的 `UpdateSessionACP` fatal:戴 fork 徽章却开空历史比报错更糟。行清理 best-effort,错误是返回值。

### 3. `chat.go` 防御守卫(理论不可达,防回归)

`MaxSessionMessageSeq` 返回后(hasMsgs 守卫已过、seq 从 1 起,理论上必 >0):`srcMaxSeq<=0` → `fork: source watermark unavailable (seq=%d)`,在 fork RPC 与建行**之前**拦截。

## 改动文件

- `internal/store/migrations/0025_session_fork_watermark_backfill.sql`(新增)
- `internal/store/migrations_test.go`(+`TestMigration0025ForkWatermarkBackfill`)
- `internal/store/commands_cache_test.go`(仅列数守卫注释同步)
- `internal/chat/chat.go`(ForkSession 两处)
- `internal/chat/fork_watermark_test.go`(新增)

## 测试(三组)

1. **回填边界**(`TestMigration0025ForkWatermarkBackfill`,同 0020 的 replay 模式):源消息 created_at 跨边界(2000/4000/**5000=边界**/6000),fork 行 created_at=5000 居中 → 回填 3(`<=` 含边界钉死);边界前无消息的 fork(1500)保持 0;已有水位 7 不动;非 fork 行不动;二次执行幂等。
2. **原子性**(`TestForkSessionWatermarkPersistFatal`):SQLite trigger(`BEFORE UPDATE … WHEN NEW.fork_base_seq>0 → RAISE(ABORT)`)只打水位一步,经独立句柄建在临时库文件上(前置 INSERT 与 worktree/forked_from UPDATE 不触发,DELETE 清理不受影响)→ ForkSession 返回 `fork: persist fork watermark`(含注入 cause),fresh 行被清,项目只剩源 session。
3. **血缘零回归**:既有 `fork_lineage_test.go` 3 用例 + fork mock 全套 + fakeagent e2e 全绿。

## 验证

- `go vet ./internal/...` 过;`go test ./internal/...` 15 包全绿(chat 21.8s 全量)。
- **真实库副本回放**(sqlite3 CLI,临时拷贝验证后即删,**未触碰真库**):真库 schema_version=24;`7f3d43e0` 0→609(源边界内 609 条 / 边界后 354 条——正是要防的泄漏形态);`54513b87` 水位 4637 不动;二次回放幂等。
- runner.go / 前端零改动(任务红线);`LoadMessagesPage`/`forkLineagePage` 血缘查询逻辑未动;#172 Phase1/2 链路(fork 门控 / Send Now / 徽章)无波及。
- 三端:纯 Go 后端数据修复,binding 语义与前端零变化,三端同效,无需各端单独回归。

## 下一步

- **真机复验(留人)**:桌面 app 升级启动(自动跑 0025)后,重开 `7f3d43e0`("Remove CSV export…")确认历史恢复;再 fork 一次新会话确认无回归。完成后可关 #189。
