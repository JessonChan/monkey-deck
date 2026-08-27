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

后端测试覆盖率走**单向棘轮(ratchet)**:floor 只许涨不许跌,挡住「删测试 / 加不可测代码稀释覆盖率」的静默回归。

### 三个 make 目标

| 目标 | 干什么 | 产物 |
|---|---|---|
| `make cover` | 跑 `./internal/...` 全部单测(`-covermode=atomic`),末行打印总覆盖率 | `coverage.out` |
| `make cover-html` | = `cover` + 生成 HTML 报告(浏览器打开逐行看未覆盖分支) | `coverage.html` |
| `make cover-check` | = `cover` + floor 守门:总覆盖率 < floor 即失败(返回非零) | — |

产物 `coverage.out` / `coverage.html` 均已 gitignore,不入库。

### floor 守门(scripts/coverage-floor.sh)

- **floor 存在 `scripts/coverage.floor`**:一行数字(当前 = `69`,落地当天实测 69.2% 向下取整,留余量抗工具链噪声)。
- `make cover-check` 底层跑 `bash scripts/coverage-floor.sh coverage.out`:总覆盖率 ≥ floor → OK;低了 → exit 1 并提示。
- 也可单独调用:`./scripts/coverage-floor.sh [profile]`(profile 默认 `coverage.out`)。

### 抬杠 / 重定基准

```bash
# 涨了覆盖(补了测试)之后:
make cover                                    # 确认总覆盖率已高于 floor
bash scripts/coverage-floor.sh --set          # 把实测值写入 coverage.floor
git add scripts/coverage.floor && git commit  # floor 与代码同一批提交

# 删码 / 重构导致实测下降:确认没有测试损失(测试只删不必要、不删有效断言)后,同样 --set 重定基准。
# 临时演练失败路径:COVERAGE_FLOOR=99 make cover-check(不落盘)。
```

### 口径说明

- **只统计 `./internal/...`**:根 `package main` 没有测试文件,且其 `go:embed` 依赖 `frontend/dist` 构建产物(空目录时连构建都过不了),计入只会引入噪声。所有可测逻辑都在 `internal/` 各包(§1.7 胖后端)。
- **前端暂不设 floor**:组件测试用 `bun test --coverage` 可手动查看,但前端改动的主验收是三端矩阵验证,不做数值守门。
- 总覆盖率随 Go 版本可能有零点几个百分点的漂移,floor 取整留了余量;若工具链升级导致误报,按上面的重定基准流程处理并在 commit 说明。
