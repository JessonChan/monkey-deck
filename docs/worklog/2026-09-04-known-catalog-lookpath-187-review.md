# 2026-09-04 KnownCatalog PATH 自动发现(#187)轻量 Review 记录

> 审查对象:3876478(实现)+ f37d101(worklog)。
> **轻量审查(diff 审读 + 关键不变量核对 + 测试代码读审);全量复跑因 provider 间歇降维,留后续补强**——未重跑 RED/GREEN,未做全量独立复跑;补了 `go build ./internal/...` 与 `go vet`(两包,含测试文件编译)作为廉价 sanity,均过。

## 结论

**六项关键不变量全部 PASS,未发现 High/Medium 问题。** 实现与 worklog 叙述一致,边界标记(`Source=catalog`)是真实的全链路消费字段,不是「类型补丁」。可合入;真机 PATH 验证仍是关闭 #187 的前置(worklog 已留)。

## 核对清单(逐项)

① **边界(不设 default / 不进升级链 / 不进深探)— PASS**
- 不设 default:`DefaultID`/`Normalize`(`harness.go:56,67`)零改动;目录条目只追加在 Discover 尾部;空 harnessID → `KnownHarnessByID("")` 返 nil → `Normalize` 回退 omp,原路径不变。
- 不进升级链:目录条目不带 Spec(`discover.go:247-254` 零值构造),UpgradeAvailable 派生循环(阶段 3,`discover.go:218-222`)只扫 `inst`,阶段 4 在其之后追加 → 恒零值;`maybeAutoUpgrade`(`chat.go:3678`)按 `!h.UpgradeAvailable` 自然跳过——零新代码,worklog 所述属实。
- 不进深探:`probeCapabilitiesAsync`(`chat.go:3412-3416`)在 `Installed` 判定**之前**按 `Source==SourceCatalog` 排除;且它是唯一的自动 spawn 探测路径(#191 `ProbeNewHarness` 是用户显式发起,未触碰)。逐消费点反查:`Source` 后端消费两处(深探过滤 + `resolveHarnessID` 撞名检查)+ JSON 透传前端,非死字段。

② **撞 id 目录版优先(去重)— PASS**
- `seen` 建自 `inst`(`discover.go:231-234`),而 `inst` 覆盖 `effectiveRegistry()` 全部条目;`effectiveRegistry`(`user.go:83-107`)含**全部** user harness id(不论安装状态)+ 静态 Registry ⊆ Supported → 未安装的 user/builtin id 也在 `seen` 里,不存在「未装条目不在 seen → 目录条目补位 → 重复 id」路径。KnownCatalog 本身不含内置(既有测试断言)。
- AddHarness 侧:`resolveHarnessID` 撞目录命中 → 手动项消歧 -2;缓存为空的降级(裸 id 归属换人)已注释声明,且 Discover 侧兜底保证列表恒无重复。

③ **--version 失败静默、Installed 保持 true — PASS**
- `discover.go:252` 无条件置 `Installed=true`;`:257` 版本仅 `verr == nil` 时写入。
- 测试真实踩中错误分支:`fakeProbe2.Version`(`discover_test.go:30-41`)在 vers 缺 key 时返 `errNotFound`,`TestDiscover_CatalogVersionFailureSilent` 断言锚定值(Installed==true 且 InstalledVersion=="")。

④ **LookPath 三态测试在位 — PASS**:命中(`TestDiscover_CatalogHit`,含尾部位置/Path/Source/惰性零值/Command/Name 锚定)/ 未命中(`TestDiscover_CatalogMissNotListed`)/ 撞车(`TestDiscover_CatalogYieldsToExistingID`,user 与 builtin 双撞,exactly-once + 胜者无标记 + UserDefined 断言)。

⑤ **BinaryName 携带、Keywords 派生不回退 — PASS**:init 同处赋值(`known.go:631-639`),`deriveKeywords(s.ID, s.Alias)` 原样;`TestKnownCatalog_BinaryNameCarried` 全量非空扫描 + 4 个种子锚定(claude-agent→claude / github-copilot→copilot / docker-cagent→cagent / goose→goose,与 `known.go:41,55,60,62` 种子表核对一致);`TestKnownHarnessByID` 命中/未命中在位。

⑥ **红线 — PASS**:Supported 成员零改动(仅加 `Source` 字段 + `SourceCatalog` 常量);Registry/升级链/maybeAutoUpgrade 逻辑零改动(diff 仅阶段 4 追加 + chat 三处边界点);`resolveHarnessID` 全仓唯一调用点是 AddHarness(`chat.go:3275`),#191 探针不经它;#189 fork 水位相关文件未触碰;KnownCatalog 顺序 = seed 顺序(init 保序消费,只追加不重排);worktree 干净,worklog 落库。

## 发现清单(按严重度)

- **Low-1|ensureCatalogHarness DB 错误路径 → 静默弹回 omp**:`GetUserHarness`/`CreateUserHarness` 报错时 warn 后 return,`Normalize` 把目录 id 弹回默认 omp——恰是设计要防的「静默跑错 agent」,但仅在 DB 错误这一罕见边沿可达,且被 Warn 日志覆盖。设计选择了可用性(不硬失败),可接受;记录为已知取舍。
- **Low-2|并发双落行的窄窗口**:两个并发 CreateSession 同目录 id,双双通过 `existing==nil` 检查,后者的 INSERT 撞 UNIQUE(`store/user_harnesses.go:28`)报错早退;若此时前者尚未跑完 `reloadUserHarnesses`,后者 session 的 Normalize 仍可能弹回 omp。单用户桌面 + 毫秒级窗口,实际风险极低;结果仍幂等(仅一行)。
- **Info-3|resolveHarnessID 读缓存是 best-effort**:缓存冷/陈旧时裸 id 归属可能翻给手动行(列表仍无重复)——代码注释与 worklog 均已声明,Discover 侧兜底成立。
- **Info-4|Discover 每轮新增 ≤50 次串行 LookPath + N 次串行 `--version` spawn**(N=实际命中数):与阶段 1 同形态;触发节奏为启动 + 1h ticker + 显式刷新,桌面节奏下可接受。留意未来若缩短 ticker 周期需回看。
- **Info-5|转正后条目形态翻转**:落行后同 id 条目由 catalog 版(UserDefined=false,Source=catalog)变为 user 版(UserDefined=true,Source="")——标记消失、可编辑可删;删行后下轮 Discover 目录条目回归。生命周期自洽,无幽灵条目。
- **Info-6|`source` 字段前端暂无消费**:后端两处消费真实存在;前端徽标区分为 worklog 已声明的 OPEN 项。bindings 为构建期本地生成(仓库不跟踪),与提交内容一致。
- **Info-7|gofmt 顺带改动**:chat.go 的 9 行删除均为列对齐重排 + 2 处空行收敛,零语义(逐行核对);轻微 §6.2「不夹带」,不构成问题。

## 验证

- 逐 hunk 读审 3876478 全量 diff(702 行)+ 相关源码读审:`discover.go`(全函数)/`harness.go`/`user.go`/`known.go`/`chat.go`(ensureCatalogHarness / probeCapabilitiesAsync / maybeAutoUpgrade / resolveHarnessID / reloadUserHarnesses / ListHarnesses / GetLastHarness)/ 两个新测试文件 + `discover_test.go` 的 fakeProbe2。
- `go build ./internal/...` OK;`go vet ./internal/harness/ ./internal/chat/` OK(测试文件编译通过)。
- **未重跑 RED/GREEN、未做全量独立复跑(provider 间歇降维),留后续补强**;worklog 声称的测试结果本轮仅做代码级核对,未独立复现。

## 下一步 / OPEN

- 全量复跑补强(RED/GREEN 独立复现)待 provider 间歇期结束补做;
- 真机 PATH 验证(命中项入列 / 选中可起)仍是 #187 关闭前置(原 worklog 已留);
- Low-1/Low-2 若后续要收敛:ensureCatalogHarness 失败可改硬失败(报错优于弹回默认),并发窗口可由「INSERT 冲突后重查一次 + reload」消除——均属可选加固,非本轮缺陷。
