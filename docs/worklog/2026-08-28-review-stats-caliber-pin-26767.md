# 2026-08-28 · review-stats 计数口径钉死——总览漏斗+跨视角守卫(Task #26767 / #26764)

## 起因

#26764 要求钉死 review-stats 的计数口径,覆盖「总览 + 周趋势 + by-issue 计数」三处。#26765/#26766 已落地三个聚合视角,但口径只存在于文档描述里:没有任何一处把「到底数了什么」摆在输出明面,也没有机制防止未来改动聚合程序时单视角计数悄悄漂移。(issue #26764 原文不可达——gh 未认证——按任务标题做了上述解读,已在 commit message 注明。)

## 设计

- **pass 1 追加 `#stats	nscan	ncand	nrec` 元行**(语料数/文件名命中数/分类记录数):漏斗数字与记录集出自同一次 awk 扫描,单一事实来源;四个聚合程序首规则统一跳过。
- **`--overview`(总览)**:一屏输出分类漏斗(corpus → candidates → records → excluded)+ 日期跨度 + 周趋势头条(ISO 周数/起止)+ by-issue 头条(锚点数/未锚定数/最大锚点)。最大锚点平局取小 id(如 #106 与 #126 同为 3 时显 #106),保证显示确定。
- **`--check`(口径守卫)**:逐视角**实跑**并解析各自上报的 total(tsv 记录数、漏斗 nrec、weekly total、weekly 分桶和、by-issue total、by-issue 分锚和、by-severity total、overview total)互相印证,外加漏斗序断言 nscan≥ncand≥nrec。断言的是消费方真正看到的输出而非共享 TSV——改坏任一聚合程序无法只改一个视角的数字而不被发现。漂移退出 1。

## 顺手修的两个零记录 bug(钉死口径必须连零角一起钉)

1. **空语料崩溃**:`set -u` 下空数组 `"${files[@]}"` 在 bash 3.2 是 unbound variable 崩溃,且 awk 无文件参数会阻塞读 stdin → 显式走零记录路径。
2. **by-issue 零记录假行**:聚合阶段打印的 "no review records found" 会穿过 sort 进入格式化 awk,渲染成 `#  0 → []` 假行 → 消息移到格式化阶段(NR==0 分支),total 改由行内 tsum 求和(Σ每锚点计数==总数,口径自证),顺带删掉外置 `grep -c`。

## 踩坑(1 个,已修)

全量重写脚本时把 pass 1 收尾 `' "${files[@]}")"` 丢了一个尾部 `"`——`bash -n` 报错位置在 40 行外的 prog_overview 里(引号状态跨整个文件级联,AWK 程序里的双引号全部错误翻转状态),截断二分与自写引号状态跟踪全被误导;最终对照 HEAD `od -c` 逐行 diff 才定位。教训:重构 self-contained 脚本优先小步 edit;重写落盘后**立刻** `bash -n`,不要先跑行为测试。

## 改了哪些文件

- `scripts/review-stats.sh`:pass 1 漏斗计数 + 元行;`--overview`/`--check` 两个模式;pass 2 重构为变量式 awk 程序(与 agg_common 同风格);零记录两 bug 修复。
- `TESTING.md`:review 统计小节补全四视角用法 + 「计数口径已钉死」说明 + 零记录路径。

## 验证

- **回归**:weekly / by-issue / by-severity 三模式输出与改动前(git show HEAD 版本)逐字节 diff 为空(每个 commit 后各验一次)。
- **口径一致**:records=102 与 #26765 逐文件审计值一致;锚点 89 独立 + 2 未锚定 = 90 桶与基线 NR 一致;max #106=3;漏斗 384≥108≥102(6 排除 = 4 个已知 fix 跟进 + 2 篇 review-stats 实现日志,均无结论 marker,合理)。
- **守卫正/负向**:真实语料 `--check` 全 ok 退出 0;向 weekly 聚合注入 `total += 2` → check 精确报 `FAIL weekly total 204 (expected 102)` 退出 1,其余视角保持 ok。
- **零角**:空语料 / 纯非 review 语料下四视角 + check 全部 "no review records found" / 全 0 通过,退出 0。
- `bash -n` 干净;`--help`=0、未知参数=2;`make review-stats ARGS=--overview|--check` 过。shellcheck 本机未装(未跑,同 #26765/#26766)。

## 下一步

- verdict 分布、`--since/--until`、`--json` 仍按 #26765 结论:需要时再加,当前未做(KISS)。
- 语料增长后 candidates/records 会自然上行;`--check` 保证增长时四视角仍同源,无需人工对数。
