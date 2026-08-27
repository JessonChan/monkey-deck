# 2026-08-28 · 覆盖率终轮收敛:守门 fresh clone 自爆修复 + floor 表豁免 + 去 HTML + 钉死目标名(#26759)

## 起因

#26721 的三族棘轮在本机(有历史生成物的工作区)全绿,但**fresh clone 上一跑 `make cover-check` 就自爆**。本次终轮收敛把这个洞补上,顺手把目标面收敛到最终形状。

## 根因:fresh clone 自爆的完整链条

`frontend/bindings/` 是 gitignore 的生成物(`wails3 gen bindings` 产出,不入库),而 `frontend/src` 大量 `import ... from "../bindings/..."`。三个疑点层逐一实证(在本仓库一个「裸」worktree 上复现,无 node_modules / bindings / coverage 产物):

1. **无 node_modules** → `bun test` 报 `Cannot find package 'happy-dom'`(setup 缺失,信息尚可读);
2. **`bun install` 后仍无 bindings** → `bun test` 3 fail + 3 errors 全是 `Cannot find module '../../bindings/...'`(Composer / RemoteSettingsPane 直接 import),**exit 1** → `make cover` 失败 → 守门根本没跑到就自爆;
3. `tsc` 同理(TS2307)——`dev`/`build-frontend`/`build` 都声明了 `bindings` 前置,**唯独 `cover` 漏了**,而它是唯一碰前端测试的目标。

根修法:**`cover: bindings`**,与兄弟目标同一前提;另加 node_modules 前置守卫(缺依赖时一行 remedy 退出,不再喷一墙 bun 错误)。

## 方案与决策

1. **校准 floor 表 = 加豁免语法**。实测校准发现数值全部仍准(go 总 69.2 / 前端 64.7 / 14 包逐包一致),唯一「校准」点是 `internal/update 5`:框架胶水包(wails updater + GitHub Releases 网络调用),单测只够到 `shouldAutoCheck`,5% 的 floor 是噪声,只能产生「无出口的假失败」。floor 表新增 **值 `-` = 豁免**:`internal/update 5` → `internal/update -`,check 时打 `EXEMPT` 行不参与棘轮,摘要显示 `14/15(1 包豁免)`。豁免是**显式登记**而非删行——包仍在表里可审计,新包仍必须交行。
2. **`--set-pkgs` 保留豁免行**:重定基准时数值全部重测,`-` 原样带过(awk 逐包查旧表,无关联数组,继续兼容 macOS bash 3.2)。
3. **去 HTML**:`cover-html` 目标删除(不对称:bun 无 HTML reporter,一族独享一个目标只为出一份 Go-only 报告)。能力保留为零成本一句话:`go tool cover -html=coverage.out -o coverage.html`(profile 本来就在)。`.gitignore` 删 `coverage.html`。
4. **钉死目标名**:终态 = `cover`(度量)+ `cover-check`(守门),Makefile 注释与 TESTING.md 都标注**名称钉死不改名**。CI 若未来挂必过门,挂 `make cover-check`。
5. **边界说明**:CI 的 frontend job(`bun install` + `bun run build` = tsc 在前)在 fresh checkout 上同样会因缺 bindings 报 TS2307——同一类坑但**不是守门的一部分**,且修复涉及「CI 里装 wails3 / 提交 bindings stub」的取舍,记 OPEN 不顺手改(不夹带)。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `Makefile` | `cover: bindings` + node_modules 前置守卫;删 `cover-html` 目标与 `.PHONY` 项;`cover`/`cover-check` 注释标钉死;ad-hoc HTML 一句话进注释 |
| `scripts/coverage-floor.sh` | 分包循环加 `-` 豁免分支(EXEMPT 不 fail);摘要带豁免计数;`--set-pkgs` 保留豁免行;头部注释同步(去 coverage.html、记豁免语法) |
| `scripts/coverage.floor.pkgs` | `internal/update 5` → `internal/update -` |
| `.gitignore` | 删 `coverage.html` 行 |
| `TESTING.md` | 「三个 make 目标」→「两个 make 目标(名称钉死)」;cover 行写 fresh clone 自建 bindings;floor 守门节写豁免语法;产物清单去 coverage.html;口径说明加「fresh clone 起步」一条 |
| 前端 / Go 源码 | **零改动**(纯度量基建) |

## 验证

- **fresh clone 端到端(真实路径)**:删净 `frontend/bindings`、`frontend/coverage/`、`coverage.out` 后 `make cover-check` → 自动生成 bindings → go test 15 包 → bun 373 pass 0 fail → 守门三族 OK → **exit 0**(49s)。
- **缺 node_modules 演练**:移走后 `make cover` → 一行 remedy(「先执行: (cd frontend && bun install)」)退出,不再喷 bun 模块错误;还原后无残留。
- **豁免路径**:`EXEMPT internal/update(5.9%)` + `OK 分包 floor 14/15(1 包豁免)`,exit 0。
- **失败路径回归**:删 `internal/fsview` floor 行 → FAIL exit 1(新包无行同路径,未回退 #26721 行为)。
- **`--set-pkgs` 往返**:重写后豁免行原样保留,数值行为与 #26721 一致。
- **bash 3.2**:`/bin/bash`(系统 3.2)实跑守门 exit 0;`bash -n` 干净。
- **`make cover-html`** → `No rule to make target`(目标已删)。
- **floor 校准核对**:go 总 69.2≥69、前端 64.7≥64、其余 14 包实测与 floor 逐包吻合,无需改数值。
- **三端(§4.7)**:`frontend/` 源码零改动、无 UI/binding/event 面,三端矩阵不适用;前端测试套件(373)作为守门输入全绿即本任务前端面验证。Go 门:`go test ./internal/...` 全绿(守门内含),Go 源码零改动故 `go build`/`go vet` 面未变。

## OPEN / 下一步

- **CI frontend job 的同类自爆**(fresh checkout 缺 bindings → tsc TS2307):待定修法(CI 装 wails3 先 gen,或 build 脚本前置 gen bindings),单独任务处理。
- `internal/update` 豁免是登记不是赦免:哪天 updater 逻辑长出可测分支(如 SHA256SUMS 解析、版本比较),把 `-` 换回实测 floor 抬杠。
