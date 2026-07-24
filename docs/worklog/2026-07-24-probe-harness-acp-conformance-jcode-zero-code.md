# 2026-07-24 ProbeHarness:ACP 自检探针 + goose/jcode 零代码交叉验证

## 起因

前序多轮论证"ACP 是接口、harness 是可互换实例"都是理论。本条把它变成**可证伪实验**:
- **goose = 开发集**:允许基于它的真实分歧打磨泛化层 + 自检。
- **jcode = 留出测试集**:绝不看其 ACP 内部、不写一行 jcode 代码,只跑自检;零代码通过 = 论断成立。
- **硬约束**:禁一切 `if harnessID == X`(omp/opencode/goose 全禁),逃不掉的特殊处理需先确认。

## 设计(根因 = 把接口契约固化成探针)

`ProbeHarness`(`internal/acp/probe.go`)一次受控生命周期,把我们真实依赖的 ACP 契约跑一遍:
- 复用 `Runner.spawnAndInit`(拿 Initialize 能力矩阵)+ `conn.NewSession` + `conn.Prompt`,临时目录隔离,跑完即弃(不走 ChatSession/registerHarness,不污染活跃集合与 DB)。
- **每步硬超时**:诊断场景,不受 §3.3 no-timeout 约束(§3.3 是给活 turn 的);否则 mcpServers:null 那种死挂会挂住探针自己。
- **两层报告**:
  - Tier1 硬门槛(Initialized/NewSession/Streamed)任一不过 = `CanAdd()==false`。
  - Tier2 能力矩阵(resume/list/load/image/providers)+ 行为特征(messageId 发不发)**永不阻断**,只决定降级路径。
- **零身份分支**:只读能力位与协议字段。

## 改了哪些文件

- `internal/acp/probe.go`(新):`ConformanceReport` + `ProbeHarness(ctx, command)` + `Summary()`。
- `internal/acp/probe_integration_test.go`(新,`//go:build integration`):goose/omp/jcode 三探针。
- 合并 `goose-exp`(merge commit e523929)。

## 验证(三 harness 矩阵,实跑)

| harness | Tier1 | resume | list | messageId | 结论 |
|---|---|---|---|---|---|
| omp(默认)| init✓ sess✓ stream✓ turn✓ | ✓ | ✓ | **发** | ✅ |
| goose(开发集)| 全✓ | **✗** | ✓ | **不发** | ✅ |
| **jcode(测试集)** | 全✓ | ✓ | ✗ | **不发** | ✅ |

**关键:三个 harness 三套不同 profile,同一份零分支代码全吃下。**
- omp 发 messageId → messageId 归并;goose/jcode 不发 → tool 边界归并(防御路径)。
- omp/jcode 有 resume → resume 路径;goose 无 → skip-setup(能力位分流,goose-exp 已铺)。
- goose-exp 当年手写查出的两条分歧(resume 缺、messageId 缺),探针**自动复现**,无需任何 `if goose`。

**jcode 零代码通过 = 论断成立**:用 goose 训出的泛型探针,在没看过内部、没写过代码的 jcode 上 PASS。无过拟合。
- `go build ./internal/...` ✅;`go vet ./internal/acp/` ✅。
- `go test ./internal/acp/` ✅(2.4s,探针测试默认不编译)。
- integration:`go test -tags=integration -run TestProbeHarness -v ./internal/acp/` goose(3.2s)/omp(13.2s)/jcode(10.9s)全 PASS。

## 踩坑

- 初版 `probe_integration_test.go` **漏写 `//go:build integration`** → `go test`(无 tag)把探针编译进去 spawn 真 harness,常规套件 FAIL。补上标签后恢复绿。
- `acp.ProtocolVersion` 是自定义 int 类型(非裸 int)→ 报告字段 `int` 需 `int(...)` 转换;`conn.CloseSession` 返两值 → `_, _ =`。build 时暴露,已修。

## 结论 / 下一步

- **ACP 驱动层的"接口 + 可互换实例"论断,经留出测试集证毕**:jcode 零代码通过。
- **注**:本实验证明的是 **ACP 驱动/conformance 层**零代码。让 jcode 在 UI 里可选(进 `Supported`/`Registry`)仍需一条**数据声明**——那是元数据层地板(版本/升级/图标,见此前 worklog),不属于本实验断言。后续若要"声明即用",需把 `Supported`/`Registry` 从 Go 变量挪成数据目录/DB(约定驱动 C1-C6),让"加 harness"= 丢一行数据。
- 探针可进一步:接成 Wails3 binding,做"新增 harness 向导"(用户输命令 → 跑 ProbeHarness → 展示体检单 → 确认即加)。
