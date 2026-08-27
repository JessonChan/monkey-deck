# 2026-08-27 · 覆盖率对齐钉死方案:三族棘轮(go 总 / 分包 / 前端 bun)落地(#26721,#26720 偏差收敛)

## 起因

#26720 落地了 Makefile 三个 cover 目标 + **单一总 floor** 棘轮,但相对钉死方案有两处偏差:
1. **只有总 floor,没有分包 floor**——`internal/update` 5.9% 与 `titlegen` 94.3% 共用一道 69% 的闸,
   某包覆盖率被稀释只要总盘不跌就漏检;新加包更是完全逃逸棘轮。
2. **前端零度量**(TESTING.md 明写「前端暂不设 floor」)——前端测试 373 个、覆盖真实存在,
   却没有任何度量入口与守门。

本任务(#26721)收敛偏差,把钉死方案补齐:**仍是三个 Makefile 目标,守门从一族变三族**——
go 总覆盖率 / 分包 floor / 前端 bun 覆盖率。

## 方案与决策

### 1. 三个目标维持不变,内容扩到两端

`cover` = Go(`go test ./internal/... -covermode=atomic`)+ 前端(`bun test --isolate --coverage`,
text 摘要 + lcov reporter);`cover-html` 维持 Go-only(bun 无 HTML reporter);`cover-check` =
`cover` + `scripts/coverage-floor.sh` 全量守门。**不新增第四个目标**,钉死方案的「三目标」形状保持。

### 2. floor 数据两份文件(数值比较走 awk,支持小数)

- `scripts/coverage.floor` 从裸数字迁移为 **keyed 标量**:`go 69` + `frontend 64`
  (64.7% 向下取整,留余量抗漂移,与 go 69 同策略)。文件一天前刚建、唯一消费方是本脚本,
  直接干净迁移不留兼容 shim。env 临时覆盖拆两个:`COVERAGE_FLOOR` / `COVERAGE_FLOOR_FRONTEND`。
- `scripts/coverage.floor.pkgs` 新增:**一行 `<包> <floor>`**,按包名排序(出 diff 稳定)。
  初始值 = 当天实测逐包向下取整(5.9→5、58.1→58 … 94.3→94),15 包全录入。
- **新包必须有 floor 行**(profile 里出现无 floor 的包 = FAIL),堵死「加新包逃逸棘轮」;
  包删了留下的 stale 行只 WARN 不挡(`--set-pkgs` 重写时自然消失)。

### 3. 分包覆盖率算法

直接从 `coverage.out` profile 按目录聚合语句(covered/total),**与 `go test -cover` 的包级数字
逐一吻合**(update 5.9 / acp 58.1 / chat 65.5 / store 67.9 / remote 74.9 / worktree 76.8 /
shellenv 81.3 / ui 82.4 / mcp 82.7 / terminal 83.2 / harness 85.5 / config 86.7 / fsview 89.0 /
permissions 92.8 / titlegen 94.3,总 69.2 与 #26720 基线一致)。包 key 锚定 `/internal/`
(口径钉死只测 ./internal/...),不写死 module 前缀。

### 4. 前端口径

`bun test --isolate --coverage --coverage-reporter=text --coverage-reporter=lcov`,
守门解析 `frontend/coverage/lcov.info` 的 `LH/LF` 求和(行覆盖率)。**排除生成物
`frontend/bindings/`**(gitignore 的机器生成代码,拉低总数 8.7pt:56.0%→64.7%)。
`make cover` 先 `rm -f` 旧 lcov(含中断残留的 `.lcov.info.*.tmp`),防陈旧文件假绿。
已知局限如 TESTING.md 口径节所记:bun 只统计测试加载过的文件,「整文件删测试」堵不死,棘轮主挡渐进稀释。

### 5. 踩坑(两处,都是 macOS 环境的坑)

- **`declare -A` 在 macOS 系统 bash 3.2 下直接 die**(`invalid option`)——脚本 shebang 是
  `#!/usr/bin/env bash`,守门必须在这台机器的默认 bash 上跑。重写为无关联数组的 awk 查找
  (文件才 15 行,O(n²) 无所谓),脚本对 bash 3.2 可移植。
- **BSD awk 不认 `[^/]` 字符类**(`extra ]`)——POSIX 合法但 BWK awk 词法把 `/` 当正则终止符,
  写成 `[^\/]` 才行。Linux gawk 无此问题,macOS 上必炸。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `Makefile` | cover 目标追加前端 bun 覆盖(含旧 lcov 清理);三目标注释改英文并更新口径(§3.7) |
| `scripts/coverage-floor.sh` | 重写:三族校验 + `--set`(标量)+ `--set-pkgs`(分包)+ 双 env 覆盖;bash 3.2 兼容 |
| `scripts/coverage.floor` | 迁移为 keyed:`go 69` / `frontend 64` |
| `scripts/coverage.floor.pkgs` | 新增:15 包分包 floor(实测向下取整) |
| `.gitignore` | 加 `frontend/coverage/` |
| `TESTING.md` | Coverage 节重写:三族守门 / 两个 floor 文件 / 前端口径 / 已知局限;删「前端暂不设 floor」旧口径 |
| `frontend/`、Go 源码 | **零改动**(纯度量基建) |

## 验证

- **`make cover-check` 端到端全绿**(真实路径:go test 15 包 + bun 373 测试 46 文件 + 守门):
  `go 总 69.2% >= 69`、`前端行 64.7% >= 64`、`分包 15/15`,exit 0。
- **失败路径**:`COVERAGE_FLOOR=99.9` → FAIL exit 1;`COVERAGE_FLOOR_FRONTEND=99` → FAIL exit 1;
  手改 `internal/update` floor 到 50 → 分包 FAIL exit 1;删掉 `internal/fsview` floor 行 →
  「无 floor 行」FAIL exit 1(新包同路径)。三类 FAIL 各带出口提示,其余族继续报(不 fail-fast)。
- **stale WARN**:pkgs 文件加 `internal/ghost 50` → WARN 不挡,exit 0。
- **--set 往返**:写回 `go 69.2 / frontend 64.7`,小数 floor 下 check 仍绿,还原干净。
- **--set-pkgs 往返**:整份重写为实测小数(58.1 / 65.5 / …),check 仍绿,还原干净。
- **缺产物**:profile 缺失 → exit 2(go tool cover 自报,与 #26720 行为一致);lcov 缺失 →
  exit 1 带补跑提示。
- **`bash -n`** 干净;且整个脚本在 macOS 系统 bash 3.2 下实跑通过(assoc array 已移除)。
- **Go 门**:Go 源码零改动;worktree 根 package 的 embed 前置为既有状态(见 #26720 口径节)。
- **前端/三端(§4.7)**:`frontend/` 源码零改动,无 UI/binding/event 面,三端矩阵不适用;
  前端测试套件(373)作为度量输入全绿即本任务的「前端面」验证。
- 分包聚合数字与 `go test -cover` 包级输出 15/15 逐一比对一致。

## 下一步

- `internal/update`(5.9%)仍是最大补覆盖空间,分包 floor 5 已把它钉在账上,触包时顺手补、抬杠。
- CI 若建立,`make cover-check` 直接挂必过门(当前本地提交前自跑)。
- `frontend/bindings` 若未来改由 wails3 dev 注入而非落盘,前端口径可去掉排除项。
