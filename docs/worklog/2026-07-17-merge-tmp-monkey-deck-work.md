# 2026-07-17 合并 /tmp/monkey-deck-work 分支(RAK 工作空间下游克隆回归主仓库)

## 起因
`/tmp/monkey-deck-work`(origin 指向 `~/rak-workspaces/default/monkey-deck/default.git`)
是 RAK 工作空间里 monkey-deck 的另一份工作副本,在其上做了大量新开发。需要把这些开发
合并回主仓库(GitHub `origin`),且**不带进 RAK 的污染**。

## 调研:两边的关系(关键)
- 共同 commit SHA:**0 个** —— 两边无 git 级共同历史。
- 但 work 最早 commit `6b8b2f64` 自述 `seeded from tarball, RAK local clone`,其文件树
  与本仓库当时 HEAD `e5973e5` **byte-for-byte 完全相同**(187 文件、0 差异)。
- 结论:work = 本仓库 `e5973e5` 经 **tarball 重建历史**的下游克隆,在其上叠了 77 个增量提交。
- 文件覆盖:work 完整包含本仓库全部内容(本仓库独有文件 = 0);work 多 68 个新文件
  (新功能 + worklog + 测试)。

## 改法:format-patch + git am(不用 merge --allow-unrelated-histories)
- **为何不用 `merge --allow-unrelated-histories`**:会把 work 整段历史(含 seed 的
  `RAK local clone` 字样 + persona 注入/恢复 commit)并进主仓库,且 merge-base 为空属非常规合并。
- **am 方式**:seed 被 `<seed>..HEAD` 自然排除(RAK 字样不进史);77 个提交本就是原子提交、
  中文 message、docs/feat 分离,符合 §6.2;内容是 `e5973e5` 之上的纯增量 → 干净 apply。

具体步骤:
1. 本仓库切 `feat/merge-from-work` 分支。
2. `git -C /tmp/monkey-deck-work format-patch 6b8b2f64..HEAD -o /tmp/md-patches`(77 个)。
3. 剔除 4 个污染/噪音 patch:
   - `0003 daemon-fallback-commit`(`1edd4c7`):`.gitignore +4`(RAK 运行时忽略
     `.rak-env` / `/bin/rak` / `opencode.json`)+ `AGENTS.md +31`(RAK persona 注入)。
   - `0074 add-persona-inject-test-marker-to-README`(`010b7e1`):README 加 `<!-- persona inject test marker -->`。
   - `0076 restore-project-AGENTS.md`(`fd976d5`):把 `1edd4c7` 注入的 AGENTS.md persona 删回
     (与 `1edd4c7` 净效果为 0)。
   - `0077 add-trailing-blank-line-to-README`(`88d34b4`):README 空行(依赖被剔 marker 的 context)。
4. `git am --3way /tmp/md-patches/*.patch` 重放剩 73 个 → **零冲突全过**。
- `.gitignore` 那 4 行是 RAK 运行时(`.rak-env` / `/bin/rak` / `opencode.json`)的忽略项,
  与 monkey-deck 无关,**不补**(整条 `1edd4c7` 都是 RAK 环境噪音,全剔)。

## 改了哪些文件(73 个新 commit 的主要功能域)
- **权限系统**:`internal/permissions/`、`internal/store/permissions.go`、migration `0009`、`PermissionSettings`。
- **harness 管理**:auto-discovery / version / upgrade:`internal/harness/{discover,registry,release,upgrade}.go`、`HarnessSettings`。
- **token 用量明细**:`PromptResponse.Usage` 采集 + migration `0010` + `modelPricing` 估算。
- **i18n 框架**:`react-i18next` + zh/en locale,主视图文案抽取。
- **终端增强**:Cmd/Ctrl+1..9 切换、侧栏「已开终端」标记、`ListTerminalsBySession`。
- **工具卡片化**:bash/edit/read/search/glob 卡片 + 文件/diff 阅读器(语法高亮 + 虚拟化)。
- **composer**:图片输入、token 用量、@ chip 化、长文本折叠。
- **懒 spawn harness** + configOptions 缓存、`RefreshSessionConfig`。
- **UI**:面板收起/展开、统一设置中心、对话结束提示音、路径点击预览。
- **修复**:滚动掉帧、非 worktree 分支显示、项目导入拖拽、TS 编译错误等。
- **迁移**:`0009/0010/0011` 纯增量(本仓库原止于 `0008`,无冲突)。
- `AGENTS.md` / `README.md` / `.gitignore` 保持 `e5973e5` 干净态(污染已剔除)。

## 验证
- **内容完整性**:本仓库 HEAD vs work HEAD,仅 `.gitignore` / `README.md` 不同(= 被剔除的污染),
  功能文件零差异、零丢失。
- `go build . ./internal/...`:过。
- `go test ./internal/...`:12 包全 ok(含 work 新增 permissions / harness 测试)。
- `wails3 generate bindings`:291 包 / 2 服务 / 64 方法 / 10 模型,生成 acp/chat/harness/store/terminal
  等绑定(bindings 不入库,`.gitignore` 忽略)。
- `cd frontend && bun install`:装上 highlight.js / i18next / react-i18next。
- `npx tsc --noEmit`:零错误。
- `bun test`:34 pass / 0 fail。
- **污染 grep**:tracked 文件命中 2 处均为合法上下文(本仓库原有 worklog 讨论 RAK 对比工具;
  work 写的 worklog 提「RAK 运行时文件未动」),非注入污染;README 无 marker;`.gitignore` 无 RAK 项;
  commit message(`e5973e5..HEAD`)0 个含 RAK/persona。
- **author**:am 保留 work 原 author(43 `rak-agent@local` + 30 `rak-daemon@local`);与原仓库历史
  (本就已有 43+30 个 rak-* author)**一致**——RAK 是本项目既有协作者身份,非本次引入,**无需重写**。

## 设计权衡 / 已知
- **为何剔 `.gitignore` 4 行而非补**:那是 RAK 运行时忽略项,与 monkey-deck 无关,补进来是噪音。
- **为何保留 author**:原仓库自己就有等量 rak-* author,是项目既有协作模式。
- AGENTS.md §0.5 写 `wails3 gen bindings`,实际 alpha 版命令是 `wails3 generate bindings`
  (`gen` 子命令不存在,顶层只有 `generate`)——既有文档偏差,work 那边 worklog 早已用 `generate`;
  本次未改正文,留待统一。

## 下一步
- 实机 `wails3 dev` 全功能验证(i18n 切换、权限规则、harness 升级、token 面板、终端、懒 spawn、设置中心等)。
- review 73 个 commit 后决定:并 `main` + push `origin`。
