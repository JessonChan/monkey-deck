# 2026-07-26 能力矩阵补模型选择位 + 透出前端(ListHarnessCapabilities binding 接线)

## 起因

Task #23415(承接 Task #23414 的 CapabilityMatrix / ProbeCapabilities / ListHarnessCapabilities /
EventHarnessCapabilities)。两件事:

1. **A. 补模型选择位(Task 1 遗漏,issue 必需)**:issue 探测维度明确要求「模型选择:configOptions
   有没有 model/mode/effort」——这是 issue 核心诉求(「有的 harness 没模型选择」)。但 Task 1 的
   `matrixFromInit` 只读 `Initialize.AgentCapabilities`,`ProbeCapabilities` 虽然调了 NewSession 却
   **丢弃了响应的 `ConfigOptions`**。模型选择类 config option 只在 NewSession/LoadSession 响应里自报
   (runner.go:85 / handler.go FlattenConfigOptions),不在 Initialize 响应里,所以 Task 1 整条探测
   路径都没机会拿到它。
2. **B. 能力矩阵透出前端(issue Task 2 段)**:Task 1 已建 `ListHarnessCapabilities()` 导出方法 +
   `chat:harness-capabilities` 事件,但前端没接(没调、没订阅),数据到不了 UI。

## 根因 / 协议调研

- ACP `SessionConfigOption` 是 union(`Select` / `Boolean`),稳定面是 `Select`(单值下拉)。
  `SessionConfigOptionSelect` 带 `Category *SessionConfigOptionCategory`(语义信号)+ `Id SessionConfigId`。
- SDK 枚举 `SessionConfigOptionCategory` = `mode | model | thought_level`(spec 明文,UX only,Clients
  MUST handle missing gracefully)。**没有 "effort"**——UI 里的 "effort" 是 `thought_level` 的别名
  (见 `ModelSelect.mount.test.tsx`:第三个下拉 category=thought_level,旧代码错误地硬编码 configId
  "effort" 是 bug)。
- 不变量(§5.3):判别「这是哪类选择器」应按**协议语义信号 category**(协议枚举,权威答案),
  不靠 id 启发式。category 缺省时退化到按 **spec 字面量 id**(model/mode/thought_level)兜底;
  **不硬编码 agent 私有 id**(如 thinking_budget——那是旧前端 bug 的根源)。这样既尊重数据源
  (category 优先),又对真实场景鲁棒:opencode 的 effort 选择器 id 可能是私有名,但 category=
  thought_level,按 category 仍能正确判 effort。

## 改法

### A. 后端:模型选择位(`internal/acp/capability.go`)

- `CapabilityMatrix` 新增三字段(倾向分三位,UI 好按位门控,而非聚合 HasModelSelect):
  `ConfigModel / ConfigMode / ConfigEffort bool`(JSON: configModel / configMode / configEffort)。
  归属「NewSession ConfigOptions 抽取位」,与声明位(Initialize)、行为观测位(noop Prompt)并列。
- 新增纯函数 `configBitsFromOptions(opts []acp.SessionConfigOption) (model, mode, effort bool)`:
  遍历 opts,只看 `Select`(Boolean unstable 不算),category 优先、缺省按 spec id 兜底,switch
  `SessionConfigOptionCategoryModel/Mode/ThoughtLevel`。纯函数便于单测注入。
- `ProbeCapabilities`:NewSession 成功后(在 withProbe 分支**之前**——零 token 成本路径)调
  `configBitsFromOptions(sess.ConfigOptions)` 填三位。NewSession 失败时三位保持 false(拿不到)。
- `matrixFromInit` **不变**(模型选择不在 Initialize,留给 ProbeCapabilities 主流程填),Task 1
  的单测不变。

### B. 前端:能力矩阵透出接线(`frontend/src/App.tsx` + `Sidebar.tsx`)

**选式取舍(coder 判断,§5.3 复用)**:issue 给了两个选式——
- (a) `Harness` struct 内嵌 `CapabilityMatrix`,`ListHarnesses` 返回时带上;
- (b) 独立 `ListHarnessCapabilities` 经 Wails3 binding 透出。

**选 (b)**,理由:
- **解耦**:`ListHarnesses` 不被 matrix 拖累。matrix 是异步探测(Discover 之后才填),未就绪时
  返回 nil;若内嵌进 Harness,harness 选择 UI 会被 matrix 的「检测中」态污染。
- **时序独立**:`chat:harness-capabilities` 事件与 `chat:harnesses` 事件解耦,probe 慢/失败不
  抖动 harness 列表。
- **零额外成本**:Task 1 的方法 + 事件已就位,本 task 只接前端。

接线(镜像现有 `chat:harnesses → ListHarnesses` 范式,App.tsx:337-340):
- `App.tsx`:新 state `harnessCapabilities`(type `Record<string, CapabilityMatrix | undefined>`);
  启动调 `ChatService.ListHarnessCapabilities()` + 订阅 `chat:harness-capabilities` 事件重拉;
  useEffect cleanup 里 `offHarnessCaps()` 卸载订阅。
- `Sidebar.tsx`:新增可选 prop `harnessCapabilities?`(Sidebar 已接收 `harnesses` 做 ID→显示名查表,
  是 per-harness 能力徽标的自然落点)。**只接线,不渲染**(UI 渲染归 Task 3)。
- 类型走 generated bindings(`wails3 generate bindings -ts` 自动产):`ListHarnessCapabilities` 返回
  `{ [x: string]: CapabilityMatrix | undefined }`,故 state/prop 类型用 `Record<string, CapabilityMatrix | undefined>`
  对齐(production binding 产 `{ [x: string]: ... | undefined }`,非 `{ [_ in string]?: ... }`)。
- `noUnusedLocals:true` 下 state 值必须有消费者;Sidebar 用 `props: Props` 属性访问(非解构),
  未读的对象属性不被 noUnusedLocals 标记 → 透 prop 到 Sidebar 是「接线」的最干净落点,Task 3
  可直接消费(若 Task 3 选别的消费者,移 prop 一行)。

### 持久化:跳过(issue 明确「持久化可选,默认内存即可 KISS」)

Task 1 的 `capabilityCache`(atomic.Pointer,启动后零成本异步 re-probe,withProbe=false 不耗
token)已满足「UI 可查」。本 task 不加落盘/加载。

## 改了哪些文件

- `internal/acp/capability.go`(改:CapabilityMatrix +ConfigModel/Mode/Effort;configBitsFromOptions
  纯函数;ProbeCapabilities NewSession 后填三位)
- `internal/acp/capability_test.go`(改:新增 TestConfigBitsFromOptions 6 例,保留 Task 1 既有测试)
- `frontend/src/App.tsx`(改:CapabilityMatrix 类型 import + harnessCapabilities state + 启动拉取 +
  chat:harness-capabilities 订阅 + cleanup + 透 prop 给 Sidebar)
- `frontend/src/components/Sidebar.tsx`(改:CapabilityMatrix 类型 import + Props 增
  harnessCapabilities 可选 prop)

## 验证

- `go build ./...` / `go vet ./internal/acp/... ./internal/chat/...`:clean。
- `go test ./internal/...`:全绿。`TestConfigBitsFromOptions` 6 例(category 三类 / category 缺省按
  spec id 兜底 / 私有 id 无 category 不误判 / 私有 id + thought_level category 判 effort /
  Boolean 忽略 / 只 model)+ Task 1 既有 matrixFromInit/ProbeCapabilities 测试全过。
- `npm run build`(tsc + vite):零 TS 错误。
- `wails3 task build`:全过(gen bindings + 前端 build + Go production build,产出 bin/monkey-deck)。
- 不回归:Discover / 升级 / harness 选择 / ListHarnesses / 发消息 / 图片附件 均未改其代码路径。

## 下一步

- Task 3:UI 渲染。按能力位门控:per-harness 能力徽标(Sidebar 的 harnessCapabilities 已就位)、
  model-select / mode / effort 入口显隐(替换当前零散的 `SupportsImage` 单点判定,统一从 matrix 取)。
- 若需 EmitsUsage/EmitsPlan 填值:再开 withProbe=true 路径(当前默认 false,零 token)。
