# 2026-08-28 · review-stats 补齐 P1/P2/P3 分级 + make 目标 + TESTING 文档(Task #26766)

## 起因

#26765 落地的 `scripts/review-stats.sh` 只有周趋势与 `--by-issue` 两个视角,任务 #26764/#26766 要求补齐三件事:**P1/P2/P3 分级统计**、**Makefile 目标**、**TESTING.md 文档**。本条记录分级语义的取舍与一个 bwk-awk 的 locale 坑。

## P1/P2/P3 分级语义(设计核心)

review 记录里 P1/P2/P3 的出现形态**高度异构**:finding 标题(`### 🔴 P1(...)`、`### #1 [P1]`)、加粗 bullet(`**P2(已修)**`)、行内散文、复审对原 review 的转述、修复闭环陈述。逐条 counting finding slot 需要解析每一种排版,必然脆弱(§5.3:找不变量,不堆 if)。

收敛出的稳定不变量:**记录级提及面(presence)**——一条 review 记录的文件全文里按词边界出现过 `P1`/`P2`/`P3`,该级就计入一次;同文件同级多次出现不重复计。这与 verdict 提取的既有哲学一致(信息性提取,不参与分类):它回答「多少 review 提过 P1 级问题」,不回答「总共多少个 P1 finding」(后者在异构数据源上不可靠)。词边界规则:`P12`/`XP1` 不算,`P3-a`/`P2/P3` 算。

落地:

- pass 1 TSV 增加第 4 列 `sev`(逗号连接的有序级别集,无 token 为 `-`);新增 `scan_sev`(整行正则按 token 各扫一遍,边界上下文折叠进 pattern)。
- 新模式 `--by-severity`:各级别「提及该级的记录数/占比」+ 无 token 桶 + 总数。
- `--by-issue` 增加第 5 列:该锚点全部记录的级别**并集**,输出形如 `#91  1  date → date  [P1,P3]`。
- 周趋势模式不动(吞吐与分级是两个正交视角,KISS)。

## 踩坑记录(都修了)

1. **bwk-awk(macOS awk 20200816)对 `substr()` 切出的子串做正则会 towc 崩**:`prev !~ /[A-Za-z0-9]/`(prev 是切出的邻接字符)在 `LANG=C.UTF-8` 下报 `towc: multibyte conversion failure` 整体退出 2——即便文件是合法 UTF-8。初版 scan_sev 的「切邻接字符再判边界」写法全量跑必炸;改成**边界上下文折叠进整行正则**(`line ~ "(^|[^A-Za-z0-9])" tok "($|[^A-Za-z0-9])"`,每 token 一次、presence-only 无重叠问题)后干净。对整行做正则(既有 verdict/anchor 规则的路径)不受影响。
2. **awk 程序是 bash 单引号字符串,注释里不能有撇号**:`anchor's`/`don't` 两处 awk 内注释把单引号闭合,`bash -n` 直接 EOF 错。awk 字符串内注释一律避免缩写撇号。
3. **独立基线自身先出过一次假 diff**:python 基线用 `finditer(r'(?:^|[^A-Za-z0-9])(P[123])(?:$|[^A-Za-z0-9])')` 消费了邻接定界符,`P1/P2/P3` 里 P2 被吞(P1 的尾定界吃掉了 P2 的头定界)→ 基线少 3 个 P2。改 lookaround(`(?<!...)/(?!...)`)零宽断言后与脚本全量一致。教训:对照实现要用零宽边界,消费型边界在相邻 token 场景必错。

## 改了哪些文件

- `scripts/review-stats.sh`:pass 1 加 `scan_sev`/`sevstr` + TSV 第 4 列;`--by-severity` 新模式;`--by-issue` 加级别并集列;头注释/usage 同步。
- `Makefile`:新增 `review-stats` 目标(`ARGS=` 透传子命令),`.PHONY` 同步。
- `TESTING.md`:新增「review 统计」小节(三个视角的用法 + 分类不变量 + 分级语义「记录级提及面」口径)。
- `docs/worklog/2026-08-28-review-stats-p123-grading-make-testing-26766.md`:本条。

## 验证

- **独立基线(python 重实现)**:分类不变量 + 分级扫描全独立实现,与脚本逐项比对——记录总数 102 一致;P1/P2/P3/无 token 四桶(16/17/31/70)一致;`--by-issue` 全部锚点的计数与级别并集逐一一致(修掉基线自身的 lookaround bug 后)。
- **合成夹具(临时目录,脚本副本 + 6 个构造 worklog)**:行首 `P1`/行尾 `P3`(边界 `$`/`^` 分支)、`P12`/`XP1` 不计、`P3-a`/`P2/P3` 计入、无 token 记录为 `-`、preview 剥除排除、无结论 marker 的候选排除(即使提了 P1)、旧格式 H1 verdict 记录照常入计——全部符合预期。
- **回归**:`--by-issue` 锚点计数与 #26765 worklog 记录的抽查值一致(`#106=3`/`#83=2`/`#138=2`/`#139=2`);周趋势 total 102 不变。
- `bash -n` 干净;`--help`=0、未知参数=2 零记录语义保留;`make -n review-stats` / `make review-stats ARGS=--by-severity` dry-run 与实跑过。
- shellcheck 本机未装(未跑,与 #26765 相同)。

## 下一步

- 若要「逐条 finding 计数」口径,需 harness 侧约定 finding 的稳定标记(如统一的 `- [P1]` 前缀),纯解析不可靠——先有数据约定再做统计。
- `--since/--until`、`--json` 仍按 #26765 的「下一步」搁置,任务未要求。
