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
- **`scripts/coverage.floor.pkgs`** — **分包 floor**,一行 `<包> <floor>`(按包名排序):每个 `internal/` 包各自一道棘轮。floor 值写 `-` = **豁免**(该包不受棘轮约束,只打 EXEMPT 提示)——留给测无可测的框架胶水包(当前仅 `internal/update`:wails updater + GitHub Releases 网络胶水,单测只够到 shouldAutoCheck)。profile 里出现没有 floor 行的包 = FAIL(防「加新包逃逸棘轮」);floor 行对应的包已不在 profile(删包/改名)只 WARN,不挡,`--set-pkgs` 时自然重写。
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
