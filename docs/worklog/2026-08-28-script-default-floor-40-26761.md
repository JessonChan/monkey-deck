# 2026-08-28 · 分包缺 floor 行改按脚本默认 40 校验,不再 FAIL(#26761)

## 起因

Task #26761:「floor 表字面替换+脚本默认 40(机械执行:命令已逐条给出,禁止改值)」。

任务到达时只带标题,逐条命令不在 payload 里,按仓库现状做最佳解释执行:

- **「floor 表字面替换」**:非核心包 floor 行面值 40 已由 #26760 落库(commit 993222e)。本任务核对 `scripts/coverage.floor.pkgs` 与 #26760 定稿逐行一致(核心四包 58/65/85/67、其余 10 包 40、`internal/update -`),**一个值都没动**(「禁止改值」)。
- **「脚本默认 40」**:#26760 明确留给后续的另一半——`scripts/coverage-floor.sh` 对「profile 里有、floor 表里没有行」的包此前直接 **FAIL**(#26721 的「防新包逃逸」设计)。这与校准策略(「其余包一律默认 40」)不一致:新包在 fresh clone 上同样可能因贴实测的紧 floor 误爆,且 FAIL 出口(补行 / `--set-pkgs`)对环境性漂移不适用。本任务把它改为**按默认 floor 40 校验**。

棘轮语义不放松:默认 40 仍挡粗放稀释(缺行包实测 < 40 照样 FAIL),新包不再「逃逸」也不再「必爆」,只是落到与其它非核心包相同的粗放口径。

## 方案与决策

- `scripts/coverage-floor.sh`:
  - 新增 `default_floor=40`(分包校验段顶部,注释指回头部 Calibration policy)。
  - 缺行分支由 `FAIL ... pkg_fail=1` 改为:`f="$default_floor"` + 打 **DEFAULT** 提示(stderr,与 WARN 同级:是「用了隐含值」的注意项,不是失败),随后落入既有的 `num_ok` / `ge` 链——DEFAULT 包低于 40 走同一句 FAIL 出口。
  - 头部注释两处同步:pkgs 文件格式说明补「无行 → 默认 40」;Calibration policy 段补「新包按同一默认 40 校验,不再硬失败」。
- 显式行、`-` 豁免行、stale 行 WARN、`--set` / `--set-pkgs` 逻辑**零改动**(`--set-pkgs` 整份重写回实测紧 floor 的语义维持 #26760 决策:校准策略不进重写逻辑)。
- `TESTING.md` floor 守门节:原「profile 里出现没有 floor 行的包 = FAIL(防加新包逃逸棘轮)」改为默认 40 口径(不 FAIL 也不逃逸,DEFAULT 提示,补行 / `--set-pkgs` 钉死更紧值)。
- 摘要行 `OK 分包 floor N/N(...)` 口径不变:DEFAULT 包参与计数(它确实被校验了)。

## 改了哪些文件

|文件|改动|
|---|---|
|`scripts/coverage-floor.sh`|`default_floor=40` + 缺行分支 FAIL→DEFAULT(落入同一校验链);头部注释两处同步|
|`TESTING.md`|floor 守门节缺行口径改为「默认 floor 40」|
|`scripts/coverage.floor.pkgs`|**零改动**(逐行核对与 #26760 定稿一致)|

## 验证

- **行为矩阵(合成探针,临时建 `internal/ghost` 两函数包 + `go test -coverprofile` 真实 profile,标量 floor 用 env 置 0 隔离分包族,验后即删)**:
  - ghost(无行)50% → `DEFAULT ... 按默认 floor 40 校验` + exit 0;同 profile 的 acp 显式行(58,实测 58.1)照常 OK、update 豁免行照常 `EXEMPT`、15 行表对不含包的 stale WARN 照常。
  - ghost(无行)0% → DEFAULT + `FAIL 分包 internal/ghost 0.0% < floor 40%` + **exit 1**——缺行包棘轮仍咬合。
  - 显式行收紧回归:临时把 acp 行改 99 → `FAIL 分包 internal/acp 58.1% < floor 99%` exit 1,显式行路径行为与改动前一致。
- **`bash -n` 干净;探针产物(`internal/ghost`、lcov、临时 profile、pkgs 备份)全数清除,`git status` 仅剩两个预期文件。**
- **`make cover-check` 全绿**:补装 `frontend/node_modules`(fresh worktree)后 exit 0——go 总 69.2≥69、前端 64.7≥64、`EXEMPT internal/update(5.9%)`、`OK 分包 floor 14/15(1 包豁免)`;15 包全有行,输出与改动前基线逐字一致(无 DEFAULT 行出现)。373 个前端测试全绿(守门内含)。
- **Go 门**:`go build ./...` + `go vet ./...` 干净(先 `bun run build` 补出 frontend/dist 供根 package go:embed——fresh worktree 既有前置,非本次改动;ld 的 macOS SDK 版本 warning 为环境噪声)。
- **三端(§4.7)**:`frontend/` 源码零改动、无 UI/binding/event 面,三端矩阵不适用;前端测试套件(373)作为守门输入随 `make cover` 全绿即本任务前端面验证。

## OPEN / 下一步

- 新包现在默认落 40 粗放棘轮;若某新包是核心主干(纯逻辑、值得贴地),建包当天手工补一行实测紧 floor,别等它漂移。
- `--set-pkgs` 仍会把缺行的新包按**实测值**写进表(把默认 40 抬成紧 floor),该模式的使用前提(#26760 的 ⚠ 警告)不变。
