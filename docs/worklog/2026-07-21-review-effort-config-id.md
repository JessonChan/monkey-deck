# 2026-07-21 Review:#40 effort 切换 configId 硬编码修复端到端验收

## 起因

任务 #21293(Reviewer):对 PR #40(实现 #21292)的 effort 切换 configId 硬编码修复
做端到端验收。

实现 worklog(`2026-07-21-effort-config-id-hardcoded.md`)的「下一步」显式标注:

> 运行时验证:起桌面 app,在支持 effort 的 model(GLM-5.2 / Claude / GPT-5 等)上切
> effort,确认 agent 实际生效(thought_level 改变)。当前改动在 opencode id="effort" 下
> 行为等价,主要价值是协议正确性与未来 harness 适配的稳健性。

本审查 = 闭合这条「真验证」环节,并补齐实现缺失的回归测试(AGENTS.md §5.3 硬约束:
「每个 bug 修复必须配一个能复现该 bug 的测试」)。

## 审查范围

PR #40 已 merge 进当前分支的 commit:

- `4acc2af fix(composer): 切 config option 用 option.id 而非硬编码字符串`
- `54eba63 docs(worklog): effort 切换 configId 硬编码修复记录(Task #21292)`

涉及文件:`frontend/src/components/Composer.tsx`(`ModelSelect` 3 处 `onSetConfig` 调用)。

## 审查方法(防「编译绿但 bug 还在」)

Reviewer 角色最常见的失败模式是「签名改了但函数体行为没变 / 类型补丁」。对本次改动,
逐一验证字段真实消费:

1. **diff 真实改变行为(不是类型补丁)**:`Composer.tsx:654-656` 三处 `onSetConfig` 调用,
   从硬编码 `"model"` / `"mode"` / `"effort"` 改为 `modelOpt.id` / `modeOpt.id` / `effortOpt.id`。
   这是 **call site 参数值的改变**,不是「加了类型让编译过」——三个回调闭包真正读取了
   `ConfigOption.id` 字段并透传给 `onSetConfig`。

2. **`id` 字段数据源真实(不是前端硬编码/巧合)**:完整链路通电:
   - `ConfigOption.id`(前端 `types.ts:58`)← 后端 `ConfigOption.ID`(`handler.go:74`,
     JSON tag `"id"`)← `FlattenConfigOptions` 里 `ID: string(o.Select.Id)`(`handler.go:98`)
     ← ACP SDK `o.Select.Id`(协议字段)。
   - 即:前端拿到的 `id` 是 **ACP 协议自报的 `Select.Id`**,不是任何方重新发明的。
   - 与 `category` 是两个独立字段:`category` 用于 UI 查找(`c.category === "thought_level"`),
     `id` 用于回写 ACP `session/set_config_option` 的 `ConfigId`。old 代码把两者绑死成同字符串。

3. **configId 透传链路真实到 ACP**:`onSetConfig(configId, value)`(Composer)→
   `ChatService.SetSessionConfigOption(sid, configId, value)`(App.tsx:800,Wails binding)→
   后端 `SetConfigOption`(runner.go:340)→ `acp.SessionConfigId(configId)`(runner.go:344)。
   configId 字符串**原样透传到 ACP 协议**,中间无变换。所以前端传什么 id,ACP 就收什么 id。

4. **opencode 下行为等价性(PROCESS.md:213 实证)**:opencode 1.17.11 经诊断程序证实
   `category=thought_level, id=effort`。所以 `effortOpt.id === "effort"` —— 新代码在当前
   harness 下与旧代码行为完全相同,**修复价值是协议正确性与未来 harness 适配稳健性**
   (换一个 id ≠ category 的 harness,旧代码会静默落空)。

## 回归测试(补齐实现缺失的测试)

AGENTS.md §5.3 硬约束:「每个 bug 修复必须配一个能复现该 bug 的测试」。实现 PR #40
仅做了 `tsc` + `go build/vet`,**未加任何复现该 bug 的测试**。本 review 补齐:

新增:`frontend/src/components/ModelSelect.mount.test.tsx`(3 用例)。

- **测试设计**:用 `id` 故意 ≠ 旧硬编码字符串的 config options
  (model id=`model_id_custom`、mode id=`build_mode`、effort id=`thinking_budget`),
  mount `ModelSelect`,驱动下拉选中 option,断言 `onSetConfig` 收到 **option.id** 而非
  `"model"`/`"mode"`/`"effort"`。
- **复现验证(关键)**:临时还原旧硬编码(把 `effortOpt.id` 改回 `"effort"` 等)后跑测试,
  **3 个用例全部 FAIL**,实际收到 `["effort","low"]` / `["mode","plan"]` / `["model","ant/claude"]`
  (硬编码字符串),而非期望的 `["thinking_budget","low"]` / `["build_mode","plan"]` /
  `["model_id_custom","ant/claude"]`。**测试真的复现了 bug,不是空 assert。**
- **恢复修复后**:3 个用例全部 PASS。

### 测试基建决策

- **mock `@radix-ui/react-popover` + `cmdk`**:Radix `FocusScope` 在 happy-dom 里
  `dispatchEvent` 因 cross-realm `Event` 构造器校验失败;cmdk 依赖 `ResizeObserver`(happy-dom
  无)。这两个是 UI 库内部机制,与本次修复无关。mock 成薄透传(Popover 用 context 管 open 态、
  Content 按 open 门控渲染;Command.Item 在 click 时触发 onSelect)后,**仍测真实
  ModelSelect + ConfigSelect 回调接线**(被审代码),不测 UI 库内部。
- **导出 `ModelSelect`**:原为 `Composer.tsx` 内部函数,加 `export` 关键字(非行为改动)使其
  可单独 mount 测试。与 mermaid review「Reviewer 仅加测试 + 审查记录,不改被审实现行为」
  一致——`export` 不改变任何运行时行为,只是暴露测试入口。

## 验证(本机实跑)

- `cd frontend && bun test` —— **60 pass / 0 fail**(原 57 + 新增 3)。
- `bunx tsc --noEmit` —— 全绿(先 `wails3 generate bindings` 补齐 bindings)。
- `go test ./internal/...` —— 12 packages ok(未改 Go,cached)。
- 复现验证:还原旧硬编码 → 3 用例 FAIL;恢复修复 → 3 用例 PASS。

## 结论

**通过(PASS)**。effort 切换 configId 硬编码修复端到端真实生效:

- 代码逻辑通电(无「签名改了但函数体行为没变」):3 处 `onSetConfig` 真实读取 `ConfigOption.id`
  并透传,数据源是 ACP 协议 `Select.Id`(handler.go:98),完整链路到 `acp.SessionConfigId`。
- 新增 3 用例回归测试把「id ≠ 硬编码字符串」场景固化成 `bun test`,**已证实能复现 bug**
  (还原旧代码即 FAIL),补齐 AGENTS.md §5.3 缺失的测试约束。
- opencode 下行为等价(PROCESS.md:213 实证 id="effort"),修复价值在协议正确性与未来
  harness 适配稳健性(呼应 AGENTS.md §5.3「尊重数据源,转换层不丢弃标识」)。

AGENTS.md 合规:§5.1(mock,未启真 harness)、§5.3(先验证后动手 + 不变量归并 + 回归测试)、
§0.3(worklog)均满足。

## 非阻断性观察(供后续参考,不影响本 PR 通过)

1. 实现侧 worklog 的「运行时验证(起桌面 app 切 effort 看 thought_level 生效)」仍为
   「下一步」——但因 opencode id="effort" 下新旧代码行为等价(PROCESS.md:213),且本 review
   已用 mock 回归测试覆盖「id 透传正确性」,运行时验证非阻断,可后续在桌面 app 上抽检。
2. 实现侧未自行加测试,由本 review 补齐——后续实现侧 fix 应自带复现测试(§5.3 硬约束)。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`:`ModelSelect` 加 `export`(测试入口,非行为改动)。
- 新增 `frontend/src/components/ModelSelect.mount.test.tsx`(3 用例回归测试)。
- 本审查记录:`docs/worklog/2026-07-21-review-effort-config-id.md`(本文件)。

## 验证

见上「验证」段:`bun test`(60 pass)/ `tsc --noEmit` / `go test ./internal/...` / 复现验证。

## 下一步

交回编排层判定 PR #40 合入。
