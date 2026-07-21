# 2026-07-22 修复 NewSessionModal harness 未选 null 范式(Task #21333)

## 起因
Review #21332(commit 7070cbc5)对 issue #21330(新建对话记住上次 harness)的结论是
NEEDS CHANGES:后端持久化(① ④)、无夹带(⑥)、acceptance gate 全部 PASS;但 issue
第二条核心要求「没选过则不设默认、要求显式选择」**整条未落地**——Task #21331 落地时
`NewSessionModal.tsx` 的 harness state 类型是 `string`(初值恒非空,硬选
`harnesses[0]?.id || "omp"`),与 issue 相反。

## FAIL 点(reviewer 已定位)
1. harness state 类型 `string`(初值恒非空),不是 `string | null`。
2. `canConfirm`(:37)`= !isGit || worktree !== null` —— 缺 `&& harness !== null`,
   confirm 永不因 harness 未选而禁用。
3. harness label 无 `ns-required`「请选择」提示(未复用 worktree 同款样式)。
4. `lastHarness` 对应 harness 已被移除时,回退 `harnesses[0]` 而非 null(与 #2 同根)。

## 改法(只改前端,后端不动)
照抄同弹窗 worktree 的 null 范式(`:26`/`:37`/`:67`):

- harness state 改 `string | null`,初值用 lazy initializer:
  - `lastHarness` 命中可选列表 → 取 `lastHarness`(记住上次选择,issue 主诉求);
  - 单 harness(`harnesses.length === 1`,KISS)→ 自动选那唯一项(无歧义、免纯摩擦);
  - 否则 → `null`(多 harness 必须显式选)。
- `canConfirm` 加 harness 守卫:`harness !== null && (!isGit || worktree !== null)`。
- harness label 加未选提示:`harness === null` 时显示 `ns-required`(复用 worktree
  同款样式 + 同 i18n key `newSession.required`)。
- `onConfirm` onClick 改 `harness !== null && onConfirm(harness, worktree === true)`,
  守卫内 TS 自然收窄为 `string`,无需 `!`。

不动:后端 `chat.go` / `GetLastHarness` / `last_harness_test.go`(已 PASS);harness
按钮 `active` / radio `on` 判定已用 `harness === h.id`,`null` 时全不亮,天然正确。

## 改了哪些文件
- `frontend/src/components/NewSessionModal.tsx`(纯前端,4 处改动)
- `docs/worklog/2026-07-22-fix-newsession-harness-null.md`(本条)

## 验证
- `bun run build`(= `tsc && vite build`):零 TS 错误,build 成功(只 chunk size 提示)。
- `wails3 task build`:零 TS 错误,产 `bin/monkey-deck`。
- `go build ./...` / `go vet ./...` / `go test ./...`:全 PASS(只有 ld 的 macOS
  版本 warning,无关)。
- `git status`:仅 `NewSessionModal.tsx`(RAK 运行时文件 / AGENTS.md 未动)。

## DoD 对照
- harness state `string | null`,没选过(lastHarness 空/失效/多 harness)时为 `null`,
  不硬选首个 ✓
- `canConfirm` 含 `harness !== null` 守卫,未选时 confirm 禁用 ✓
- harness 未选时 label 旁显示 `ns-required` 请选择提示(复用 worktree 同款样式)✓
- `lastHarness` 对应 harness 已移除时回退 `null`,不硬选第一个 ✓
- 对照同弹窗 worktree 字段行为一致(worktree 必须显式选 → harness 多 harness 时也必须)✓
- 单 harness 自动选(无歧义免摩擦),多 harness 必须显式选 ✓

## 下一步
等 Orchestrator review。
