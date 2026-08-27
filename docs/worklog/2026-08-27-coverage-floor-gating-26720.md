# 2026-08-27 · 覆盖率度量落地:Makefile 三目标 + floor 棘轮守门脚本 + TESTING.md(#coverage / Task #26720)

## 起因

后端单测已覆盖 15 个 `internal/` 包,但没有任何覆盖率度量入口:总覆盖率多少、改动后有没有稀释覆盖率,全凭感觉。本任务(Task #26720)补上度量与守门:**Makefile 三个 cover 目标 + floor 单向棘轮脚本 + TESTING.md 文档**(`#coverage` 锚点)。

棘轮(ratchet)取向下守门而非追高目标值:floor 只许涨不许跌,挡「删测试 / 加不可测代码稀释覆盖率」的静默回归,又不逼人堆凑数测试。

## 方案与决策

### 1. 口径:只统计 `./internal/...`,不含根 `package main`

- 全部可测逻辑都在 `internal/`(AGENTS.md §1.7 胖后端);根 `package main` 零测试文件,且其 `go:embed all:frontend/dist` 依赖前端构建产物——**干净 worktree 里 `frontend/dist` 为空目录,`go test ./...` 连构建都过不了**(本 worktree 实测:embed pattern no matching files)。计入只会引入噪声与假失败,故 `cover` 用 `./internal/...`。
- 既有 `make test`(`go test ./...`)在干净 worktree 有同样的 embed 前置问题,靠 `make dev`/`make build` 产出 `frontend/dist` 后即恢复——既有行为,本次不动(不夹带),已在 TESTING.md 口径节说明。

### 2. floor 守门:`scripts/coverage.floor`(一行数字)+ `scripts/coverage-floor.sh`

- **floor 单独成文件而非写死在脚本里**:floor 是要随代码演进被 commit、被 review 的数据(涨覆盖 = 抬杠也要留痕),不是逻辑。初始值 `69` = 落地当天实测 **69.2%** 向下取整,留零点几 pt 余量抗 Go 工具链版本间的语句级漂移。
- 脚本三种用法(细节见脚本头注释):`coverage-floor.sh [profile]` 校验(默认 `coverage.out`,go tool cover -func 末行取 total)、`--set` 把实测值写入 floor 文件(抬杠/重定基准一步到位)、`COVERAGE_FLOOR=NN` 环境变量临时覆盖(演练失败路径,不落盘)。
- 数值比较走 **awk 不依赖 bc**(macOS 不保证有 bc);floor 合法性(0..100 的数)同样 awk 校验。profile 缺失 / floor 非法 / 总覆盖率 < floor 均非零退出,FAIL 信息直接给出「补测试,或确认无测试损失再 --set 重定基准」的出口。

### 3. Makefile 三目标

| 目标 | 命令 | 说明 |
|---|---|---|
| `cover` | `go test ./internal/... -covermode=atomic -coverprofile=coverage.out` + `go tool cover -func \| tail -1` | atomic 模式对 chat 等并发密集包的计数更准 |
| `cover-html` | = `cover` + `go tool cover -html -o coverage.html` | 浏览器逐行看未覆盖分支 |
| `cover-check` | = `cover` + `bash scripts/coverage-floor.sh coverage.out` | CI/提交前守门 |

- `coverage.out` / `coverage.html` **早已在 .gitignore**(本次确认直接复用),产物不入库。
- Taskfile.yml 不镜像 test 类目标(既有 `make test` 也只在 Makefile),故不加,保持既有分工。

### 4. TESTING.md(仓库根,`## Coverage` 原生锚点即 `#coverage`)

收拢「怎么测」:后端单测 / 前端测试 / Coverage 三节。Coverage 节写清三目标表、floor 棘轮工作方式、抬杠与重定基准流程(`--set` + 同批 commit)、口径说明(为何不含根 package main、前端暂不设 floor 的理由)。标题用英文单词 `Coverage` 使 GitHub 锚点恰为 `#coverage`(中文标题的锚点会被 percent-encode,对不上任务要求的锚)。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `Makefile` | `.PHONY` 增 `cover cover-html cover-check`;`test-integration` 后新增三目标(注释含口径说明) |
| `scripts/coverage-floor.sh` | 新增,可执行;floor 守门(check / --set / COVERAGE_FLOOR 三用法) |
| `scripts/coverage.floor` | 新增,一行 `69`(实测 69.2 向下取整) |
| `TESTING.md` | 新增:后端单测 / 前端测试 / Coverage(#coverage)三节 |
| `frontend/`、Go 源码 | **零改动**(纯度量基建) |

## 验证

- **基线实测**:`go test ./internal/... -covermode=atomic -coverprofile` 全 15 包 ok,总覆盖率 **69.2%**(包级区间:internal/update 5.9% 最低,titlegen 94.3% 最高;update 是最大补覆盖空间,记入下一步)。
- **`make cover-check` 全绿**:exit 0,输出 `coverage-floor: OK 总覆盖率 69.2% >= floor 69%`(复跑走 go test 缓存,套件真实执行见基线实测)。
- **守门失败路径**:`COVERAGE_FLOOR=99.9` → exit 1,FAIL 提示含修复出口;`COVERAGE_FLOOR=69.1`(贴地)→ exit 0,确认比较是真数值而非字符串序。
- **--set 往返**:`--set` 后 floor 文件变 `69.2`,还原 `69` 后 diff 干净。
- **`make cover-html`**:exit 0,`coverage.html`(849KB)生成且 gitignored(`git status` 不含)。
- **脚本静态检查**:`bash -n` 干净;缺失 profile → exit 2(go tool cover 自身报错,非零即挡住)。
- **Go 门**:`go vet ./internal/...` exit 0;Go 源码零改动,根 package 的 embed 前置为既有 worktree 状态(见口径节)。
- **前端/三端(§4.7)**:不适用——`frontend/` 零改动,无 UI/binding/event 面。

## 下一步

- `internal/update` 5.9% 是最大补覆盖空间(其余包 58–94%);下次触到该包时顺手补测、抬杠。
- 后续可在 CI(若建)把 `make cover-check` 挂为必过门;当前本地提交前自跑。
