# TESTING.md — 测试与覆盖率指南

> 怎么跑 monkey-deck 的测试、怎么看和守覆盖率。架构/阶段/纪律等规矩见 [AGENTS.md](AGENTS.md),本文件只管「怎么测」。

## 后端单测(Go)

```bash
make test                # go test ./...(全部后端单测)
make test-integration    # -tags=integration,启动真 opencode,见下
```

- ACP 行为靠接口注入 mock,单测**不启真 harness**(AGENTS.md §5.1);真 harness 集成测试用 `integration` build tag 隔离,需本机已装 opencode 并配好 model,CI 默认跳过。
- SQLite 测试一律 `t.TempDir()` 临时库,跑完即弃,不碰用户真实数据目录(§5.2)。
- 每个 bug 修复必须先配一个能复现它的测试,再修(§5.3)。

## 前端测试

```bash
cd frontend && bun test --isolate    # 组件 mount / 交互测试(happy-dom)
npm run build                        # tsc + vite build,提交前自检 TS/编译错误
```

- 改动 `frontend/` 后必须本地跑一遍前端测试;涉及 UI 的改动按 AGENTS.md §4.7/§5.6 的三端矩阵(桌面 GUI / 远程浏览器 / PWA)验证,worklog 写清三端结果。
- harness 的 verify 命令没有 TS gate,`npm run build` 要在提交前自己跑。

<a id="coverage"></a>
## Coverage(覆盖率度量)

覆盖率走**单向棘轮(ratchet)**:floor 只许涨不许跌,挡住「删测试 / 加不可测代码稀释覆盖率」的静默回归。度量覆盖两端:**Go 后端**(`./internal/...` 全部包)+ **前端**(`frontend/src`,bun lcov)。

### 两个 make 目标(名称钉死,不改名)

| 目标 | 干什么 | 产物 |
|---|---|---|
| `make cover` | 度量:Go 跑 `./internal/...` 全部单测(`-covermode=atomic`)打印总覆盖率;前端跑 `bun test --isolate --coverage`(text 摘要 + lcov)。自动先生成 bindings(`frontend/bindings/` 是 gitignore 的生成物,fresh clone 没有,bun test / tsc 都解析不了——曾致守门自爆);缺 `frontend/node_modules` 时直接报 remedy 退出 | `coverage.out` + `frontend/coverage/lcov.info` |
| `make cover-check` | 守门:= `cover` + floor 校验:go 总覆盖率 / **分包 floor** / 前端行覆盖率,任一低于 floor 即失败 | — |

想要 HTML 报告(逐行看未覆盖分支)不用专门目标,`coverage.out` 在手随时可出:`go tool cover -html=coverage.out -o coverage.html`。

产物 `coverage.out` / `frontend/coverage/` 均已 gitignore,不入库。

### floor 守门(scripts/coverage-floor.sh)

floor 数据在两个文件里(数值比较走 awk,支持小数):

- **`scripts/coverage.floor`** — 标量 floor,`<key> <value>` 每行一条:当前 `go 69`(总语句覆盖率,实测 69.2% 向下取整)、`frontend 64`(src 行覆盖率,实测 64.7% 向下取整)。取整留零点几 pt 余量抗工具链漂移。
- **`scripts/coverage.floor.pkgs`** — **分包 floor**,一行 `<包> <floor>`(按包名排序):每个 `internal/` 包各自一道棘轮。floor 值写 `-` = **豁免**(该包不受棘轮约束,只打 EXEMPT 提示)——留给测无可测的框架胶水包(当前仅 `internal/update`:wails updater + GitHub Releases 网络胶水,单测只够到 shouldAutoCheck)。**表里只放偏离默认值的行(#26762)**:当前 5 行 = 核心四包紧 floor + `internal/update -` 豁免,其余包**不写行**、由脚本按**默认 floor 40** 校验(#26761:不 FAIL 也不逃逸——新包仍受棘轮约束,打 DEFAULT 提示;要钉死更紧的值就手工补一行,或 `--set-pkgs` 整份重写);floor 行对应的包已不在 profile(删包/改名)只 WARN,不挡,`--set-pkgs` 时自然重写。
  **校准策略(#26760)**:只有**核心四包**(`internal/acp` / `chat` / `harness` / `store`,纯逻辑的 ACP 主干)保留贴实测的紧 floor;**其余包一律默认 40**——这些包的实测值随机器 / Go 工具链 / 平台漂移(如 `internal/terminal` 的 pty 覆盖),贴实测的紧 floor 在 fresh clone 上稳定误爆。40 仍挡粗放稀释,聚合稀释由 go 总 floor 兜底。⚠ `--set-pkgs` 会把整份重写回贴实测的紧 floor(含把默认 40 抬高),仅在确有意图时使用;单包抬杠直接手改对应行。

脚本用法:

```bash
./scripts/coverage-floor.sh [profile]   # 全量校验(profile 默认 <repo根>/coverage.out)
./scripts/coverage-floor.sh --set       # 标量重定基准:go + frontend 实测值写回
./scripts/coverage-floor.sh --set-pkgs  # 分包重定基准:整份按实测重写('-' 豁免行原样保留)
COVERAGE_FLOOR=NN / COVERAGE_FLOOR_FRONTEND=NN make cover-check   # 临时换标量 floor(演练失败路径,不落盘)
```

任一校验失败 exit 1,FAIL 信息自带该族的出口(补测试,或确认无测试损失后用对应的 `--set` / `--set-pkgs` 重定基准)。

### 抬杠 / 重定基准

```bash
# 补了测试、实测涨了之后:
make cover                                    # 确认实测已高于 floor
bash scripts/coverage-floor.sh --set          # 标量写回(单包抬杠直接手改 .pkgs 对应行)
bash scripts/coverage-floor.sh --set-pkgs     # 或整份分包按实测重写
git add scripts/coverage.floor scripts/coverage.floor.pkgs && git commit  # floor 与代码同批提交

# 删码 / 重构导致实测下降:确认没有测试损失(测试只删不必要、不删有效断言)后,同样 --set / --set-pkgs 重定基准。
```

### 口径说明

- **Go 只统计 `./internal/...`**:根 `package main` 没有测试文件,且其 `go:embed` 依赖 `frontend/dist` 构建产物(空目录时连构建都过不了),计入只会引入噪声。所有可测逻辑都在 `internal/` 各包(§1.7 胖后端)。分包百分比按「该包 covered statements / total statements」聚合,与 `go test -cover` 打印的包级数字一致。
- **前端统计 `frontend/src` 行覆盖率**(lcov `LH/LF` 求和),**排除生成物 `frontend/bindings/`**(gitignore 的机器生成代码)。注意 bun 只统计测试实际加载过的文件——测试没 import 的源文件不进分母,「整文件删测试」无法完全堵死,棘轮主挡渐进稀释。
- 覆盖率随 Go / bun 版本可能有零点几个百分点的漂移;floor 取整留了余量,若工具链升级导致误报,按上面的重定基准流程处理并在 commit 说明。
- **fresh clone 起步**:`(cd frontend && bun install)` + `make cover-check` 即可——cover 会自动 `wails3 generate bindings`(需要 wails3 在 PATH,与其他 make 目标同一前提)。守门不依赖任何本地残留状态:profile / lcov / bindings 全部现算或现生成。

## review 统计(scripts/review-stats.sh)

AI dev team 的 review 记录沉淀在 `docs/worklog/`(文件名含 `review` 的工作日志,一个 review 一条),`scripts/review-stats.sh` 把它们聚合成四个视角:

```bash
make review-stats                        # 周趋势(ISO 周,首末活动周之间的空周补 0);首行为语料级 findings 总览行,每行带逐条 P1/P2/P3 计数与记录数「(n篇)」
make review-stats ARGS=--overview        # 总览:分类漏斗(语料→候选→记录)+ 周趋势/by-issue 头条数 + 逐条分级行「P1a/P2b/P3c·未分级n篇/总N篇=记录数」(与默认视图首行同一行)
make review-stats ARGS=--by-issue        # 按锚点 issue 分组:计数降序 + 首末日期 + P1/P2/P3 并集
make review-stats ARGS=--by-severity     # P1/P2/P3 分级:提及该级的 review 记录数与占比
make review-stats ARGS=--check           # 口径守卫:所有视角记录 total 必须一致,周趋势与总览的逐条 P1/P2/P3 必须互相印证,findings 行「总N篇」必须等于记录数,漂移退出 1
./scripts/review-stats.sh --check        # 也可直接跑脚本(--help 看用法,未知参数退出 2)
```

- **分类不变量**:文件名带日期前缀 + 含 `review`(先剥 `preview`——它内嵌 `review` 子串),且携带结论 marker(结论标题/裸结论行)或旧格式 H1 verdict token;review 缺口修复跟进(落地记录风格,无结论 marker)不计入。
- **计数口径已钉死(2026-08-28,#26764/#26767)**:总览 / 周趋势 / by-issue / by-severity 聚合的是 pass 1 产出的**同一份记录集**,四处 total 恒等;`--overview` 用分类漏斗把口径摆在明面(corpus=全部 worklog 文件数 → candidates=文件名命中数 → records=携结论标记数,excluded=无 marker 的候选,即 fix 跟进/实现日志);`--check` 逐视角实跑并解析各自上报的 total 互相印证,任一聚合程序被改坏导致单视角漂移即 FAIL——它守护的是消费方看到的输出,不只是共享 TSV。
- **分级有两个口径,按视角分工**:
  - **记录级提及面**(既有,#26766):整文件按词边界扫 `P1/P2/P3` token(`P12`/`XP1` 不算,`P3-a`/`P2/P3` 算),一条记录内同级只计一次——`--by-severity` 与 `--by-issue` 的级别并集用这个口径。
  - **逐条 finding 计数**(#26769):`--overview` 的 findings 行与周趋势每行的 `P1 x/P2 y/P3 z` 用这个口径——按(行,级别)计数,**行去重**(同一行内同级多次提及算同一条 finding 的一次)+**乘数展开**(`P3×4` / `2×P1` 算 N 条,语料实证只有 `×` U+00D7、双向两种写法);`未分级n篇` = 零分级 token 的记录数,`总N篇=记录数` = 记录总数本身(#26770 起钉死为记录口径,取代 #26769 的 `P1+P2+P3+未分级` 混合总——同行并排两种单位:P1/P2/P3 按 finding 条数、未分级/总 按「篇」计记录数)。已知失真(信息性,不做启发式对抗,§5.3):`无 P1` 否定句仍计 1 条、同行下标兄弟(`P3-a/P3-b`)合并为 1 条、H1/结论/正文跨行复述同一 tally 会重复计——行是去重单位是有意选择。无任何 P token 的记录占大头是常态(隐式结论的 review 不带分级词)。
- **`--check` 的 findings 守卫**:周趋势各行 `P1 x/P2 y/P3 z(n篇)` 与总览 findings 行逐级别互相印证,默认视图首行与总览 findings 行逐字节相等(`weekly headline`),findings 行「总N篇=记录数」钉死(`findings total=recs`:`总` == 记录总数,取代 #26769 的分解恒等;外加 `未分级 ≤ 总`);注入实验(weekly 侧 f1+2/条、weekly 侧 un+200 → 均 `FAIL weekly headline`,oft 解析 +1 → `FAIL findings total=recs`)均精确 FAIL 退出 1。
- **gate 无关(#26770)**:本脚本纯信息性——`make test`/`make vet`/`make cover-check` 与 CI 均不调用它,任何验收门不消费其输出或退出码;`--check` 退出 1 只是给人看的口径漂移警报,禁止接入任何门禁链。
- 时间轴 = 文件名日期前缀(git commit 日期受 merge 顺序漂移);锚点 = H1 第一个 `#NNN`。ISO 周为纯 awk 实现(Hinnant 算法),无 GNU/BSD date 分歧。
- **零记录是显式路径**:空语料 / 纯非 review 语料下四个视角都打 "no review records found" 退出 0;`--by-issue` 的提示由格式化阶段输出(聚合阶段打印会穿 sort 渲染成假行,已修)。
