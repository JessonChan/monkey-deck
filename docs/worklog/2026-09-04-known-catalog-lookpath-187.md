# 2026-09-04 KnownCatalog PATH 自动发现(#187,探测重放第 3 轮)

## 背景 / 起因

#187:KnownCatalog(50 个非内置 ACP agent 目录,#known-catalog 初始落地见
`docs/worklog/2026-09-02-harness-icons-and-keyword-match.md`)此前只用于
Add Harness 弹窗的命令关键词匹配,**不参与运行时发现**——用户装了目录里的
agent(如 goose / gemini / claude),harness 列表完全不显示,只能手动
AddHarness 填命令。本轮(规格冻结自 MON-655)把目录变成 PATH 探测源:
命中即「可用」。

## 设计(不变量优先)

- **单一来源标记**:发现产出的目录条目带 `Harness.Source = "catalog"`
  (新常量 `SourceCatalog`)。所有「只是可用,不是正式成员」的边界
  (不设默认 / 不进升级链 / 不进能力深探)都锚在这一个标记上,
  不按列表位置或 id 黑名单做启发式(§5.3 找不变量,不堆 if)。
- **目录条目天然进不了升级链**:目录项不产生 Spec(Registry 零改动),
  无 Source → LatestVersion 恒空 → UpgradeAvailable 恒 false,
  `maybeAutoUpgrade` 按 UpgradeAvailable 筛选自然不碰它(零新代码)。
- **可用性落地 = 转正为 user harness**:spawn 管线只认
  `effectiveSupported`(Supported + user harness 行),目录项不在其中,
  直接放行会被 `Normalize` 弹回默认 omp(**静默跑错 agent,比报错更糟**)。
  故用户选中目录命中项建 session 时,先按 AddHarness 同款静默落一行
  user harness(command = `<BinaryName> acp`,首 token = BinaryName,
  effectiveRegistry 派生的发现二进制与目录探测一致),再 Normalize。
  幂等(已有行不重复落);不按安装状态门控——UI 只会列出命中项,
  陈旧 id spawn 失败是响亮报错,好过静默换成默认。
- **撞车去重双向兜底**:
  - Discover 侧:目录项撞内置 / 用户已有 id → 已有条目优先,目录条目跳过
    (seen 集合,列表恒无重复 id)。
  - AddHarness 侧:手动添加派生 id 撞目录命中 → 目录版保住裸 id,
    手动项经 `resolveHarnessID` 消歧成 `-2`。消歧查 harnessCache 的
    Source=catalog 集合(best-effort):缓存陈旧漏检时,Discover 侧
    兜底仍保证无重复,只是裸 id 归属换人(可接受的降级,已注释)。

## 改动

- `internal/harness/known.go`:`KnownHarness` 增 `BinaryName`(= seed Alias,
  init 携带;Keywords 派生不变);新增 `KnownHarnessByID`。
- `internal/harness/harness.go`:`Harness` 增 `Source string`
  (`json:"source,omitempty"`,空 = 正式成员);新增 `SourceCatalog` 常量。
- `internal/harness/discover.go`:`Discover` 阶段 4——目录逐项
  `Probe.LookPath(BinaryName)`,命中追加「可用」条目
  (ID/Name/Command=`<BinaryName> acp`/Path/Installed=true/Source=catalog),
  版本走 `Probe.Version(--version)` 失败静默(Installed 保持 true,
  版本空 = 增强非门控);目录条目恒在列表尾部,KnownCatalog 顺序稳定。
- `internal/chat/chat.go`:
  - `probeCapabilitiesAsync` installed 收集循环按 `Source==SourceCatalog`
    排除(目录项不做深度能力探测——那会 spawn 未 vet 的二进制);
  - 新增 `ensureCatalogHarness`(CreateSession / CreateGuestSession
    Normalize 前调用):静默落 user 行 + reload + Discover + emit +
    异步 probe(与 AddHarness 同款收尾序列);
  - `resolveHarnessID` 增目录命中占位检查(见上)。
- 测试:
  - `internal/harness/catalog_discover_test.go`(新):三态(命中入列 /
    未命中不出现 / 撞用户+撞内置去重)+ --version 失败静默 + 尾部追加
    + 条目惰性(Source=catalog、无升级位、非 UserDefined)。
    复用 fakeProbe2 伪 PATH 注入形态;swapCatalogForTest 换合成目录
    (不依赖 knownSeed 内容)。
  - `internal/chat/catalog_harness_test.go`(新):建 session 静默落行 +
    session.harness 钉目录 id(不弹回 omp)+ 幂等 + lastHarness;
    非 catalog id 原路径(未知 id 照旧回退 omp,不落行);
    AddHarness 撞目录命中 → 目录保裸 id + 手动 -2 + 列表无重复 + 只落手动行。
  - `internal/harness/known_test.go`:BinaryName 全量非空 + 锚定
    claude-agent/copilot/cagent/goose 种子;`KnownHarnessByID` 命中/未命中。

## 边界确认(红线)

- Supported(omp/opencode)契约、Registry 成员、升级链现有逻辑零改动
  (diff 仅 discover.go 追加阶段 4 + chat.go 三处边界点)。
- KnownCatalog 顺序稳定(init 顺序 = seed 顺序,只追加消费不重排)。
- #191 探针(ProbeNewHarness)与 #189 fork 水位逻辑零波及(未触碰相关文件)。
- KnownCatalog 顺序稳定;深探排除只对 Source=catalog 生效,现有成员
  (Source 为空)行为不变。

## 验证

- `go build ./...` 通过(仅既有 macOS SDK ld warning,与改动无关);
- `go vet ./internal/harness/... ./internal/chat/...` exit 0;
- `go test ./internal/harness/... ./internal/chat/...` 全绿
  (含 7 个新用例 `-count=1` 实跑:harness 4.6s / chat 4.4s,均 ok;
  既有 harness 测试零回归);
- fakeProbe 伪 PATH 注入形态保持(fakeProbe2 / fakeStubProbe 均未改动,
  新测试直接复用)。
- **留人(真机)**:PATH 命中项(如已装 goose / gemini 的机器)应出现在
  harness 列表尾部、可选、建 session 能起;设置面板目录项显示「已是最新」
  徽标属预期(无升级链,显示语义沿用 installed+无 upgrade 组合),后续若
  要区分「目录可用」徽标属前端增强,本轮不做。

## 下一步 / OPEN

- 真机验证(用户 PATH 有目录 agent 时)后关闭 #187;
- 前端如需区分目录条目徽标 / 「可用(未转正)」文案,消费
  `harness.source === "catalog"` 即可(模型已带该字段,bindings 本地重生成);
- 目录命中项若与用户手动项长期并存(-2 消歧),是否要在 UI 提示合并,
  待产品反馈。

## 环境备注

本轮会话两次遭遇 worktree 被重置到 HEAD(未提交改动丢失),最终以
「改动 → 验证 → 立即提交」紧链路完成;基线前移至 bae2764
(store list projection,与本规格零冲突,以最新为准)。
