# 2026-09-08 #209 CI frontend 绑定生成层 review(独立复现,APPROVE)

## 背景 / 起因

审 #29043 实现,main 已落 **6b35690**(ci.yml frontend job 补 setup-go + Generate bindings,+17 行单文件)+ **3625680**(worklog)。审阅原则:**不信 commit 叙事,本机独立复现**,清单 ①-⑤。

## 结论:**APPROVE**(①-⑤ 全过,零 needs changes;不 push 不关 issue,关闭留人)

### ① diff 审读 ✓

- 单文件 `.github/workflows/ci.yml` **+17/-0**(0 删除);唯一 hunk `@@ -75,10 +75,27 @@` 落在 frontend job(新文件 :72 起)内,backend job(:18-69)零触及。
- 步骤序 = checkout(:77)→ `setup-go@v5`(`go-version-file: go.mod` + `cache: true`,:83-86,与 backend job :39-42 同款)→ setup-bun(:87)→ Install deps(:88-90)→ Generate bindings(:94-98)→ Type check + build(:99-101)。
- 既有步骤(checkout/setup-bun/install/build)全部以 context 行原样保留,无删改。

### ② pin 语义逐字对照(80d908f 语义)✓

对照 `build/Taskfile.yml:195-198` `generate:bindings` 底层命令:

| 片段 | Taskfile | CI | 等价性 |
|---|---|---|---|
| 版本推导 | `WAILS_VERSION="$(go list -m github.com/wailsapp/wails/v3 \| cut -d' ' -f2)"` | 逐字相同 | ✓ |
| 执行 | `go run "github.com/wailsapp/wails/v3/cmd/wails3@${WAILS_VERSION}" generate bindings ...` | 逐字相同 | ✓ |
| `-f` | `-f '{{.BUILD_FLAGS}}'` | `-f ''` | ✓ 等价——`.BUILD_FLAGS` 在根/构建 Taskfile 均无定义(grep 实证),模板展开即空串 |
| `-obfuscated` | `{{if eq .OBFUSCATED "true"}}` | 省略 | ✓ 等价——`.OBFUSCATED` 无定义,恒 false |
| `go:mod:tidy` 依赖 | 有(deps) | 省略 | ✓ 合理——CI 步内注释 + worklog 双处佐证(CI 的 go.mod 已 tidy 且不得改动);且本机复现实证生成零改 go.mod/go.sum |
| cwd | 任务无 `dir:`(include 亦无 override)→ 仓库根 | 无 `working-directory` → 仓库根 | ✓ |

### ③ 等价验收(核心,本机独立复现)✓

1. 前置状态即 CI fresh checkout 态:`frontend/bindings` **不存在**(gitignored 不入 worktree)。
2. 逐字跑 workflow 同款命令:`WAILS_VERSION` 解析得 **v3.0.0-alpha2.106**(与 go.mod :11 钉住一致),输出 **"297 Packages, 2 Services, 131 Methods"** → `frontend/bindings` 重建(144K,`github.com/` + `time/` 两包)。
3. `git status --porcelain -- go.mod go.sum` **空**——生成步骤确实不碰模块清单。
4. `cd frontend && bun install --frozen-lockfile && bun run build`(= `tsc && vite build --mode production`)→ **"✓ built in 798ms"**,零 TS2307(tsc 在 `&&` 链先行,vite 产出 assets 即 tsc 已过的直接证据);唯一警告为既有 chunk >500kB 噪音,非错误。

### ④ backend job / release.yml 零改动 ✓

- commit stat 仅 `ci.yml`;`git diff 6b35690^ 6b35690 -- .github/workflows/` 仅 ci.yml(release.yml、test-installer.yml 均未触及)。
- backend job 步骤语义与 diff 前一致(hunk 不覆盖 :18-69)。

### ⑤ worklog 3625680 与 diff 一致 ✓

- 行号锚点全部核实:`.gitignore:40`(`frontend/bindings/`)精确;`build/Taskfile.yml:195-198`(`- |` 起三行命令)精确;diff 前 frontend job `:72-84` 精确(`git show 6b35690^` 实读)。
- 验证节声明(297/2/131、alpha2.106、go.mod 零 diff、build 全过、chunk warning 噪音)与本机独立复现**逐项吻合**。

## 超清单核验(额外证据)

- **linux 编译风险排查并排除**:frontend job 跑在 ubuntu-24.04 裸 runner(无 GTK/WebKit dev headers,backend job 注释自证 "headers the runner does not ship"),`go run wails3` 在该平台要现编译 CLI——若 CLI 依赖图含 `pkg/application`(linux 下 cgo 需 gtk headers)步骤必炸。**实证排除**:临时探针模块 `GOOS=linux go list -deps cmd/wails3` 完整解析 **738 包,`pkg/application` 不在图中**(唯一 !ios 引用点 `build_assets/ios/app_options_default.go` 不可达),CLI 在 linux 纯 Go 可编译,Generate bindings 步骤成立。本机 darwin 成功 + 此图 = 双平台证据。
- workflow YAML 经 ruby `YAML.safe_load` 解析合法。
- 反「类型补丁」:新增步骤非空壳——产物 `frontend/bindings/*.ts` 正是同 job 下一步 tsc import 的消费对象(③ 实证 TS2307 消失);验证断言锚定值(版本串、包/方法计数、构建成功),非存在性断言。

## 非阻塞观察(记录,不要求改)

- worklog backend setup-go 锚点写 `:39-41`,实际步骤含 `cache: true` 行为 :39-42——一行截断,无实质影响。
- CI 首跑(frontend job)留人:冷 `go run` 需编译 ~738 包(纯 Go),15min 预算内但值得观察(worklog 已自标此关注点)。
- `go:mod:tidy` 省略依赖「仓库 go.mod 恒 tidy」这一仓库卫生不变量;若未来 CI 出现 go.sum 漂移类错误,此处是首个排查点。

## 下一步 / 留人

- APPROVE,停 completed-ready;**不 push、不关 issue**,关闭动作留人。
- 留人项:GitHub Actions frontend job 首跑实绿确认。
