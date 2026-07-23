# 2026-07-23 新增 goose 为第三个内置 ACP harness

## 起因

用户要求把 goose(github.com/aaif-goose/goose,自带 `goose acp` stdio ACP server)接入 monkey-deck,作为与 omp/opencode 并列的**内置预置 harness**(非"用户手动添加任意 harness"那套大改)。

前置实证(本轮前已完成,见对话):goose ACP 全链路可用(Initialize→NewSession→Prompt→end_turn)、自报 configOptions(model/mode,ModelSelect 直接复用)、provider 配置已修好(`~/.config/goose` 补回扁平 `GOOSE_PROVIDER`/`GOOSE_MODEL` + `api_key_env` 改 `ZHIPU_API_KEY`)、有官方图标。

## 决策:走"加第三个内置预置",不大改

架构本就为 N 个 harness 设计(`Supported`/`Registry`/`Discover`/`Commands` 全遍历),N 此前恰好是 2。加第 3 个是机械操作:只加数据,不改架构、不加 migration、不加 binding、不动前端(NewSessionModal/HarnessSettings 都动态 map 列表,goose 自动出现)。

### deadcode / 重构核查(先验证再动手,§5.3)

用户要求"顺手做有重构时机的重构、删 deadcode"。核查结论:**源码已干净,无遗留 deadcode**:
- `config.Config.HarnessCmd` 死字段早在 `2026-07-01-harness-agnostic-process-reclamation` 清掉(现仅剩活的 `acp.Runner.HarnessCmd`)。
- `config.DefaultModel` / `GetConfig` 都是活的(GetConfig 暴露 checkHarnessUpdates/autoHarnessUpgrade,前端用;DefaultModel 被 CreateSession/SetDefaultModel/loadPersistedConfig 用)。
- `mino`/`IsOpenCode`/`WriteModelConfig` 全已删(仅 PROCESS/worklog 历史文档 + migration 0005 注释有残留提及,那些是不可变历史,不动)。
- 进程回收/发现的注释多用 `omp/opencode/...` 省略号前瞻写法,本来就覆盖 goose,不算陈旧。

故"重构"仅限于:被碰到的注释/测试数据补 goose(见下)。

## 改法

1. `internal/harness/harness.go`:`Supported` 加 goose 行(`{ID:"goose",Name:"Goose",Command:"goose acp",Icon:"assets/harness-icons/goose.svg"}`);包注释 `omp/opencode` → `omp/opencode/goose`。
2. `internal/harness/registry.go`:`Registry` 加 goose Spec —— `Source: &GitHubSource{Repo:"aaif-goose/goose"}`(`goose update` 无 check-only 子命令,与 opencode 同款走 GitHub Releases 查最新)+ `Upgrader: CommandUpgrader{Cmd:["goose","update"]}`(委派 goose 自带升级,§3.2 委派优先);Registry 上方注释补 goose bullet。
3. `assets/harness-icons/goose.svg`(新):官方鹅剪影,来源 `ui/desktop/src/components/icons/Goose.tsx`,转独立 SVG(删 JSX className),`fill="currentColor"` 透明底(比 opencode.svg 的深色底更干净)。顶部 Apache-2.0 署名头(版权 + SPDX + 来源 + **Modified 声明**,Apache-2.0 §4b 要求)。
4. `THIRD_PARTY_LICENSES.md` §2.4(新):goose.svg 登记。⚠️ 与 §2.2/§2.3(MIT 原样拷贝)不同 —— Apache-2.0 要求声明修改,且本图标是格式转换(React 组件→独立 SVG)非原样。
5. `internal/harness/harness_test.go`:id 期望列表 + 图标 map + 注释补 goose。
6. `internal/acp/proc_pgidfile_test.go`:`TestIsHarnessCmdline` 的 cmds 样本 + 用例补 goose(顺手,让测试反映三 harness 实况)。
7. **图标镜像(易漏)**:`assets/harness-icons/goose.svg` 是唯一事实源,但前端运行时从 `frontend/public/harness-icons/goose.svg` 取图(无自动钩子,见该目录 README §维护)。必须**手动等量拷贝**到 `frontend/public/harness-icons/`,否则 `<img src="/harness-icons/goose.svg">` 404 → 走 Bot 兜底(列表有 goose、图标却是通用机器人)。本次已镜像(diff 确认一致)。
8. `assets/harness-icons/README.md`:表格加 goose 行;修掉"所有图标均自 references/ 下 MIT 原样借用"的过时说法(goose 是 Apache-2.0、直接来自 goose 仓库非 references/)。

### 为什么这些零改动(架构红利)

- 进程回收:`harness.Commands()` 遍历 Supported 自动多返 `"goose acp"` → `SetHarnessCommands` 启动已注入 → goose 逃逸进程会被 reap(§3.2)。
- 发现/版本/升级:`Discover`/`Upgrade` 遍历 Registry,自动覆盖 goose。
- spawn:`harness.Command("goose")` → `"goose acp"` → `NewRunner` → `strings.Fields`。
- model:已统一走 ACP config option(`set_config_option`),goose 自报 model/mode。
- `mcpServers:[]`:三处 NewSession 已传非 nil 空切片,规避 goose 的 `null` serde 挂起坑(实证:goose 对 `mcpServers:null` 反序列化失败且不回 JSON-RPC error,会死挂)。
- 前端:NewSessionModal/HarnessSettings 动态 map 列表,goose 自动作为第三项出现;HarnessIcon 按 ID 试 `goose.svg`。
- 默认 harness 仍 omp(`DefaultID`),goose 只是多一个选项;`lastHarness` 记用户选择。
- 无新 binding(Harness struct 字段未变,只变数据)、无 migration(session.harness 存 `"goose"` 字符串)。

## 改了哪些文件

- `internal/harness/harness.go`(Supported + 包注释)
- `internal/harness/registry.go`(Registry + 注释)
- `internal/harness/harness_test.go`(期望)
- `internal/acp/proc_pgidfile_test.go`(测试样本)
- `assets/harness-icons/goose.svg`(新,唯一事实源)
- `frontend/public/harness-icons/goose.svg`(新,等量镜像副本)
- `assets/harness-icons/README.md`(表格 + 协议说明)
- `THIRD_PARTY_LICENSES.md`(§2.4 新)

## 验证

- `go build . ./internal/...` ✅(ld macOS 版本警告为既有、无关)。
- `go vet ./internal/harness/ ./internal/acp/` ✅。
- `go test ./internal/harness/ ./internal/acp/` ✅;`go test ./internal/chat/ -run Harness` ✅。
- 端到端发现冒烟(临时测试,跑完即删):`harness.Discover()` → goose `installed=true path=~/.local/bin/goose version=1.29.1 latest=1.43.0 upgradeAvail=true`(LookPath + 版本解析 + GitHubSource 查最新 + compareVersions 全通)。
- goose.svg:qlmanage 渲染成有效 64×64 RGBA PNG + XML well-formed。
- 前端无需改(动态列表);未做实机 `wails3 dev` 验证(NewSessionModal 第三项 / HarnessSettings 版本+升级按钮)。

## 下一步

- 实机 `wails3 dev` 验证:新建会话选 goose、跑一轮真实对话、HarnessSettings 看 goose 版本/升级。
- GUI PATH 风险(§5.4):dev 模式(终端起)goose 可发现;打包后从 Dock 启动若 PATH 不含 `~/.local/bin` 会显示"未安装"。与 omp/opencode 同处境(非 goose 新增成本);真遇到用 `Spec.ExtraDirs` 逃生口。
- 用户手动添加任意 harness(ProbeHarness 校验向导 + DB 化 + Add/Edit/Remove CRUD)是后续大改,本次不做。
