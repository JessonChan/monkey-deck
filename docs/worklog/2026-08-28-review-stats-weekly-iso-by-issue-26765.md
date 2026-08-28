# 2026-08-28 · review-stats 统计脚本——周趋势聚合+ISO 周+--by-issue(Task #26765)

## 起因

AI dev team 的 review 记录全部沉淀在 `docs/worklog/`（reviewer 每审一次落一条 worklog），但没有任何聚合视角:每周审了多少、趋势如何、每个 issue/anchor 被审几轮,全靠肉眼翻文件。本任务落地 `scripts/review-stats.sh`,从 worklog 记录聚合出这两类统计。

## 数据源与分类不变量（设计核心）

worklog 记录的格式**异构**（两个时代的 review 记录结构完全不同）,逐条排查后收敛出稳定不变量:

- **时间轴 = 文件名日期前缀** `YYYY-MM-DD`:worklog 约定（`docs/worklog/README.md`）保证每条自带日期;git commit 日期受 merge 顺序漂移,不用。
- **候选集 = 文件名含 `review`**（大小写不敏感;先 strip `preview`——它内嵌 `review` 子串,会把 preview 类 worklog 拖进来）。
- **review 记录 = 候选 ∧ 携带结论标记**,二选一:
  1. **结论 marker**:任何提及 `结论` 的标题行（`结论` / `验收结论` / `审查结论` / `Review 结论总览` / `核查结论`…格式很多）或以 `结论` 开头的裸行;
  2. **H1 verdict token**（旧格式）:2026-08-09/08-10 时代的 review 结论直接写在 H1 里（`# 2026-08-10 Review #83 ... (APPROVE, Task #24257)`）,全文件无结论 section。
- **排除 = review 缺口修复跟进**（`修复 review … 缺口` / `*-review-*fix*`,落地记录风格,既无结论 marker 也无 H1 verdict）——它们是 Coder 侧活动,不是 review 活动。逐文件审计确认:105 个候选中恰好排除 4 个 fix 跟进,102 条记录全部是真 review。
- verdict 关键词（`PASS|APPROVE|REQUEST[ _-]?CHANGES|BLOCKED|通过`）只做**信息提取**,不参与分类——隐式结论（无关键词）的 review 同样计数。

锚点（`--by-issue` 的分组键）= H1 里**第一个** `#NNN` token:即该 review 挂靠的 issue/review-cycle id（`#138` 或 reviewer 任务号 `#24356` 这类）。`MON-xxx` 外部 id 不匹配。

## ISO 周（纯 awk,无 date 二进制依赖）

- Hinnant civil-date 算法做天数换算（1970-01-01 = day 0）;年份域 ≥1970,`int()` 截断即 floor。
- **周标签锚定周四**:ISO 周由该周的周四唯一确定（week 1 = 含首个周四）,先归一化到周四再算,`week<1`/`week>53` 边界分支整体消失。
- 周趋势桶以**周一**为键,首末活动周之间的空周补 0 行（趋势不断章取义）。
- 12 个边界用例（含 53 周年:`2015-W53`/`2020-W53`/`2026-W53`;跨年 W01:`2024-12-30→2025-W01` 等）与 macOS BSD `date +%G-%V` 全量一致;周计数与 date 二进制独立基线逐周 diff 为空。

## 改了哪些文件

- `scripts/review-stats.sh`（新增,可执行）:两遍 awk——pass 1 扫 `docs/worklog/*.md` 抽 `date\taNchor\tverdict` TSV;pass 2 聚合。默认周趋势（`YYYY-Www  N  ███`）,`--by-issue` 出 per-anchor 计数+首末日期（按计数降序）。`--help` 退出 0,未知参数退出 2,零记录打提示退出 0。

## 验证

- 独立基线 1:macOS `date -j -f +%G-W%V` 逐条日期换算后分桶,与脚本周表 diff 为空（脚本在首末活动周之间补 0 行,如无活动的 W34,对比时单列确认）。
- 独立基线 2:git log 里 `docs(worklog): review` 前缀的 uniform commit 恰 80 条;脚本最终 102 = 80 uniform commit 对应记录 + 旧格式 H1-verdict 文件 + 隐式结论 review,差值逐个人工核对为真。
- 逐文件审计:105 候选 − 102 记录 = 恰好 4 个 fix 跟进（`*-paste-fold-chip-fix` / `review-24335-fix-*` / `review-fix-24348-*` / `stt-review-fixes-24310`）,零误伤。
- 锚点抽查:`#106=3`（export-session 三连）、`#83=2`（拖拽前后端）、`#138=2`、`#139=2`、`#142=1`（前端移除记录 H1 无 #142,锚到 #26717,符合首 token 规则）。
- `bash -n` 干净;`--help`=0、未知参数=2;shellcheck 本机未装（未跑）。

## 踩坑记录（都修了）

1. Hinnant `year_of` 的 `mp >= 10 ? y+1 : y` 一度写反 → 全部年份 +1、周数为负;又在中途编辑丢失过 `era = int(n/146097)` 行 → era 恒 0 全盘错。最终靠 12 边界用例 + date 二进制基线钉死。
2. 结论标题行规则带 `next` 会跳过标题行本身 → `## 结论:**PASS...` 同行格式全漏;改为「标题行可扫,区域闭合规则排除结论标题」。
3. 子标题携带结论（`### 1. xxx —— PASS`）会被区域闭合规则先关再扫 → 扫描规则前置于标题状态更新。
4. `preview` 含 `review` 子串;文件名匹配前先 strip。

## 下一步

- 需要时再加 `--since/--until`、`--json`、verdict 分布统计;当前未做（任务未要求,KISS）。
- 若后续 worklog 出现新的结论格式（新关键词/新标题变体）,扩充 pass 1 的关键词与 heading 正则即可,聚合层不动。
