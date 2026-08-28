# 2026-08-28 · review-stats 逐条计数——总览 findings 行+周趋势 breakdown+行去重+乘数展开(Task #26769)

## 起因

#26766 落地的分级统计是「记录级提及面」口径(一条记录提过 P1 就计一次),回答不了「总共审出多少个 P1/P2/P3 finding」。#26769 要求升级为**逐条计数**:总览加一行「P1a/P2b/P3c·未分级n/总N」,周趋势每行改「Wnn:P1x/P2y/P3z(n篇)」,计数规则为**行去重**(同一行同级多次提及算同一条)+**乘数展开**(`P3×4`/`2×P1` 算 N 条)。

## 设计

**语料先验证(§5.3)**:全量 grep 114 篇 review worklog——乘数写法只有 `×`(U+00D7)一种分隔符、`P2×2` 与 `2×P3` 双向两种语序(共 15 处),ASCII `x/X/*` 变体零出现。同时确认三类已知失真:`无 P1` 否定句、同行下标兄弟(`P3-a/P3-b`)、H1/结论/正文跨行复述同一 tally。逐条计数按任务口径只做行去重+乘数展开,三类失真记为信息性限制(修它们需要否定句/语义解析启发式,正是 §5.3 反对的「堆 if」)。

**双口径分工**:pass 1 TSV 从 4 列扩到 7 列——原 `sev`(presence 并集,喂 by-issue/by-severity,不变)+ 新 `p1/p2/p3` 逐条计数(喂 overview/weekly)。两个口径共存,by-issue/by-severity 语义零变化。

**乘数扫描的 bwk-awk 约束**:26766 踩过「对 substr() 切出的子串做正则 → towc 崩」的坑。本轮扫描器全部用**纯字符串操作**实现(`substr` + `index`/`==`,零衍生串正则):按 `×` split 后逐边界双向验证(左尾 `endstok`+右头 `leaddigits` = P×N;左尾 `taildigits`+右头 `startstok` = N×P),边界字母表检查用 `index()` 查表。实证:LC_ALL=C 与 en_US.UTF-8 输出逐字节一致。

**计数规则**:每(行,级别):该行有乘数标注 → 计乘数和;仅有裸 token → 计 1(行去重)。乘数标注与 presence 用同一词边界规则,两者不会矛盾。

**`--check` 扩展**:新增 5 条守卫——weekly 各行 `(n篇)` 之和 = 记录总数(替换旧的 $2 列解析,行格式变了)、weekly 逐级别和 == overview 逐级别值 ×3、`P1+P2+P3+未分级 == 总` 分解恒等。多字节标签(未分级/总/篇)的数字提取全部锚定 ASCII(`/\([0-9]+/`、`/P1 [0-9]+/`、匹配后从匹配区尾部反向走 ASCII 数字),不依赖 locale 的字节/字符长度语义。

## 改了哪些文件

- `scripts/review-stats.sh`:pass 1 加 `isalnum/ltrim/rtrim/endstok/startstok/leaddigits/traildigits/scan_mul` + 重写 `scan_sev`,TSV 扩 7 列;`prog_weekly` 行格式加 `P1 x/P2 y/P3 z(n篇)`;`prog_overview` 加 findings 行;`mode_check` 加 5 条 findings 守卫;头注释/usage 同步。
- `TESTING.md`:review 统计小节改为「两个口径按视角分工」结构,记录逐条口径规则、已知失真、findings 守卫与注入实验结果。
- `docs/worklog/2026-08-28-review-stats-per-finding-26769.md`:本条。

## 验证

- **独立基线(python 重实现,零宽 lookaround + 独立乘数解析)**:记录 102、P1 48/P2 49/P3 124/未分级 70/总 291——与脚本 overview 逐项一致。
- **回归**:`--by-issue`/`--by-severity`(记录级口径两视角)与 HEAD(git stash 前后)输出逐字节 diff 为空。
- **合成夹具(临时目录 8 文件)**:同行裸复述 P1=1、`P1×2`+`2×P3`+复述裸 P1 → P1=4/P3=2、`P3×4,无 P1` → P3=4/P1=1(否定句计入,已知失真)、`P12`/`XP1` 不计、`P3-a` 计入、跨行同级=2(行是去重单位)、旧格式 H1 verdict 无分级记录入未分级桶、preview 剥除、无 marker 候选排除——全部符合预期。
- **locale**:LC_ALL=C 与 en_US.UTF-8 全视图输出一致(towc 规避实证)。
- **`--check` 正/负向**:真实语料 14 条 ok 退出 0;注入实验(weekly 侧 wp1+2/条 → `FAIL findings P1 4 (expected 2)`,overview 侧 f1+3/条 → `FAIL findings P1 2 (expected 5)`)均精确命中退出 1,其余守卫保持 ok。
- **零记录路径**:空语料/纯非 review 语料下四视角 + check 全过退出 0;`--help`=0、未知参数=2。
- `bash -n` 干净。shellcheck 本机未装(未跑,同 #26765-#26767)。

## 踩坑

1. **bwk-awk `-v` 必须单参数 `name=value`**:`awk -v lvl "$1"` 报 `invalid -v option argument: lvl` 退出 2——POSIX 形式就是 `-v var=value` 一个参数,拆开写 bwk-awk 不收。修法 `-v "lvl=$1"`。
2. **周行字段锚误锚**:check 解析周行的 `$1 ~ /^[0-9]{4}-W$/` 把 W 后的周号数字漏了(`$1` 是 `2026-W35` 不是 `2026-W`),恒不匹配 → 守卫全 0 假绿。修成 `-W[0-9][0-9]$`。教训:守卫解析器改格式时先对真实输出行跑一遍再接进 check。
3. **夹具脚本摆放**:脚本以 `dirname(BASH_SOURCE)/..` 定 root,复制到临时目录必须放 `<tmp>/scripts/` 下而非 `<tmp>/`,否则 root 指向临时目录的父级 → 空语料假绿(两次中招:夹具跑分、注入实验,均已修正重跑)。

## 下一步

- 已知失真(否定句/下标兄弟/跨行复述)若未来要消,正解是 harness 侧 finding 标注约定(如统一 `- [P1]` 前缀),与 #26766 的「下一步」同一条:先有数据约定再做统计。
- `--since/--until`、`--json` 仍搁置,任务未要求。
