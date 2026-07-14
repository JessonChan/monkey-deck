# 2026-07-14 ACP harness 自动发现 + 版本检测 + 升级管理

## 起因
Task #15113。harness 列表此前是硬编码 `var Supported = []Harness{...}`(只 omp/opencode
两条,纯静态 ID/Name/Command)。需求:把它从硬编码改为运行时自动发现 + 检测本地版本 +
对照上游发布源查最新版本 + 提供升级接口 + 前端最小化展示/操作面板。

范围(本次聚焦):发现 + 版本检测 + 升级接口 + 基础 UI,不一次性对接所有发布源/包管理器。

## 设计(三层,分层避免硬编码,§5.3 KISS)

保留 `var Supported` 作为**静态注册表**(ID/Name/Command 三段,顺序稳定,DefaultID 在首位),
所有现有契约(Command/Normalize/Commands/进程回收)不动。新增三层:

1. **Registry(`internal/harness/registry.go`)**:每个已知 harness 一条 `Spec` ——
   发现参数(BinaryName/VersionArgs)+ 可选 `ReleaseSource`(查上游最新)+ 可选 `Upgrader`。
   当前:
   - opencode:GitHubSource(sst/opencode)+ CommandUpgrader(官方安装脚本 `curl | bash`)。
   - omp:暂无 Source/Upgrader(待发布源确定后补,只需改 Registry 一处)。

2. **Discover(`internal/harness/discover.go`)**:运行时纯函数,扫 Registry 每 Spec:
   - Probe.LookPath(默认 exec.LookPath)→ Probe.Version(默认 `<bin> --version`)→ 异步并行查 Source.Latest。
   - 派生:UpgradeAvailable = Installed 且当前 < 最新。
   - Probe/Registry 都可注入(测试不真起子进程、不真打 GitHub)。

3. **ReleaseSource + Upgrader(接口,§5.1)**:
   - GitHubSource:打 GitHub v3 REST `/releases/latest`,User-Agent 强制(否则 403)。
   - CommandUpgrader:跑配置好的命令(委托官方安装脚本/包管理器),不直接覆写可执行文件
     (避免与包管理器打架,§3.5 外部事实先验证)。

版本比较:`compareVersions` 按 '.' 切段,数值段按数值比(避免 "10"<"9" 字符串错位),
非数字段字符串 fallback。非严格 semver,够用即可。

## 改法(分 3 层,与既有架构对齐)
- **纯逻辑层 `internal/harness/`**:`harness.go`(Harness 加 6 个运行时字段 + 注释分层),
  `registry.go`(Spec/Registry),`discover.go`(Probe/Discover/compareVersions/extractVersion),
  `release.go`(Release/GitHubSource),`upgrade.go`(Upgrader/CommandUpgrader/Upgrade/ErrUpgraderNotConfigured)。
  零 DB / 零 ACP / 零 Wails 依赖,接口注入即可单测。
- **Service 层 `internal/chat/chat.go`**:
  - ChatService 加 `harnessCache atomic.Pointer[[]harness.Harness]`。
  - 新增事件 `EventHarnesses = "chat:harnesses"`:发现/升级后推前端,前端据此重拉。
  - `ListHarnesses` 改返缓存(未就绪回退静态 Supported,前端启动不退化)。
  - 新增 `RefreshHarnesses`(立即重刷,返回 enriched 列表)、
    `UpgradeHarness(id)`(调 Upgrader → 重发现 → 把错误塞进对应 harness.UpgradeError)。
  - ServiceStartup 起 `refreshHarnessesAsync`(5s 超时,失败静默降级)。
- **前端**:
  - `HarnessSettings.tsx`(列表 + 命令/当前版本/最新版本/路径 + 升级/安装/刷新按钮 + 状态徽章)。
  - App.tsx 监听 `chat:harnesses` 事件重拉;Sidebar 加 `Boxes` 图标入口。
  - i18n(zh/en)+ CSS(复用 perm-settings-card 风格 + 新增 harness-row 样式)。

## 关键决策与边界
- **不重写 `Supported` 为函数**:保留 `var Supported`(静态),新增 `Discover()`(运行时)。
  单一事实源 + 零现有契约破坏(进程回收/Command/Normalize 不动)。
- **降级路径明确**:Source 失败 → LatestVersion 空,不抛错;Probe 找不到 → Installed=false;
  Upgrader 未配置 → ErrUpgraderNotConfigured(可 errors.Is 判定)。
- **升级策略**:默认委托外部安装脚本(opencode 走官方 install script),不自下 release asset
  覆写可执行 —— 与包管理器不冲突。AssetUpgrader 留作后续按需。
- **启动不阻塞**:ServiceStartup 异步发现(5s 超时),前端首次拿到的是静态 Supported,
  异步完成后推 EventHarnesses 让前端重拉 enriched。
- **不 pretent 含 omp 发布源**:Registry 里 omp 的 Source/Upgrader 留 nil,前端展示「未配置」
  而非假装能查最新。后续确定 omp 发布源/包管理器后,改 Registry 一处即可。

## 改了哪些文件
- 新增 `internal/harness/registry.go` / `discover.go` / `release.go` / `upgrade.go`
- 新增 `internal/harness/discover_test.go` / `upgrade_test.go`(extractVersion/compareVersions/
  Discover 三组场景/GitHubSource httptest/CommandUpgrader 成功失败/Upgrade 路由)
- 改 `internal/harness/harness.go`(Harness 加 6 字段 + 包注释分层)
- 改 `internal/chat/chat.go`(harnessCache + EventHarnesses + ListHarnesses/Refresh/Upgrade
  + refreshHarnessesAsync + atomic import)
- 新增 `internal/chat/harness_test.go`(静态兜底/刷新事件/Upgrade 路由/错误传播/未知 id)
- 新增 `frontend/src/components/HarnessSettings.tsx`
- 改 `frontend/src/App.tsx`(状态 + EventHarnesses 订阅 + 渲染)
- 改 `frontend/src/components/Sidebar.tsx`(Boxes 图标按钮入口)
- 改 `frontend/src/index.css`(harness-settings/harness-row 样式)
- 改 `frontend/src/i18n/locales/{en,zh}.json`(settings.harness.* 文案)

## 验证
- `go build ./...` / `go vet ./...` 全绿(仅 macOS 链接器 SDK 版本警告,与改动无关)。
- `go test ./...` 全绿:harness(extractVersion/compareVersions/Discover×3/GitHubSource×2/
  CommandUpgrader×2/Upgrade 路由)+ chat(ListHarnesses 兜底/RefreshHarnesses 事件/
  UpgradeHarness×3)+ 既有包不退化。
- `wails3 generate bindings` 重新生成(chatservice 暴露 RefreshHarnesses/UpgradeHarness
  + Harness model 加 6 字段)。
- `cd frontend && bun run build`(tsc + vite production)通过,无类型/编译错误
  (仅预存在 chunk>500kB 警告)。
- `frontend/dist/index.html` 临时 stub(go:embed 要求目录非空,被 .gitignore 排除不入库)。

## 下一步
- 手动 `wails3 dev` 验证:启动后侧栏 Boxes 图标 → 打开 harness 面板 → 看到 omp/opencode
  的本地版本(若已装)+ opencode 的 GitHub 最新版 + 升级按钮;点升级跑安装脚本,
  完成后版本号刷新。
- 确认 omp 发布源/包管理器后,在 Registry 里给 omp 补 Source/Upgrader(只需改一处)。
- 可选:AssetUpgrader(直接下 GitHub release asset 到约定目录),为不通过包管理器安装的
  harness 提供独立路径;本次未做,避免与既有包管理器冲突。
