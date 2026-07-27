# 2026-07-27 添加 harness:ID 自动派生 + 编辑 + 行内复检

## 起因

上一轮把「添加 harness」改成自检门槛 + SQLite(`2026-07-27-add-harness-selfcheck-sqlite.md`),但仍让用户手填 ID/Name/Command 三字段。复核发现:**从使用角度 ID 完全不重要**——它是内部主键(session 钉它、查找用它),用户既看不见它的价值、也不该操心。当前表单暴露 ID 等于把实现细节漏给用户(§4.4)。同时缺少添加后的编辑能力与随时复检。

用户要求三件事:
1. 去掉 ID 字段,后端从命令自动派生(`filepath.Base` 处理路径命令)。
2. 支持改名 / 改命令(编辑已添加的 harness)。
3. 自检按钮常驻每个 harness 行,不只添加时。

## 根因 / 设计

- **ID 派生**:命令首段 token 取 basename → `"junie acp"→"junie"`、`"/usr/local/bin/goose --stdio acp"→"goose"`。向导版 `md/c1b7c453` 的 `harnessCommandID` 只取首段(路径会变整段路径当 id),这里加 `filepath.Base` 修正。Name 改为可选(空则 store 兜底成 id)。
- **ID 不可改**:编辑时保持 id 稳定——session 钉在 id 上,改 id 会断开既有 session 关联。故 `UpdateUserHarness(id, name, command)` 只改 name+command。
- **内置 vs 用户**:编辑只对用户自添加 harness 开放。给 `Harness` 加 `UserDefined bool` 字段(`effectiveSupported` 给用户项置 true),`harness.IsBuiltin(id)` 判内置,前端据此显隐编辑按钮。
- **复检常驻**:`ProbeNewHarness(command)` 已存在且与 harness 实例无关(只吃命令),行内复检直接复用它,结果用共享的 `ProbeReport` 组件就近展示。
- **删除过时校验**:原 `ValidateUserHarness` 强制 name 非空、id 用户给——与新语义(name 可空、id 派生)冲突,且只被 AddHarness 用。删掉它 + 不再用的 `ErrUserIDEmpty/ErrUserNameEmpty/ErrUserIDConflict`,只留 `ErrUserCommandEmpty`。校验逻辑内联进 AddHarness(命令非空 + 派生 id 不撞内置/已有)。

## 改法

**后端:**
- `harness/harness.go`:`Harness` 加 `UserDefined bool`;加 `IsBuiltin(id)`。
- `harness/user.go`:`effectiveSupported` 给用户项 `UserDefined: true`;删 `ValidateUserHarness` + 三个过时哨兵。
- `store/user_harnesses.go`:加 `UpdateUserHarness(id, name, command)`(改 name+command,id 不变;返受影响行数)。
- `chat/chat.go`:
  - 加 `harnessCommandID(command)`(首段 basename)。
  - `AddHarness(command, name)`:派生 id → IsBuiltin/GetUserHarness 冲突校验 → CreateUserHarness → reload + Discover + 异步 probe。(签名从 `(id,name,command)` 改为 `(command,name)`,服务端不重跑 probe)
  - 加 `UpdateUserHarness(id, name, command)` binding:内置拒绝 → 存在性校验 → store.UpdateUserHarness → reload + Discover + 异步 probe。
- 测试:`harness/user_test.go` 删 `TestUserHarnessValidate`;`chat/user_harness_test.go` 全改为新签名 + 加 `TestHarnessCommandID`(basename)、`TestAddHarness_DerivesIDFromPath`、`TestAddHarness_NameOptionalDefaultsToID`、`TestUpdateUserHarness`。

**前端:**
- 新增 `ProbeReport.tsx`:抽共享体检单渲染 + `canAddFromReport` 工具(AddHarnessModal/HarnessRow/EditHarnessModal 三处复用)。
- `AddHarnessModal.tsx`:去掉 ID 字段 → Command(必填)+ Name(可选);调 `AddHarness(command, name)`;用 ProbeReport。
- 新增 `EditHarnessModal.tsx`:Name + Command + 自检 + 体检单 + 保存(调 `UpdateUserHarness`);保存不强制自检通过(改名这种轻量改动不必跑 probe)。
- `HarnessSettings.tsx` HarnessRow:每个 harness 行加「自检」按钮(行内 ProbeReport 复检);用户自添加行加「编辑」按钮 → 开 EditHarnessModal。HarnessPane 加 `editing` 状态。
- i18n(zh/en 同步):加 `editTitle/editDesc/editSave/editBtn/editTip/probeBtn/probeTip`;`index.css` 加 `.harness-row-probe`。
- 重新生成 bindings(`AddHarness(command,name)`、`UpdateUserHarness`、`UserDefined`)。

## 改了哪些文件

- 新增:`frontend/src/components/ProbeReport.tsx`、`frontend/src/components/EditHarnessModal.tsx`
- 改:`internal/harness/harness.go`、`internal/harness/user.go`、`internal/harness/user_test.go`、`internal/store/user_harnesses.go`、`internal/chat/chat.go`、`internal/chat/user_harness_test.go`、`frontend/src/components/AddHarnessModal.tsx`、`frontend/src/components/HarnessSettings.tsx`、`frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`、`frontend/src/index.css`、`README.md`
- 重新生成(不入库):`frontend/bindings/...`

## 验证

- `go build . ./internal/...` 通过;`go test ./...` 全绿(新增 `TestHarnessCommandID`/`TestUpdateUserHarness`/派生 id/name 可空等用例)。
- 前端 `tsc --noEmit` 通过;`bun test` 147 pass / 0 fail(含 i18n locale 同步)。
- ID 派生不变量:`harnessCommandID` 单测覆盖普通名 / 绝对路径(basename)/ 单段 / 空 / 纯空白。

## 下一步 / OPEN

- ~~**派生 id 撞内置**的体验~~(已解决,见下方补丁):改为自动消歧,`omp acp`→`omp-2`,不再报错。
- **删除闭环**仍未接 UI:`store.DeleteUserHarness` 已具备,编辑弹窗可顺带加删除按钮(按需)。
- **复检的 token 成本**:行内自检同样会发一轮真实 Prompt,与添加时自检同代价;属用户主动诊断,可接受。

## 补丁(同日):id 冲突自动消歧

**起因**:上条 OPEN —— 派生 id 从命令首段 basename 来,撞内置(omp/opencode)或已有用户 harness 时原报错。这对 `omp acp --profile X` 这种**命令不同但首段相同**的合法变体是误伤(用户根本看不见 id,却被迫改命令)。复杂度评估后确认改动极小,直接做。

**改法**:`AddHarness` 派生 id 后,新增 `resolveHarnessID(derived)` —— 依次试 `derived`、`derived-2`、`derived-3`…,跳过 IsBuiltin + GetUserHarness 命中,返回首个空位。原"撞内置报错""撞已有报错"两段删除,换成一次 resolve 调用。上限 99 纯防御(实际撞 2-3 次)。name 兜底由 store 按最终 id 处理(`omp-2` 空 name → name=`omp-2`,够区分,可用编辑功能改)。

**为何零波及**:`Command(id)`/`Normalize(id)`/进程回收全按库里 id / command 首段走,不假设 id==命令首段,故改动完全收敛在 AddHarness 派生那一步。前端、binding 签名都不变。

**改了哪些文件**:`internal/chat/chat.go`(AddHarness + 新 `resolveHarnessID`)、`internal/chat/user_harness_test.go`(冲突用例改消歧用例,删不再用的 strings 导入)。

**验证**:`go test ./internal/chat/` 通过(新增 `TestAddHarness_DisambiguatesBuiltinConflict` —— `omp acp`→`omp-2`、`opencode acp`→`opencode-2`;`TestAddHarness_DisambiguatesExistingConflict` —— 同命令第二次→`junie-2`)。

**新 OPEN**:消歧后**完全相同的命令**也能加成第二条(`omp acp` → `omp-2`,与内置 omp 命令一样)。无害(id 不同、列表里能看到两条),但属于无意义重复;未做"命令完全重复才拒绝"的特判(KISS,且删除 UI 尚未接,用户可自纠)。
