# 2026-09-06 #196 阶段二/三 review:ACPCommand 解耦 + 灰态(APPROVE)

## 背景 / 起因

补审重放:前卡 review(#29012)peer_disconnected 阵亡零产出,实现三提交已合 main
未变(后端=d6df322、前端灰态=23b67ac、docs=44dab6b;基线 2cc9b2d=矩阵 worklog)。
本卡按原规格逐条反相追踪核实——不采信 commit 叙事,从字段定义点沿每个调用点
确认真实消费(「类型补丁」反模式检查)。

## 结论:**APPROVE**(①–⑥ 全过,零 needs changes)

### ① ACPCommand 字段语义 ✓

- `internal/harness/known.go:27-34`:`ACPCommand string`(json
  `acpCommand,omitempty`),注释明确「"" = no ACP channel (gray state)」。
- 发现键保持:`BinaryName` 仍是 LookPath 键(known.go:30;discover.go:248
  `p.LookPath(kh.BinaryName)`);`Keywords` 派生不变——`init` 仍
  `deriveKeywords(s.ID, s.Alias)`(known.go:124),knownSeed/deriveKeywords
  两函数 diff 零改动。

### ② knownACPCommand 钉值表 vs 实测矩阵 ✓

- known.go:109-112 恰好两条:`"codebuddy-code": "codebuddy --acp"`、
  `"codex-cli": "codex-acp"`。对照 `2026-09-06-acp-matrix-196.md`:
  codex-acp 裸命令可用(#17)✓、codebuddy `--acp` flag 形可用(#3)✓、
  claude-agent 留空(矩阵 #1 `claude acp` 20s 挂起判不可用)✓。
- 钉值不超出矩阵、无凭空新增:omp/opencode 是内置(Supported,不入目录表);
  opencode2/mimo/reasonix 不在 knownSeed(目录无条目,只能走 user harness 行),
  不可达即不可错。
- 防笔误不变量在位:`TestKnownACPCommand_KeysAreCatalogIDs`(map key 必须
  命中目录条目且钉值落位)、`TestKnownCatalog_ACPCommandPins`(锚定值断言)。

### ③ Stage4 + 物化:spawn 入口/展示身份分离 ✓

- `discover.go:253-265`:`cmd := kh.ACPCommand`(空则回落 `<BinaryName> acp`),
  `ID/Name` 取自 kh(发现键侧,图标走 ID 不变);`NeedsAdapter = kh.ACPCommand
  == ""` 且**条目仍 append**(不静默排除)。
- `chat.go:950-954` ensureCatalogHarness 物化 `Command = ACPCommand`;
  `user.go:99-103` effectiveRegistry 取 command 首 token 作 BinaryName →
  codex-cli 物化行 LookPath 的是 `codex-acp`(真实入口),注释与实现一致。
- 灰态消费全链路(类型补丁反查,零死字段):`Harness.NeedsAdapter`
  (harness.go:39,json `needsAdapter`)→ 生成 bindings
  `models.ts:52 "needsAdapter"?: boolean`(本机重跑 `wails3 task bindings`
  复核)→ `NewSessionModal.tsx:20 isSelectable = installed && !needsAdapter`
  单一定义喂四个消费点:lastHarness 预选、单卡自动选、排序 rank、点击门控
  (disabled + guard)→ tooltip 行 + 角标 chip。
- 测试锚定值断言在位:`catalog_discover_test.go:67-71/106-111`(钉值命中
  Command=ACPCommand、无钉值 NeedsAdapter=true 仍 listed)、
  `catalog_harness_test.go:124-128`(物化行 Command=ACPCommand、Name=目录名)、
  mount 测试(disabled 属性、chip testid、tooltip 逐字、排序沉尾、点击不选中)。

### ④ 边界硬性 ✓

- Supported 注册表不扩:harness.go:56-59 仍仅 omp/opencode(该 commit 未触及)。
- #187 三态不回退:命中(discover.go:248-271)、未命中跳过(:249-251,
  `TestDiscover_CatalogMissNotListed` 仍在且过)、撞车跳过(:243-247,
  `TestAddHarness_CatalogHitKeepsPlainID` 仍在且过)。
- #191/三铁律:fork 相关代码零改动(`git diff 2cc9b2d..44dab6b` fork 路径为
  空);本机重跑探针输出 `[fork] busy 中fork=✓`,Tier2 不阻断 CanAdd
  (probe.go:75 既有约定)——与 #191 结论引用一致,无文档冲突。

### ⑤ 测试与可复跑 ✓(全部本机重跑)

- `go build ./...` exit 0;`go vet ./...` exit 0;`go test -short ./...`
  全 ok 零 FAIL(注:本 worktree 曾被重置,untracked 产物
  node_modules/bindings/dist 被清,复跑前重新 `bun install` +
  `wails3 task bindings` + `bun run build` 再验,恰好证明了「可复跑」)。
- 真实桥接:`go test -tags=integration -run TestProbeCodexACP` **PASS
  (20.1s)**——codex-acp 真实 spawn+initialize,Tier1 init/session/stream/turn
  全 ✓,结论「可以添加」,与矩阵 #17、worklog 记录(99s 首跑)一致;
  skip-if-missing 守卫在位(codexacp_integration_test.go:22-24,沿
  probe_codebuddy_test.go 先例)。
- 前端 mount 测试隔离跑:`bun test src/components/NewSessionModal.mount.test.tsx`
  **10 pass / 0 fail**(8 既有 + 2 新增灰态),既有 harness 测试零回归。
  (全量 bun test 的 17 个既有失败为基线问题,与三提交无关,实现 worklog 已
  记录 stash 对照,本卡不重复展开。)

### ⑥ 文档一致性 ✓

- README.md:93-103 via-adapter 段:「agent 本身无 ACP 模式 → 装适配器 →
  PATH 上自动发现并 spawn 钉值命令(codex→codex-acp,已验证)→ 未装时灰态
  "needs an ACP adapter" 不可选」,Claude 条目注明 `claude acp` 不是可用
  入口——与实现逐点一致。
- known.go:2 头注改述(「已知 agent 目录,ACP 可用性由 ACPCommand 表达」)
  与字段语义一致。

## 非阻塞观察(记录,不要求改)

- NeedsAdapter 命中的 `Command` 落回落形 `<bin> acp`(矩阵已证该形对本条目
  无效,如 `claude acp` 挂起)。实际无通路:灰卡不可选 → ensureCatalogHarness
  不会为它物化,Command 仅作 tooltip 展示且状态行已指明缺适配器——与 #187
  未装卡「保留信息、置灰」契约同构,可接受。
- codex-acp 探针 Tier2 fork 能力不全(源存活/list/resume 多项 ✗),但
  Tier2 永不阻断 CanAdd,且 fork 声明位门控(§5.4 #14 铁律①)使未达标能力
  不会被调用——现状安全。

## 验证

见 ⑤(全部本机复跑,2026-09-06);静态核对见 ①–④、⑥(逐文件行号)。
三端说明:本卡为 review 零产品代码改动,仅新增本 worklog;实现卡的三端
记录见 `2026-09-06-acpcommand-decouple-gray-196.md`(真机终验留人项不变)。

## 下一步 / 留人

- 真机验收(实现卡已留人,非本卡范围):桌面 app codex 发现 → 选中 →
  codex-acp spawn;claude 发现 → 灰态不可选。
- 矩阵 3 个图标资源问题、全量 bun test 17 个既有失败排查——均已在实现
  worklog 记为另卡,本卡不派卡。
