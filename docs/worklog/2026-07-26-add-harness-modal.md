# 2026-07-26 添加 harness 弹窗:AddHarness 后端 + 用户 harness 持久化 + HarnessSettings modal

## 起因

Task #23417,issue 最后一块。Task #23414/#23415/#23416 已落地 CapabilityMatrix 后端探测 + 模型选择位
+ 透出前端 + HarnessSettings 能力矩阵列 + NewSessionModal 摘要。issue DoD 还差「添加 harness 的 UI」:
用户要加 junie/jcode/goose/kimi 这类新 harness,没弹窗、后端只认静态 omp/opencode。本 task 收尾。

## 设计

### 持久化位置

用户 harness 存到 `<config.DataDir>/harnesses.json`(跨平台 DataDir,见 config paths_*.go:
macOS=`~/Library/Application Support/Monkey Deck`、Linux=`~/.local/share/monkey-deck`、
Win=`%LOCALAPPDATA%\Monkey Deck`)。**不硬编码 `~/.monkey-deck`**(§5.3)。

结构 `[]{id,name,command,icon}`(纯静态元数据;运行时安装路径/版本/能力由 Discover/probe 统一填,
不在文件里存)。JSON 文件而非新 DB 表/migration —— 用户 harness 是少量元数据,JSON 够用且 KISS。
原子写(tmp + rename)防中途崩溃;父目录自动建。文件不存在 = 空列表 + 无错(开箱即用);损坏 = 报错
(不静默吞)。

### 合并去重策略(单一事实源不动)

**不修改静态 `Supported`/`Registry` 源码**,只做内存合并视图:

- `effectiveSupported()`:静态 `Supported` + 用户列表,按 ID 去重,**静态优先**(同 ID 用户项丢弃,
  不让用户覆盖内置 omp/opencode);用户追加在静态之后,顺序稳定。
- `effectiveRegistry()`:静态 `Registry` + 用户 Spec(只填 `BinaryName = command 首段`,
  无 Source/Upgrader —— 用户 harness 不查上游、不升级,只做 spawn + 本地版本检测 + 能力探测)。
- 用 `atomic.Pointer[[]UserHarness]` 持有当前用户列表,并发安全(AddHarness 写、Discover 读并行)。

`Discover` / `Command` / `Normalize` / `Commands` 全部改读 `effectiveSupported`/`effectiveRegistry`,
使新加的 harness 立即被识别(session 不掉、进程回收认得、Discover 发现它)。`specByID`(Upgrade 用)
仍读静态 `Registry` —— 用户 harness 不在静态里 → `Upgrade` 返 `ErrUpgraderNotConfigured`,符合预期
(用户 harness 不升级)。

### 启动加载 + AddHarness 触发链

- 启动:`loadPersistedConfig`(chat.go)读 `harnesses.json` → `SetUserHarnesses`。必须在
  `acp.SetHarnessCommands(harness.Commands())`(ServiceStartup 后续行)之前完成,使进程回收层一并
  认得用户 harness。
- `AddHarness(id,name,command,icon)`(ChatService 导出方法,Wails3 binding):
  1. 加载现有用户列表(文件不存在 = 空)。
  2. `ValidateUserHarness` 校验:ID/Name/Command 非空 + ID 不与静态或已有用户冲突。返 `ErrUser*`
     哨兵错误。
  3. 追加 + 原子写文件。
  4. `SetUserHarnesses` 刷内存合并视图。
  5. `acp.SetHarnessCommands(harness.Commands())` 刷新进程回收白名单(§3.2:启动注入一次,
     加新 harness 后必须补,否则回收层不认新命令)。
  6. `Discover` 刷新 Path/Installed → 缓存 + 推 `EventHarnesses`。
  7. **显式 `go probeCapabilitiesAsync()`**(关键核查点,见下)。
  返回更新后的全量 `[]Harness`,前端据此刷新。

### probe 触发是否需显式调用 —— 需要显式

`refreshHarnessesThenMaybeAutoUpgrade` 的 probe hook **只在启动跑一次**(`probeCapabilitiesAsync`
挂在它里面)。`RefreshHarnesses`(用户点刷新)**不**触发 probe,`AddHarness` 也不经过该 hook。
故 `AddHarness` 末尾必须显式 `go s.probeCapabilitiesAsync()`,否则新加的 harness 能力矩阵永远
是「检测中」。已确认并显式调用。

### modal 关闭时机取舍

issue 倾向「提交后在 modal 内显示能力清单再关」。**coder 选「提交成功即关」**(KISS + 友好):

- probe 能力矩阵最多 30s(`probeCapTimeout`),让 modal 一直开着等 probe 不友好。
- HarnessPane 已订阅 `chat:harness-capabilities` 自动 `reloadCaps`(Task #23416 已做),
  新 harness 行的能力 chip 会在 probe 完成后**自动填进列表里**——与启动时「harness 列表先到、
  能力矩阵随后填」体验一致,无需 modal 等待。

### 校验分工

- 前端先做基础校验(i18n 即时反馈):非空 + ID 冲突(对当前 `list` 含静态+用户查重)+ 提交按钮
  disabled 态。
- 后端兜底校验(`AddHarness` 返 `ErrUser*` 错误串),极端情况(并发加同 ID)显示在 modal-del-err。

### i18n

zh.json + en.json 各补 16 个 key(`addBtn/addBtnTip/addTitle/addDesc/addIdLabel/.../addConfirm/
addErrIdEmpty/addErrIdConflict/addErrNameEmpty/addErrCmdEmpty`),§4.4 人话(不裸露技术格式,
命令格式用例子说明)。

## 改了哪些文件

**后端(新)**:
- `internal/harness/user.go`:`UserHarness` 结构 + `LoadUserHarnesses`/`SaveUserHarnesses`(原子写)
  + `ValidateUserHarness` + `effectiveSupported`/`effectiveRegistry` 合并 + `SetUserHarnesses`/
  `UserHarnesses`(atomic.Pointer)。
- `internal/harness/user_test.go`:校验 10 例 + 加载(缺失/空/损坏)+ 合并去重(Supported/Registry)
  + Discover 含用户 harness + Commands/Normalize 识别用户 harness。
- `internal/chat/user_harness_test.go`:AddHarness 成功/冲突(静态×2 + 已加用户)/校验×3/
  loadPersistedConfig 加载(预置文件 / 文件缺失)。

**后端(改)**:
- `internal/harness/harness.go`:`Normalize`/`Command`/`Commands` 改读 `effectiveSupported`。
- `internal/harness/discover.go`:`Discover` 改读 `effectiveSupported`/`effectiveRegistry`
  (合并视图,纯函数不变;goroutine 闭包捕获局部 `reg` 切片避免读全局)。
- `internal/chat/chat.go`:`AddHarness` 方法 + `loadPersistedConfig` 加载用户 harness。

**前端(新)**:
- `frontend/src/components/AddHarnessModal.tsx`:modal 表单(ID/Name/Command 必填 + Icon 可选),
  复用 modal-overlay/modal-card/modal-input/modal-del-err 范式(参照 FilePanel 输入 modal),
  Esc 关闭 + Enter 提交 + 前端校验。

**前端(改)**:
- `frontend/src/components/HarnessSettings.tsx`:pane-head 加「添加 harness」按钮
  (`data-testid=add-harness-btn`,Plus 图标)+ pane-head-acts 容器 + mounting AddHarnessModal
  (自管 `adding` state,onDone 刷 list + 关 modal)。
- `frontend/src/i18n/locales/{zh,en}.json`:补 add harness 相关 key。
- `frontend/src/index.css`:`.pane-head-acts` + `.add-harness-card`/`.ah-field`/`.ah-label`/
  `.ah-required`/`.ah-hint`/`.ah-desc` 样式。

## 验证

- `go build ./internal/...` / `go vet ./internal/...`:clean(仅 pre-existing macOS 链接器版本警告)。
- `go test ./internal/harness/ ./internal/chat/`:全绿(新 harness 测试 17 例 + chat AddHarness 6 例全过,
  旧测试无回归)。
- `npm run build`(tsc + vite):零 TS 错误。
- `bun test --isolate`:130 pass / 0 fail(无回归)。
- `wails3 task build`:全过(gen bindings 含 AddHarness + 前端 build + Go production build,产出
  bin/monkey-deck)。
- 不回归:静态 omp/opencode 的发现/升级/选择/能力矩阵/发消息 路径未改;用户 harness 无 Source/Upgrader,
  `UpgradeAvailable` 恒 false,UI 不显升级按钮(`specByID` 仍读静态 → 用户 harness 升级返
  `ErrUpgraderNotConfigured`)。

## 下一步

- `RemoveUserHarness(id)` 删除用户 harness(静态不可删):本 task 按 KISS 仅做 Add,删除闭环留
  follow-up(用户加错了可手改 `harnesses.json` 兜底)。
- 用户 harness 的 Icon 渲染:当前 HarnessIcon 对未知 icon 字符串走 lucide Bot 兜底;若需支持
  用户提供本地图片路径/URL,后续在 HarnessIcon 加资源解析。
