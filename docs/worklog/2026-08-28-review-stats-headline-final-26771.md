# 2026-08-28 Review #26770: review-stats 默认首行 findings 总览行 + 总N篇=记录数 + gate 无关 — APPROVE

Task #26771(review,#26764 口径钉死系列终审)。审查对象:commit `be4a12c`(feat(scripts):
review-stats 默认首行落 findings 总览行,`scripts/review-stats.sh` +66/-17、Makefile 目标注释)+
`870bcb7`(TESTING.md 同步)+ `5db69f0`(worklog)。

## 结论

**APPROVE**。无 P1/P2;2×P3(非阻塞,一致性 nit 与信息性边界)。

## 审查过程(反向追踪,不顺着 commit message 走)

按 reviewer 反模式清单(类型补丁 / 断言锚定值)逐条确认消费端:

1. **findings_line 单一 printf、两视图真实消费**:L286 定义,L303(`prog_weekly` END 首行)与
   L412(`prog_overview` END)两处插值——逐字节一致由构造保证;运行时实测默认视图首行与
   overview findings 行 diff 为空(`findings    P1 48/P2 49/P3 124 · 未分级 70篇/总 102篇=记录数`)。
   非「变量提了没人读」。
2. **总N=记录数是口径修正而非改格式**:`total` 在两个聚合程序里都逐记录 `++`,与 tsv 记录数
   102 一致;`findings total=recs` 守卫把 overview 行解析出的 总(102)对齐外部真值 tsv(102)。
   #26769 的分解恒等(P1+P2+P3+未分级==总,恒真式)确认已从 mode_check 移除,替换为三条
   可失败断言(weekly headline / findings total=recs / ungraded<=total,均对齐 tsv 外部真值)。
3. **weekly headline 守卫的覆盖面用注入验证(非只验误报)**:临时目录副本(`<tmp>/scripts/`
   布局,踩坑 #3)三连注入全部精确命中——weekly 侧 `f1 += $5 + 2` → `FAIL weekly headline`
   (P1 252)、weekly 侧 `un += 200` → `FAIL weekly headline`(未分级 14000篇)、oft 解析 +1 →
   `FAIL findings total=recs 103 (expected 102)`,均退出 1;恢复后 check 全绿。#26770 声称的
   盲区(corpus 级 f1/un 累加漂移对旧守卫不可见)确认被关闭,且失败值与 worklog 记录逐字一致。
4. **周行锚是承重墙**:headline 行同样含「P1 48」字样,`wkl`/`ws` 若无
   `$1 ~ /^[0-9]{4}-W[0-9]{2}$/` 锚(L455/460)会把首行数字并进周行求和 → op1/wp1 双计必
   FAIL——check 全绿反证锚生效。这也是 #26769 踩坑 #2 的对策落点,确认在码。
5. **bwk-awk `-v` 单参数对策在码**:L460 `awk -v "lvl=$1"`(#26769 踩坑 #1)。
6. **gate 无关声明三处落点核实**:脚本头 Gate status 段(L50-53)、Makefile review-stats 目标
   注释(L66-67)、TESTING.md(gate 无关条目);build/test/cover/CI 链对脚本零引用,仅独立
   target 可达——「纯信息性、禁接门禁」写进了消费面最近的位置(cover-check 正下方)。
7. **oft 解析重锚必要性确认**:findings 行尾从数字改为「=记录数」,旧 `[0-9]+$` 尾锚确实失明;
   新锚 `/总 [0-9]+/` + ASCII 数字回走只对整行跑正则(towc 安全),与 oun 同技法。
8. **零记录路径全覆盖**:空语料 / 纯非 review 语料下四视角 + check 全部 "no review records
   found" 退出 0;空 headline 的 `weekly headline` 守卫按 ""=="" 通过,无假失败。

## 验证

全部复跑(非转述实现侧 worklog):默认 / --overview / --check / --help(=0)/ 未知参数(=2)
退出码;首行与 overview findings 行 byte-identical;`--check` 16 守卫 ok 退出 0;注入 3 连正负
向(副本目录,备份恢复后与仓内逐字节 diff 空);零记录 4 视角 + check 退出 0;回归
`--by-issue`/`--by-severity`/周行输出与 `870bcb7`(改动前)逐字节 diff 为空;LC_ALL=C vs
en_US.UTF-8 输出一致;`bash -n` 干净;`make review-stats` 裸跑与 `ARGS=--check` 均 0。
Go/前端零改动,无 UI/binding/event 面,三端矩阵不适用(§4.7)。

复审自身两次踩 #26769 踩坑 #3 / 踩坑 #2 的变体(pre 版脚本放 /tmp 根 → root=/tmp 空语料假
DIFF;perl 注入锚 `^oft=` 漏行首 TAB → 静默脱靶,check 仍全绿)——踩坑记录的警告被反向验证:
守卫实验前必须先确认注入真的生效,否则负向实验会假绿。

## 发现(非阻塞)

- **P3-1 `ovf` 未进 local 声明清单**:mode_check L444 声明了 `… oun oft wvf fail=0`,唯独
  解析 overview findings 行的 `ovf`(L467)漏排——函数内先赋值后读取,`set -u` 不炸,纯一致
  性 nit;可与 coder 下个改动顺手补进声明行。
- **P3-2 乘数扫描跨方向边界 quirk**:`scan_mul` 对每个 `×` 边界双向验证,`traildigits`/
  `startstok` 各自只查自己一侧——若语料出现 `P1×P2` 相邻 token 形态,`traildigits("P1")=1`
  会给 `mul[P2]` 虚增 1。语料实测(`grep -Eo`)乘数标注仅 `N×P` / `P×N` 双向共 24 处、
  `P[123]×P[123]` 零出现,且头注释已把 findings 总数钉为「ordered magnitude, not exact issue
  counts」——信息性,无行动;若未来语料出现 P×P 形态再收口(§5.3 不为不存在的形态堆 if)。
- (观察)`ck "tsv records" "$tsv" "$tsv"` 为自比较恒真,仅作基线数展示;真实断言由
  `funnel nrec`(tsv vs pass-1 nrec)承担,无需改动。

## 下一步

- 无阻塞事项;#26764 口径钉死系列(总览行 / 周趋势默认两段 / 三坑对策 / 总N=记录数 / gate
  无关)全部验收点核实通过。P3-1 备忘给 coder。
