# 2026-07-22 复验:NewSessionModal harness null 范式修复 PASS(Task #21335)

## 起因
复验 Task #21333(coder cce3f203,commit 61cfcb90 fix + c257a599 worklog)对
Review #21332(NEEDS CHANGES)的修复。上一轮 4 个 FAIL 点应已全部落地。

## 逐条核对(行为变更,非空壳)
对照 `frontend/src/components/NewSessionModal.tsx`(commit 61cfcb90 后状态):

1. **harness state 类型 `string | null`** ✓
   `:22` `useState<string | null>(() => {...})` —— 类型确为 `string | null`,不再是
   恒非空 `string`。初值 lazy initializer 三分支:
   - `lastHarness` 命中可选列表 → 取 `lastHarness`(记住上次,issue 主诉求);
   - 单 harness(`harnesses.length === 1`)→ 自动选唯一项(无歧义,免纯摩擦);
   - 否则 → `null`(多 harness 必须显式选)。
   旧的 `harnesses[0]?.id || "omp"` 硬选回退已彻底删除(`grep` 确认无 "omp" 字面量,
   `harnesses[0]` 仅出现在 `length === 1` 单选分支)。**真实行为变更。**

2. **`canConfirm` 含 `harness !== null` 守卫** ✓
   `:40` `const canConfirm = harness !== null && (!isGit || worktree !== null);`
   未选 harness 时 confirm 真禁用(非空类型加守卫)。`:111` onConfirm onClick 同步改
   `harness !== null && onConfirm(harness, ...)`(守卫内 TS 自然收窄为 `string`,无 `!`)。

3. **harness label 有 `ns-required` 未选提示** ✓
   `:48-51` `harness === null && <span className="ns-required">{t("newSession.required")}</span>`
   复用 worktree 同款 className + 同 i18n key(en "(required)" / zh "（请选择）"),
   与 `:73` worktree 字段样式/交互完全一致。

4. **`lastHarness` 对应 harness 已移除时回退 null,不硬选第一个** ✓
   初值 lazy initializer:`lastHarness` 不命中列表 → 不取 `harnesses[0]`,而是走单
   harness 检查,多 harness 时落到 `null`。与 worktree 同弹窗范式一致。

## 持久化(要求①)未破坏
后端本次未动(diff stat:仅 `NewSessionModal.tsx` + 本 worklog 前置的两条 worklog):
- `internal/chat/chat.go:516` `SetSetting("lastHarness", hid)` 仍在 CreateSession 写回。
- `internal/chat/chat.go:2094` `GetLastHarness` 仍读回。
- `internal/chat/last_harness_test.go` 全 PASS(go test 运行确认)。

## 一致性核对
- 多 harness:必须显式选,与 worktree 字段(git 项目必须二选一)范式一致。✓
- 单 harness自动选(`length === 1`):KISS,无歧义免纯摩擦,不破坏多 harness 显式选核心。✓
- 非 git 项目:worktree 隐藏(`isGit && ...`),`canConfirm` 仅 `harness !== null`。✓

## 未夹带 / 未污染
- `git diff 7070cbc..c257a59 --name-only` = 仅 `NewSessionModal.tsx` + 两条 worklog。
- RAK 运行时文件 / AGENTS.md 均未动。✓
- dist stub(临时 `frontend/dist/index.html`)被 `.gitignore` 排除,`git status` 干净。✓

## acceptance gate
- `frontend/dist` 临时 stub(go:embed 要求目录非空,gitignore 排除)。
- `go build ./...` / `go vet ./...`:EXIT 0(仅 macOS 链接器 SDK 版本 warning,无关)。
- `go test ./...`:全 PASS(acp/chat/config/fsview/harness/permissions/store/terminal/
  titlegen/ui/update/worktree 全 ok)。
- `wails3 task build`:EXIT 0,产 `bin/monkey-deck`(19MB),**零 TS 错误**(仅预存在
  chunk>500kB 提示,无关)。

## 结论
**PASS。** 上一轮 4 个 FAIL 点全部真落地(行为变更非空壳),持久化未破坏,与 worktree
字段范式一致,acceptance gate 全过。issue #21330(新建对话记住上次 harness + 多 harness
显式选择)可关闭。

## 下一步
关闭 issue #21330。
