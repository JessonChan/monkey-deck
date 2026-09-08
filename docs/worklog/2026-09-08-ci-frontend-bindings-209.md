# CI frontend job 补 wails3 绑定生成层(pin 语义 go run wails3)(#209)

## 起因

CI 洋葱第四层(用户直报):`frontend/bindings/` 是生成中间产物、不入 git(`.gitignore:40`;根 Taskfile `common:generate:bindings` 与 `build/Taskfile.yml:35` sources/generates 自述 needed by frontend),而 `ci.yml` 的 frontend job(:72-84)只有 setup-bun → `bun install --frozen-lockfile` → `bun run build`——fresh checkout 上没有 bindings,`tsc` 对 `./bindings/<pkg>` 的 import 报 50 处 TS2307,frontend job 必红。

## 根因

frontend job 缺「绑定生成层」。bindings 由 `wails3 generate bindings` 从 Go 导出方法生成,前端 tsc/vite 直接消费;本地开发时该层由 Taskfile 的 `generate:bindings` 任务补齐,CI 漏掉了这一步。

## 改法(用户拍板:主案,pin 语义 go run wails3)

`ci.yml` frontend job 在 `bun run build` 前补两层(改动面=单文件,+17 行):

1. **`actions/setup-go@v5`**(`go-version-file: go.mod` + `cache: true`)——与 backend job(:39-41)同款,为生成步骤提供 Go 工具链与模块缓存。
2. **Generate bindings step**——逐字复刻 `build/Taskfile.yml:195-198` `generate:bindings` 的底层命令:
   ```bash
   WAILS_VERSION="$(go list -m github.com/wailsapp/wails/v3 | cut -d' ' -f2)"
   go run "github.com/wailsapp/wails/v3/cmd/wails3@${WAILS_VERSION}" generate bindings -f '' -clean=true -ts -i
   ```
   - **不装全局 wails3**:PATH CLI 版本漂移正是 80d908f 立案动机(beta.16 vs alpha2.106 生成器产物不兼容),`go run pkg@version` 直用 go.mod pin 语义,免装 CLI。
   - `-f ''` = BUILD_FLAGS 取任务默认(空串);OBFUSCATED 非 true 无 `-obfuscated`。
   - **省略 go:mod:tidy 依赖属预期**:CI 的 go.mod 已 tidy 且不得改动(验证节实证零 diff)。
3. 既有步骤(checkout/setup-bun/install/build)顺序与内容原样,只做插入;backend job 与 release.yml 零改动。

## 改了哪些文件

- `.github/workflows/ci.yml`(frontend job 插入 setup-go + Generate bindings 两步,单文件)
- `docs/worklog/2026-09-08-ci-frontend-bindings-209.md`(本条)

## 验证(本地等价,硬门全过)

1. **生成命令等价复跑**:`rm -rf frontend/bindings` → 跑与 workflow 逐字同款的生成命令 → `frontend/bindings` 重建(297 packages / 2 services / 131 methods,pin 自 go.mod 的 wails3 v3.0.0-alpha2.106)。
2. **go.mod/go.sum 零 diff**:`git status --porcelain -- go.mod go.sum` 为空——生成步骤确实不碰模块清单。
3. **前端全链**:`cd frontend && bun install --frozen-lockfile && bun run build` 全过(chunk >500kB warning 为既有噪音,非错误)。
4. **Go acceptance gate**:`go build ./...` + `go vet ./...` + `go test -run xxx_none ./internal/...` 全绿(dist 由真实前端构建产出,go:embed 无需 stub)。
5. **改动面断言**:`git diff --stat` 仅 `.github/workflows/ci.yml`;`git status` 无 `.rak-env` 等运行时文件(bindings/dist 均被 gitignore)。
6. workflow YAML 经 ruby YAML 解析校验合法。
7. CI 实跑绿留人(frontend job)。

## 下一步

- reviewer 走流程;按流程不 push、不关 issue,APPROVE 后停 completed-ready。
- CI 首跑关注 `go run wails3` 冷编译耗时(模块缓存命中后显著缩短),如逼近 job 15min 预算再议 timeout 调整。
