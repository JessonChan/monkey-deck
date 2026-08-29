# P0 三件:collectTags 纳 null + gate tsc 无缓存 + wails3 build 全流程验证(#28396)

日期:2026-08-29
父 issue:#28395(P0 三件,用户钉死)
状态:**完成**(三件全落地,全部验证绿;2 个环境级 OPEN 移交用户)

## 起因

#150 session 标签 MVP 前端(a060aba)落地后:①`collectTags` 签名不纳 wire null,真实 binding 类型传不进去;②本地门(`make cover-check`)不跑 tsc,TS 回归零拦截(bun test 剥类型不查);③wails3 build 全流程从未在本 worktree 实证过。用户钉死三件 P0。

## 根因与改法

### ① collectTags 纳 null(类型层 bug,实证复现)

- **根因**:Go `Session.Tags []string`(store.go:92)nil slice 序列化为 JSON `null`(CreateSession 内存 Session 即 `Tags==nil`,见 #27984 复核 P3#2);生成 binding model 钉为 `"tags": string[] | null`(store/models.ts:187)。旧签名 `collectTags(sessions: { tags?: string[] }[])` 拒收 → `Sidebar.tsx:721` 传 `Session[]` 是 **tsc 硬错**(修前实跑 `bunx tsc --noEmit`:唯一错 `TS2345`,`string[] | null` 不可赋给 `string[] | undefined`)。420 个 bun 测试全绿没兜住——bun 剥类型不检查。
- **改法**:签名放宽为 `{ tags?: string[] | null }[]`(运行时 `s.tags ?? []` 本就兜住,纯类型诚实化);补 `lib/tagColor.test.ts`(4 测试:null/undefined/缺字段降级、first-seen 去重、确定性配色)。类型层回归由 ② 的 gate 兜;运行时 null 契约由新测试钉。

### ② gate tsc 无缓存

- **根因**:`make cover-check`(钉死的本地门)只跑 go test + bun test,没有 tsc;TS 类型回归在本地零拦截。
- **改法**:`cover` 目标在 node_modules 检查后、go test 前插 `cd frontend && bunx tsc --noEmit --incremental false`——无缓存全量检查,无 tsbuildinfo 可陈旧。`cover` 与 `cover-check` 因此都类型门控;CI 前端 job 本就跑 `bun run build`(含 tsc),不受影响。
- **前置修正**:`bindings` 目标从裸 `wails3 generate bindings`(产 **JS-only**,tsc 根本解析不了 model)改为 Taskfile `generate:bindings` 同款 flags **`-clean=true -ts -i`**(TS interface)。没有这条,新 tsc 步在重新生成后必炸。

### ③ wails3 build 全流程验证(+两个 Makefile 硬伤顺手实证修复)

验证过程撞出两个 Makefile 级问题,均属「build 全流程走不通」的直接障碍,一并修:

1. **`build: bindings $(WAILS3)` prerequisite bug**:`WAILS3 ?= wails3` 展开为裸词,make 当文件 target 找 → `No rule to make target 'wails3'`,`make build`/`make package` 直接失败。修:去掉 `$(WAILS3)` 前置(recipe 里照用)。
2. **CLI 与 go.mod 版本脱钩(环境 finding,重要)**:PATH 上 `/Users/jessonchan/go/bin/wails3` = **v3.0.0-beta.3**,go.mod 钉 **v3.0.0-alpha2.106**——§0.5「CLI/module/bindings 三者同步」被破坏。两版产出实测 **11 行实质 diff**:`WorktreeInfo.probedAt` alpha 生成 `time$0.Time`(独立 time model,26 models)+ import,beta 内联 `string`(25 models);beta 裸调用还只产 JS-only。**PATH 上的二进制会静默改写 wire 类型**。
   **修法(Makefile 恒温化)**:`WAILS3 ?= go run github.com/wailsapp/wails/v3/cmd/wails3@$(shell go list -m -f '{{.Version}}' github.com/wailsapp/wails/v3)`——所有 target(bindings/dev/build/package)默认走 go.mod 钉死版本,PATH 杂音进不来;`WAILS3=<path>` 仍可覆盖。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/lib/tagColor.ts` | `collectTags` 签名纳 `null` + 注释说明 wire null 来源 |
| `frontend/src/lib/tagColor.test.ts` | 新增,4 测试(null 契约 + 去重 + 确定性) |
| `Makefile` | tsc 门入 `cover`;`bindings` 对齐 Taskfile flags;`WAILS3` 默认 go-run 钉 go.mod 版本;修 `build:`/`package:` prerequisite bug |
| `scripts/coverage.floor` | `--set` 重定基准(go 69→69.5,frontend 64→63.0,见下) |

## 验证

**本次改动无 UI/渲染面变化(lib 类型签名 + 构建管线),三端矩阵不触发**;验证在构建/门禁通道完成:

1. **复现→修复闭环**:修前 `bunx tsc --noEmit` 恰 1 错(Sidebar.tsx:721 TS2345)→ 修后 0 错;`bunx tsc --noEmit --incremental false` 干净。
2. **门全绿**:`make cover-check` exit 0——bindings 再生成 → tsc 门 → go test 覆盖率 → bun test 424 pass(420+4 新)→ floor 棘轮 OK(go 总 69.5 ≥ 69.5;分包 14/15 + 1 豁免)。
3. **wails3 build 全流程**:`make build` exit 0——go-run alpha CLI → Taskfile bindings(同版)→ bun install → tsc + vite build → `go build -tags production` → `bin/monkey-deck`(22.9MB)产出。
4. **Go 门**:`go build ./...` ✓、`go vet ./...` ✓、`go test ./...` 15 包全 ok 0 FAIL。
5. **单测**:`bun test lib/tagColor.test.ts` 4/4。

## coverage floor 重定基准(63.0 < 64,pre-existing,非本次引入)

gate 跑出前端行覆盖 63.0 < floor 64。**取证为存量红**:①本次前端 diff 零可执行行变化(注释+类型注解);②stash 后基线复测同 420 tests/7415 expects,lcov 总量 63.02%(=gate 报的 63.0)逐位吻合;③floor 定标 commit(08c8a61,2026-08-27)以来 **0 个测试删除**、15 个前端 feature commit(#150–#158 新 UI 代码带稀释)。按 gate 自述救济(「确认无测试损失后 --set 重定基准」)执行 `--set`:go 总 69.5(**上调**棘轮)、frontend 63.0(回落至实测)。顺手补的 4 个 tagColor 测试即 #5.3 bug-修复配测试。

## OPEN / 下一步

1. **(用户拍板)机器级 CLI desync**:`/Users/jessonchan/go/bin/wails3`(beta.3,Aug 4 二进制)与 go.mod alpha2.106 不符。Makefile 已恒温化不再受影响,但终端里手敲 `wails3 dev/build` 仍会走 beta.3。建议 `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.106` 覆盖,或干脆升级 go.mod 到 beta.3(需连同 Taskfile/产出 diff 一起过一遍)。
2. **前端测试债**:#150–#158 新 UI 稀释行覆盖至 63.0。后续给新组件补测试把 floor 抬回 64+(棘轮只许向上)。
3. **(观察,未修)CI 前端 job 缺 bindings 供给**:CI checkout 无 gitignore 的 `frontend/bindings/`,`bun run build` 的 tsc 对 `../../bindings/...` import 会 TS2307。本地门(cover)已自供给;CI 是否补 provisioning 待定(本卡范围外)。
