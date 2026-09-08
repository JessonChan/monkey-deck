# 2026-09-08 #199 delete-worktree guest 守卫 review(降维轻量审,APPROVE)

## 背景 / 起因

审 main HEAD **ebd684c**(daemon fallback commit,5 文件 +382/-15:`internal/chat/chat.go` 守卫 + `frontend/src/App.tsx` 缝 + 双侧测试)。用户预授权**降维轻量审**(替代全量卡 MON-714/715 的阻塞),范围锁定四项:①diff 审读守卫语义;②三不变量;③build+vet 本机实跑;④全量清单(测试全量实跑 / 前端缝逐条复核)**显式留补强**,不在本卡闭合。

## 结论:**APPROVE**(①–③ 全过,零 needs changes;全量清单留补强)

### ① diff 审读:守卫语义与规格一致 ✓

- `DeleteWorktree(sessionID string, force bool)`(chat.go:1079)守卫顺序:owner-only 检查(:1087)→ live-guest 守卫(:1090,**仅 `!force` 时**)→ GetProject → `worktree.Remove`。规格语义吻合:force 只跳过 guest 守卫,不跳 owner-only,更不触及 Remove 护栏。
- 错误携带 guest 数(`"%d chats still use this worktree"`),拒绝发生在任何 git 操作之前 = 原子 no-op。
- 干净切换:全仓无残留 1-arg 调用点(Go 侧仅定义 + 测试;前端 3 处调用全部 2-arg 且语义各异:`removeSession`→false、all 链→true、keep 链 detach 后→false)。
- 前端缝(轻看,全量复核留补强):guests 查询**失败路径保守降级**(只删 chat 行、不碰 worktree、留孤儿——注释言明孤儿清理另卡跟踪);keep 链去掉 `.catch(() => {})` 吞错,detach/delete 失败即冒泡保持现状。

### ② 三不变量 ✓

| 不变量 | 证据 |
|---|---|
| guest 存在 + 非 force → 拒绝,worktree 保留 | 守卫先于 git 操作;`TestDeleteWorktree_GuestGuard` 断言拒绝 + 错误含锚定文本 `"1 chats still use this worktree"` + 目录 `os.Stat` 存活 + branch `rev-parse --verify` 存活 |
| owner-only 语义不回退 | owner 检查在 force 分支**之前** → guest 会话持 force 也删不掉;`TestDeleteWorktree_OwnerOnly` guest 拒绝 + owner(先删 guest 行)成功 + branch 已删,全过 |
| worktree.Remove 四护栏零改动 | `git diff ebd684c~1..ebd684c -- internal/worktree/` 为空;护栏原文俱在(worktree.go:192-196:拒主工作树 / 仅 `md/` 前缀分支 / 仍登记 linked / git 兜底) |

### ③ go build + go vet 本机实跑 ✓

- 前置:worktree 无 `frontend/dist`,首轮 `go build ./...` 爆 embed 缺失(main.go:22,环境态非代码缺陷)。stub `frontend/dist/.keep` 后:
- `go build ./...` **exit 0**;`go vet ./...` **exit 0**(仅 ld "newer macOS version" 工具链噪音,与前两条 review 记录一致)。stub 已删,worktree 复原干净(`git status` 空)。

### 补强:焦点测试实跑(超出轻量要求,额外证据)

`go test ./internal/chat/ -run 'TestDeleteWorktree|TestDeleteSession_KeepsWorktree|TestDetachWorktreeGuests' -count=1` — **5/5 PASS**(真 git 于 TempDir,不吃缓存)。**`go test ./...` 全量与前端 `App.worktree-guard.mount.test.tsx` 实跑不在本卡范围,留补强。**

## 反「类型补丁」核验(逐消费点追踪)

新增 `force` 参数非空壳:后端守卫分支消费(chat.go:1090);前端 3 个调用点逐一显式传值且语义不同(false/true/false);mount 测试桩按 `deleteWt:${sid}:${force}` 锚定线序契约。测试断言锚定值(错误文本子串 / 目录与 branch 的文件系统实测),非字段存在性断言。

## 非阻塞观察(记录,不要求改)

- **TOCTOU 窗口**:`WorktreeGuests()` 查询与 `worktree.Remove` 之间新进 guest 理论上仍可丢 cwd(DB + git 无法单事务)。单用户桌面 app 下窗口极窄,前端查询失败保守降级 + 后端守卫已把风险压到可接受;如实测出现真实竞态再评估 owner 会话行级锁。本卡不动。
- **bindings 是 gitignored 构建产物**:本 commit 无法携带,`wails3 task bindings` 需在 dev/build 前再生成(线契约已由前端测试桩钉住);提醒非缺陷。
- force 链下 guest 行带悬空 `WorktreePath` 存活 = 现行语义,`TestDeleteWorktree_ForceBypassesGuestGuard` 已文档化断言;孤儿清理另卡跟踪。

## 降维范围声明(本卡性质)

本卡为**用户预授权的降维轻量审**,非全量审。已做:diff 审读、三不变量核验、build+vet、焦点测试。**留补强(全量审清单)**:`go test ./...` 全量实跑、`App.worktree-guard.mount.test.tsx` 前端缝实跑逐条复核、三端验证矩阵按 §4.7 落实(本 commit 含前端改动)。

## 下一步 / 留人

- 不 push、不关 issue。
- 上层复核本 APPROVE 后按 completed-ready 流转;补强项归全量卡 MON-714/715。
