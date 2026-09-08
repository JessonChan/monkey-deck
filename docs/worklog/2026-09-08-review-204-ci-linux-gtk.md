# 2026-09-08 #204 CI Linux GTK 依赖 review(APPROVE)

## 背景 / 起因

审 #29023 实现(feb3878 fix(ci) + 69d8b22 worklog;本 worktree HEAD=69d8b22)。
反相追踪核实,不采信 commit 叙事:每条断言都在本机从证据重新推一遍
(含独立复跑方案 B 否决探针、wails 源码锚定)。

## 结论:**APPROVE**(①–⑥ 全过,零 needs changes)

### ① 修法 A 与拍板逐字一致 ✓

- `.github/workflows/ci.yml:52-56`:新步 `Install Linux GTK/WebKit dev deps`
  置于 Stub(:46-48)之后、`Build backend`(:57-60)之前;`if: matrix.goos ==
  'linux'`;`apt-get update` + `apt-get install -y libgtk-4-dev
  libwebkitgtk-6.0-dev libsoup-3.0-dev libglib2.0-dev` —— 四包与任务规格
  逐字一致;块写法(update 两行 + install 两行)与 release.yml:133-136 同款。
- 改动面:`git show feb3878 --stat` = **仅 `.github/workflows/ci.yml`,
  +11/-2**;release.yml / frontend job / 矩阵 entries 零 diff;#203 stub 步
  逐字保留。修法 B(CGON=0)未出现在任何 step。

### ② darwin/windows 零改动(语义) ✓

- 新步被 `if: matrix.goos == 'linux'` 门控 → darwin/windows 两腿运行时
  skip,实际执行的 steps 与改前逐一相同;矩阵(c:27-36)三腿零 diff。
- 包列表断言:ci.yml 四包 ⊇ release.yml:136 两包,「superset」注释属实
  (显式加 libsoup-3.0/libglib2.0,传递依赖 apt 自解析;且与规格字面一致)。

### ③ 方案 B 否决证据独立复现 ✓

- 本机复跑(stub 态):`GOOS=linux CGO_ENABLED=0 go build .` → rc=1,
  `undefined: pointer`(wails alpha2.106 `menu_linux.go:7`、
  `menuitem_linux.go:12,14`、`webview_window_linux.go:31-42`)——根包无
  纯 Go linux 编译面,B 前提不成立,与实现 worklog 及 #203 两份 worklog
  三方一致。
- 根因锚定 wails 源码:`pkg/application/linux_cgo.go:1`
  `//go:build linux && cgo && !gtk3 && !android && !server`、`:17`
  `#cgo linux pkg-config: gtk4 webkitgtk-6.0` —— dev 包需求 = gtk4.pc +
  webkitgtk-6.0.pc(libgtk-4-dev / libwebkitgtk-6.0-dev 提供),实现 worklog
  引用的 build tag 与 pkg-config 行逐字属实。

### ④ 过时注释修正 + §3.7 ✓

- 原 54-55 行「CI 仅验证 Go 编译(不 CGO)」已删,替换为 3 行英文注释
  (linux 腿现为真 CGO 编译 + 完整打包仍在 release.yml),语义准确、
  语言合规(AGENTS.md §3.7)。

### ⑤ worklog 69d8b22 内容真实非占位 ✓

- 起因/根因、改法决策(A 采/B 否决)、文件清单(+11/-2 与 git stat 一致)、
  验证 ①-⑤、留人(CI 实跑绿)俱全;抽查的 YAML 顺序、探针错误签名、
  单文件断言全部复现。③ 之外另核:本机 `go build ./...` + `go vet
  ./internal/...` + `go test -run xxx_none ./internal/...`(stub 态,darwin)
  rc=0(仅既有 macOS SDK ld warning,非错误,与 #203 记录一致)。

### ⑥ 红线零波及 ✓

- 不 push(本 review 仅落本地分支 agent/reviewer/bbcf864a)、不关 issue、
  CI 实跑绿留人(apt + 真 CGO 编译只能在真实 runner 验证)。
- ci.yml 是 CI 基础设施,不触 `frontend/`,不涉三端矩阵(§4.7 不适用)。

## 验证(全部本机复跑,2026-09-08)

- **YAML**:ruby `YAML.load_file` 解析过;backend steps 顺序 = checkout →
  setup-go → Stub → **Install Linux GTK/WebKit dev deps(if=linux)** →
  Build backend → Vet(if≠windows) → Test compile。
- **复现 bug 面**:无 stub 态 `go build ./...` → `main.go:22:12: pattern
  all:frontend/dist`(=#203 首闸,本卡正确叠加其上);stub 态全绿(⑤)。
- **方案 B 探针**:见 ③,独立复跑同错。
- **零回归门**:build + vet + test-compile rc=0(⑤)。

## 非阻塞观察(记录,不要求改)

- linux 腿的 Vet / Test compile 现在同样吃到真 CGO 编译(头文件已在其前
  装好,无缺口);apt 安装 ~1-2 min,对 job 20min 预算充裕。
- libsoup-3.0/libglib2.0 即使不显式装也会经 gtk4/webkitgtk 的 Depends
  拉入;显式列出是规格字面要求,冗余无害。
- windows 腿预期仍挂在 syscall Getpgid/Kill 缺口(#203 已记录,另卡)。

## 下一步 / 留人

- **CI 实跑绿留人**(红线不变,不 push):下次 push 后 linux 腿应绿
  (Build backend 走真 CGO);windows 腿的失败属另一卡预期,非本卡回归。
- 上层复核本 APPROVE 后按 completed-ready 流转。
