# 2026-08-28 · review-stats 默认首行 findings 总览行 + 总N篇=记录数口径 + gate 无关声明(Task #26770)

## 起因

#26770(归属 #26764 口径钉死系列)要求两件事:①默认(周趋势)视图首行落总览 findings 行「P1a/P2b/P3c·未分级n篇/总N篇=记录数」;②声明 review-stats 与任何 gate 无关。issue 原文不可达(gh 未认证,同 #26767),按任务标题解读执行。

## 设计

**「总N篇=记录数」是一次口径修正,不只是格式**:#26769 的 findings 行「未分级 n/总 N」里,总 = P1+P2+P3+未分级 = finding 条数 + 未分级记录数 = 291——一个混合口径的缝合数,读者无法从输出本身看出单位。#26770 把「总」钉死为**记录数**(102),并给 未分级/总 两格加上「篇」单位:行内两种单位并排,P1/P2/P3 按 finding 条、未分级/总 按「篇」计记录。#26769 的分解恒等(P1+P2+P3+未分级==总)随之作废——它本来就是恒真式,价值只在解析自洽;新口径由跨视角守卫(总==记录总数)承接,守卫强度不降。

**一行两视图,单一 printf**:findings 行提为 shell 变量 `findings_line`,`prog_overview` 与 `prog_weekly` 共同插值——总览行与默认视图首行逐字节一致由构造保证,不靠两处 printf 手工同步。周趋势在 END 里先打首行,再打周行,尾行 total(span/weeks/avg)不动。

**守卫补强(注入实验暴露的真缺口)**:首行落进默认视图后它成了消费面,但 `wkl`/`ws` 解析器只锚周行——weekly 聚合里的 corpus 级累加(f1/un)坏了没有任何守卫能发现:向 prog_weekly 注入 f1+2/条、un+200 都静默通过。补 `weekly headline` 守卫:weekly 首行与 overview findings 行逐字节相等,一条 ck 覆盖首行全部五个数。#26769 踩坑 #2「守卫解析器先对真实输出跑再接入」换个方向应验:守卫覆盖面也要用注入验证,不能只验新守卫会不会误报。

**oft 解析重锚**:findings 行尾从数字变成「=记录数」,原 `[0-9]+$` 尾锚失明;改锚 CJK 标签 `/总 [0-9]+/` + ASCII 数字回走(与 oun 解析同一技法,不碰 towc 陷阱)。`=记录数` 字样直接进输出,把口径摆在消费面(#26767 的明面原则)。

**gate 无关声明**:脚本头部加 Gate status 段、Makefile 目标注释、TESTING.md 各一条:纯信息性工具,build/test/cover/CI 链不调用,任何验收门不消费其输出与退出码;--check 退出 1 只是给人看的口径警报,禁止接门禁链。落点选 Makefile 是因为 review-stats 紧贴 cover-check(gate 目标)下方,误接风险恰好在这。

## 改了哪些文件

- `scripts/review-stats.sh`:头注释(口径段 + Gate status 段 + usage 三处);`findings_line` 共享变量;`prog_weekly` 加 f1/f2/f3/un 累加 + 首行输出;`prog_overview` findings 行改插值;`mode_check` oft 解析重锚 + `weekly headline`/`findings total=recs`/`ungraded<=total` 三守卫(替换 `findings parts` 分解恒等)。
- `TESTING.md`:review 统计小节四处同步(四条 make 用法注释、逐条口径的总语义改写、findings 守卫改写、gate 无关新条目)。
- `Makefile`:review-stats 目标注释加 never-a-gate 声明。
- `docs/worklog/2026-08-28-review-stats-default-headline-gate-note-26770.md`:本条。

## 验证

- **首行一致性**:默认视图首行与 `--overview` findings 行 diff 为空;真实语料首行 `findings    P1 48/P2 49/P3 124 · 未分级 70篇/总 102篇=记录数`。
- **`--check` 全绿**:16 条守卫 ok 退出 0(新增 `weekly headline`/`findings total=recs`/`ungraded<=total`,移除 `findings parts`)。
- **注入正/负向**(模式锚定 perl,备份恢复):weekly 侧 f1+2/条 → `FAIL weekly headline`(P1 252)退出 1;weekly 侧 un+200 → `FAIL weekly headline`(未分级 14000篇)退出 1;oft 解析 +1 → `FAIL findings total=recs 103 (expected 102)` 退出 1;恢复后 check 全绿。首版按行号注入两次脱靶(快照漂移),改模式锚定后全部命中——与 #26769 踩坑 #2 同源:守卫实验前先确认注入真的生效。
- **回归**:by-issue/by-severity(记录级口径两视角)与改动前(git stash 前后)逐字节 diff 为空;周行格式未动,total 102 不变。
- **零记录路径**:空语料/纯非 review 语料(含 preview 剥除)四视角 + check 全部 "no review records found" 退出 0。
- **usage**:--help=0、未知参数=2;`make review-stats` 裸跑=0、`ARGS=--check`=0(管道接 head 会因 SIGPIPE 报 141,系管道截断非脚本问题)。
- **locale**:LC_ALL=C 与 en_US.UTF-8 全视图输出一致。
- `bash -n` 干净;shellcheck 本机未装(未跑,同 #26765-#26769)。Go/前端零改动,无 UI/binding/event 面,三端矩阵不适用(§4.7)。

## 下一步

- 已知失真与 --since/--until/--json 搁置项同 #26769,任务未要求。
