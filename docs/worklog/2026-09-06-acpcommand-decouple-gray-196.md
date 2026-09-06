# 2026-09-06 #196 阶段二/三:ACPCommand 解耦 + 无通道灰态 + README 对齐

## 背景 / 起因

接续本日阶段一(`2026-09-06-acp-matrix-196.md`,main=2cc9b2d):17 项 tier-1 实测
矩阵(7 可用 / 10 不可用)已定基线。本卡落地阶段二(解耦 + 灰态)与阶段三(测试
+ 文档),矩阵为唯一输入,未重跑任何实测(除测试所需的 codex-acp 真实桥接验证)。

核心事实(来自矩阵):`codex` 本体无 ACP 模式(秒退),可用入口是 Zed 适配器
`codex-acp`(裸命令);`codebuddy` 的可用入口是 `codebuddy --acp`(flag 形);
`claude acp` 挂起不可用。即:**发现键(二进制名)与 ACP spawn 入口是两个东西**,
原 Stage4 目录命中一律 `Command = <BinaryName> + " acp"` 的假定被矩阵证伪。

## 改法

### 解耦(数据面)

- `KnownHarness` 新增 `ACPCommand string`(json `acpCommand`,空 = 无 ACP 通道):
  经 `knownSeed` 构建目录时由 `knownACPCommand` map 注入钉值。矩阵钉两条:
  `codex-cli → "codex-acp"`、`codebuddy-code → "codebuddy --acp"`;其余(含
  claude-agent,矩阵判不可用)留空。map + `TestKnownACPCommand_KeysAreCatalogIDs`
  不变量测试防 key 笔误静默丢通道。
- **发现键不变**:PATH 探测仍走 `BinaryName`(#187 三态原样);展示身份
  (ID/Name/图标)恒在发现键侧——codex-cli 图标照常给 codex-acp 入口用。
- `Discover` Stage4:命中项 `Command = ACPCommand`(空则回落惯例形
  `<BinaryName> acp`),`Harness` 新增 `NeedsAdapter bool`
  (json `needsAdapter,omitempty`)标记无通道命中。
- `chat.ensureCatalogHarness` 物化 user harness 行时 `Command = ACPCommand`
  (codex 选中 → 落库 `codex-acp`,spawn 即适配器;首 token 兼作 effectiveRegistry
  的 BinaryName,发现/回收对齐到真实入口)。

### 灰态(UI 面,与 #187 未装灰态同构)

- 前端 picker 网格(#188):`needsAdapter` 卡片 **disabled + 置灰
  (.ns-harness.needs-adapter)+ 角标 chip + tooltip 追加一行**
  「需 ACP 适配器」——不静默排除,保留发现信息价值。i18n 新键
  `settings.harness.needsAcpAdapter`(zh「需 ACP 适配器」/ en "Needs an ACP adapter")。
- 单一「可选」定义 `isSelectable = installed && !needsAdapter`,四个消费点锁步:
  lastHarness 预选、单卡自动选、排序 rank(灰卡沉入尾部,与未装同层)、点击门控。
  未装卡片保持原样可选(#187 契约零改动);#195 详情卡因灰卡不可选而天然零波及。

### README 对齐

- `README.md` "Via third-party adapters" 段:改述为「agent 本身无 ACP 模式,需装
  适配器;适配器在 PATH 上即自动发现并 spawn 钉值命令(codex → codex-acp,已验证
  spawn+initialize);未装时发现项灰态『需 ACP 适配器』不可选」,Claude 条目注明
  `claude acp` 不是可用入口。
- `known.go` 头注:「已知 ACP agent 目录」→「已知 agent 目录(ACP 可用性由
  ACPCommand 表达)」。

## 改了哪些文件

- `internal/harness/known.go`:ACPCommand 字段 + knownACPCommand 钉值表 + 头注。
- `internal/harness/harness.go`:Harness.NeedsAdapter 字段。
- `internal/harness/discover.go`:Stage4 命中项 Command/NeedsAdapter 按钉值。
- `internal/chat/chat.go`:ensureCatalogHarness 物化 Command=ACPCommand。
- `frontend/src/components/NewSessionModal.tsx`:isSelectable + 灰卡渲染。
- `frontend/src/index.css`:.ns-harness.needs-adapter。
- `frontend/src/i18n/locales/{en,zh}.json`:needsAcpAdapter 键。
- `README.md`:via-adapter 段。
- 测试:`internal/harness/catalog_discover_test.go`(命中钉值契约改写 + 新增无通道
  灰态测试)、`internal/harness/known_test.go`(钉值锚定 + map 不变量)、
  `internal/chat/catalog_harness_test.go`(物化 Command=ACPCommand)、
  `internal/acp/codexacp_integration_test.go`(新增,integration 标签,skip-if-missing)、
  `frontend/src/components/NewSessionModal.mount.test.tsx`(新增 2 个灰态测试)。

## 验证

- `go test ./internal/...` 全绿;`go vet ./...` exit 0;`go build ./...` 通过。
- `bun run build`(含 tsc)通过;`bun test`:552 pass / 17 fail / 569 tests——
  **17 个失败经 stash 干净树对照实测为既有失败**(干净树同样 17 fail / 550 pass,
  本卡 +2 全过),与本卡无关(clipboard 系 / App / Sidebar / FilePanel /
  AgentMarkdown,均非本卡触及文件)。
- 真实桥接(integration 标签):`TestProbeCodexACP` PASS(99s)——codex-acp 真实
  spawn + initialize,自报 `@agentclientprotocol/codex-acp`,Tier1
  init/session/stream/turn 全 ✓,结论「可以添加」,与矩阵 #17 一致。
- 三端说明(§4.7):本卡前端改动仅 NewSessionModal 网格灰态(纯 DOM/CSS,新增
  `disabled` 属性 + 置灰类 + tooltip 行,无断点/指针分支)。桌面 GUI 与远程浏览器
  由 bun mount 测试覆盖同一组件树(同一份前端,无 remote 守卫分支触及);PWA 端
  ≤768px 布局未改(灰卡沿用网格既有 auto-fill 布局,disabled 状态触屏等价——
  不可点即不可选,无 hover 依赖,tooltip 行同时写在角标 chip 上)。后端 binding
  能力(needsAdapter 字段下发)经 bindings 重新生成 + go 侧单测覆盖,三端共用。
  真机三端跑 UI 的终验留人(见下一步)。

## 下一步 / 留人

- 真机验收(任务指定留人):桌面 app codex 发现 → 选中 → codex-acp spawn 成功;
  claude 发现 → 灰态不可选。
- 矩阵图标审计的 3 个资源问题(codex-cli.png public 镜像缺、codex.svg 孤儿、
  codebuddy id 命名不一致)未在本卡范围,待另卡。
- 前端全量 bun test 的 17 个既有失败(clipboard 系等)疑与全量运行的 worker 批处理
  顺序相关(单文件隔离运行全过),建议另卡排查。
