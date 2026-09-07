# 2026-09-07 #203 CI embed stub review(APPROVE)

## 背景 / 起因

审 #29019 实现(已合 main:33d1b43 fix(ci) + 999dfb2 worklog;本 worktree HEAD
= 999dfb2,`git rev-parse main` 同值)。反相追踪核实,不采信 commit 叙事:
每条断言都在本机从证据重新推一遍(含复跑构建、独立交叉编译抽验)。

## 结论:**APPROVE**(①–⑤ 全过,零 needs changes)

### ① stub 步骤位置 / 命令 / shell / 矩阵覆盖 ✓

- `.github/workflows/ci.yml:46-48`:位于 `actions/checkout@v4`(:38)与
  `actions/setup-go@v5`(:39-42)之后、`Build backend`(:49-52)之前,
  ruby `YAML.safe_load` 解析实证 backend steps 顺序 = checkout → setup-go →
  **Stub frontend/dist** → Build backend → Vet → Test compile。
- 命令逐字 = `mkdir -p frontend/dist && echo stub > frontend/dist/index.html`,
  `shell: bash`,单步(name + shell + run 三行,无第二命令步)。
- 三平台矩阵(darwin-arm64 / linux-amd64 / windows-amd64,c:27-36)共用同一
  `steps:`,stub 步无 `if:` 条件 → 三腿全跑;`shell: bash` 在 windows-latest
  由 GitHub 官方语义落到 Git Bash(runner 内置),`mkdir -p`/`echo >` 全兼容。

### ② 语义同门 + 零波及 ✓

- 语义:dist 先于 embed 构建存在——`main.go:22` `//go:embed all:frontend/dist`
  在 `go build` 前已吃到 stub `index.html`(`all:` 前缀只影响 `_`/`.` 开头
  文件可见性,目录非空即满足)。另一 embed `internal/store/store.go`
  (`migrations/*.sql`)引用入库文件,checkout 自带,非缺口(实现 worklog
  断言复核属实)。
- 改动面断言:`git diff 22dc469..33d1b43 --stat` = **仅 `.github/workflows/
  ci.yml`,+6/-0**(纯增量,无删改行);release.yml 零 diff(同 stat 实证),
  且 release.yml 三平台 job 均走 `wails3 task release:*`(真实前端+后端全量
  构建,r:53-62/90-99)→ 不需要 stub,注释「release.yml is unaffected」属实。
- frontend job(:62-75)零改动,语义不变(tsc + vite build,不依赖 dist stub)。

### ③ worklog 999dfb2 内容真实非占位 ✓

- 79 行:根因(已独立复现,见下)、改法(与实际 diff 逐字一致)、验证、
  留人情报俱全。**「下一层失败」情报我独立交叉编译复现**:
  - windows 腿:`GOOS=windows go build . ./internal/...` →
    `internal/acp/proc.go:47/68/74/367` `syscall.Kill`/`Setpgid undefined`
    (`# internal/terminal` 包同报,worklog 引 proc.go:47,68,74,80,367 为
    超集,一致);
  - linux 腿:`GOOS=linux go build .` → wails v3.0.0-alpha2.106
    `menu_linux.go:7`/`menuitem_linux.go:12,14` `undefined: pointer`
    (cgo 未开时 `pointer` 仅定义于 linux_cgo.go)。
  两者均先于本卡存在、非本卡引入,与 worklog「本卡范围外」定性一致。

### ④ 既有测试零回归 ✓

- ci.yml 不触任何 Go 代码;改动面单文件断言(②)排除其它隐性 diff。
- 本机复跑:`go vet ./internal/...` exit 0;`go test -run xxx_none
  ./internal/...` 全 ok(编译门通过)。

### ⑤ CI 实跑绿留人 ✓(红线不破)

- 不 push:本次审查提交仅落本地 review 分支 agent/reviewer/3585995f,
  远端红线不变;reviewer 不 push。

## 验证(全部本机复跑,2026-09-07)

- **复现 bug**:本 worktree checkout 态无 `frontend/dist` → `go build .` 报
  `main.go:22:12: pattern all:frontend/dist: no matching files found`
  (= CI 三腿首爆点,实证成立)。
- **验证修法**:逐字执行 stub 命令建 stub → `GOOS=darwin GOARCH=arm64
  go build . ./internal/...` **过**(仅 ld macOS SDK 版本 warning,非错误,
  与实现 worklog 记录一致)。
- **YAML 结构**:ruby `YAML.safe_load` 解析通过,steps 顺序见 ①。
- 三端说明:本卡为 review 零产品代码改动,仅新增本 worklog;ci.yml 是
  CI 基础设施,不触前端,不涉三端矩阵(桌面/远程/PWA 均不受影响)。

## 非阻塞观察(记录,不要求改)

- stub 步无条件执行,Vet/Test compile 本身不依赖 dist——但 stub 仅 1 步
  且在 Build 之前是正确位置,KISS 合理,无优化必要。
- windows 腿 intel 抽验报错行(proc.go:47,68,74,367)与 worklog 引用
  (:80 亦列)为子集关系,无矛盾;linux/windows 两腿修复方向已由实现
  worklog 给足(另卡派),本卡不展开。

## 下一步 / 留人

- **CI 实跑绿留人**(红线不变,不 push):下次 push 触发 CI 时 darwin 腿
  应绿;windows/linux 腿预期在各自下一层失败点爆(见 ③ 情报,另卡修)。
- 上层复核本 APPROVE 后按 completed-ready 流转。
