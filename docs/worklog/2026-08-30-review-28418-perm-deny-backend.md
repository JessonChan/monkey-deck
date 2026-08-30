# 2026-08-30 review #28418 权限超时 deny 归一+装配接线(后端面,0710caf)——CHANGES REQUESTED

## 起因

后端审卡(Task #28420):审 #28418 后端面 commit 0710caf,基线 main=35dbf6b,父 issue
#28417 规格五点反向实证(前端面已由 fe-review APPROVE,本卡不越界)。审法:从字段/常量
定义点沿每个调用点追到真实消费端,不顺 commit 叙事;测试断言逐个核锚定值。

## 结论:**CHANGES REQUESTED**(1 × P2,1 × P3;语义矩阵/默认锁定/持久化边界全部实证通过)

## 五点规格反向实证

**① 语义矩阵全链** ✅(空串归一 deny 与显式 allow 两个负向实验均成立)
- `normalizePermTimeoutPolicy`(chat.go:3703-3708):`case "allow"` 之外**一切输入**
  (含 `""`/大小写/空白/junk)落 `"deny"`——default 分支即兜底,方向 fail-closed。
- `permissionTimeoutPolicySetting`(chat.go:3713-3716):`GetSetting` 对缺键返回
  `("", nil)`(messages.go:218-224,`sql.ErrNoRows` → `"", nil` 实证)→ 归一 deny。
  **存量用户(设置未配置)翻 deny 的保证在此**:读侧锚定测试
  `TestPermissionTimeoutPolicySetting` 首块(新库即 deny)+ 归一表 `""→deny`
  (perm_timeout_policy_test.go:82)两端夹住。
- 装配(chat.go:1686):`SetPermissionRecovery(acp.DefaultPermRetries,
  s.permissionTimeoutPolicySetting())` ——传的恰是归一函数产出,非原始设置值。
- handler 侧消费:RequestPermission 预算耗尽 `timeoutPolicyAllow(h.permTimeoutPolicy)`
  (handler.go:493):deny → `pickRejectOption` 取 reject 选项,无则 cancelled
  (:501-510);allow → `defaultOption` 放行(:494-498)。
- 显式 allow 仍放行:`Set("allow")→Get("allow")` 锚定(:31-36)+ handler 侧
  `TestPermissionTimeoutDegradeAllow`(SetPermissionRecovery(0,"allow") → 放行)✅。
- 「类型补丁」反向追踪:新字段全链通电——`Get/SetPermissionTimeoutPolicy` 被前端
  PermissionSettings.tsx:58/:50 消费;`DefaultPermRetries` 被 NewHandler(:325)、
  chat 装配(:1686)、测试锚定(:216)三处消费;settings 值经装配进 handler 并在
  :440(retries)/:493(policy)真实读出。无「字段存在但无人读」断链。

**② SetPermissionRecovery 文档-实现偏差** → **P3(文档硬化)**
- 文档(handler.go:331)称「timeoutPolicy 为 "allow"/"deny"(空串保留默认)」,实现
  (:338)verbatim 存储 `h.permTimeoutPolicy = timeoutPolicy`。空串实际行为 =
  `timeoutPolicyAllow("")` → **allow**,而出厂默认已翻 **deny**——「保留默认」已失实
  (改动前 default="allow" 时空串恰等于默认,翻转后注释未同步)。
- 全仓调用方核实(grep 全量):生产唯一 caller chat.go:1686 传归一值(永非空串);
  测试 7 处全部显式传 "allow"/"deny"(handler_global_test.go:31/145/192,
  handler_recovery_test.go:62/98/126/158/228)。**无任何 caller 传空串** → 偏差不可达,
  判 P3 文档硬化而非行为 bug。
- 判级依据:①不可达(归一层保证);②零值=allow 是有意设计且在字段注释
  (handler.go:245-246)与常量注释(:295)两处如实记载,仅 setter 一处注释过期;
  ③但注意失败方向是 fail-**open**(未来 caller 直传空串会得到放行)——修法建议改注释为
  「空串/未知视作 allow(与零值语义一致);chat 装配层负责归一」,不动行为。

**③ 默认锁定与装配测试面** ✅(真覆盖,非管道自证;断言全部锚定值)
- `TestPermissionTimeoutDefaultsToDeny`(handler_recovery_test.go:194-218):**不调**
  SetPermissionRecovery,走 NewHandler 出厂态,断言锚定值 `Selected.OptionId=="deny"`
  (reject 选项字面 id)+ `dispatches == DefaultPermRetries+1`——锁的是行为不是字段存在。
- `TestPermissionWiredDefaultsDeny`(:224-250):按 chat.startLive 实际调用形态
  `SetPermissionRecovery(DefaultPermRetries, "deny")`,锚定 `OptionId=="deny"` +
  字面 `2` 次分发(:247)。
- chat 侧 `TestPermissionTimeoutPolicySetting`:真实 store(t.TempDir)、**关库重开同
  一 db 文件**模拟重启(:39-49)锚定 "allow" 持久;junk 入库归一 deny(:55-60);
  nil store 读 deny/写报错(:63-68)。`WiringShape` 归一表含 `""→deny`/junk→deny。
- 装配链唯一未测 token:startLive 内那一行字面调用(需活 ACP 连接,成本不成比例);
  其两端(读侧归一链 + handler 入参形态)均被上述测试夹住,判定可接受,记观察项。

**④ permRetries 既有默认不回归** ✅
- `defaultPermRetries=1` → 导出 `DefaultPermRetries = 1`(handler.go:292),值不变;
  NewHandler(:325)与 RequestPermission 双处 `<0→0` 钳制(:334-336、:440-443)保持。
- 旧行为(1 次重发、共 2 轮)由 `dispatches==DefaultPermRetries+1` 与字面 `2` 双测试
  锁定。全仓无残留 `defaultPermRetries` 引用(grep 实证,干净 cutover)。

**⑤ 持久化通路 + 活跃 session 不热更边界** ✅
- 持久化:settings KV `permission_timeout_policy`(chat.go:3700),Set 走
  `SetSetting`(UPSERT,messages.go:228-233),重启保持由关库重开测试实证。
- 不热更:grep 全仓 SetPermissionRecovery 调用点——生产仅 chat.go:1686(startLive
  装配期)一处,无任何运行时重注入路径;注释(chat.go:3696-3698/3727-3728)与实现
  一致,与 issue 规格「重启后策略生效」一致。重连场景(startReconnect→startLive)会
  重读设置,属「新会话生效」语义,不越界。
- bindings:`frontend/bindings/` gitignored(.gitignore:39-40,中间产物不入库);
  本机重新生成成功,生成文件含 `GetPermissionTimeoutPolicy`/`SetPermissionTimeoutPolicy`
  (与 fe-review 结论一致),装配通路完整。

## P2(阻塞项):SetPermissionRecovery 裸写 + 装配注释「mu 对齐写」失实

- chat.go:1684-1685 注释声称「Setter 装配形式,与上方 SetGlobalRule 同理(ACP reader
  goroutine 已启动,**mu 对齐写**)」——但 `SetPermissionRecovery`(handler.go:333-339)
  **是全仓唯一不加 mu 的 setter**:sibling 五个全部受保护——`SetGlobalRule`(:617-621)、
  `SetElicitationResolved`(:165-169)、`SetElicitationUnrenderable`(:174-178)、
  `SetCommandsCache`(:651-655)均 `h.mu.Lock()`,`SetProjectAllowExternal`(:659-661)/
  `SetPermissionRules`(:665-668)走 atomic。
- 读侧(handler.go:440 `h.permRetries`、:493 `h.permTimeoutPolicy`)在 ACP reader
  goroutine 上裸读,与 setter 写之间无任何 Go 内存模型 happens-before 边(时序上
  startLive 先于 Prompt、无真并发窗口,故现网不可见;但 formal data race 成立)。
- **仓库自留的 OPEN 条件已触发**:docs/worklog/2026-08-06-elicitation-callback-data-race.md
  :70-73 明确记录该裸写模式「目前无生产 caller……等它接 DB/设置 UI」——0710caf 恰是
  接 DB/设置 UI 这一 commit,兑现条件成立。
- 修法(3 行):setter 内 `h.mu.Lock()/Unlock()` 包住两行赋值(对齐全部 sibling);
  chat.go:1685 注释即自动为真。不改任何行为语义。

## P3(不阻塞,建议顺手)

- handler.go:331 setter 文档「空串保留默认」失实(详见②),随 P2 同函数顺手修正注释。

## 独立重跑 gate(本机全新跑,非复述)

- 前置:新 worktree 无 `frontend/dist`(gitignored)→ `bun install` + `wails3 generate
  bindings -clean=true -ts -i`(297 packages/128 methods,生成含两新方法)+ `bun run
  build`(tsc+vite ✅)补齐 embed 产物——均为构建前置,非代码问题。
- `go build ./...` ✅;`go vet ./...` ✅(ld "newer macOS version" warning 为环境级
  SDK 噪音,与改动无关)。
- `go test ./...` ✅ **15/15 包全 ok**(acp 3.29s、chat 22.85s、store 3.58s 等,0 fail)。
- 定向 verbose:`TestPermissionTimeoutDegradeDeny` / `DegradeDenyNoRejectOption` /
  `DefaultsToDeny` / `WiredDefaultsDeny` 4/4 PASS(0.20-0.40s each)。

## 三端说明(§4.7)

纯后端改动(Go handler/service/settings KV):后端能力在 server 形态统一实证一次
(go test 全绿 = 真实 SQLite 通路);前端消费面(bindings 调用)已由 fe-review 卡
APPROVE,本卡仅反向核实消费点存在(PermissionSettings.tsx:50/:58),未触碰前端代码。

## 验证

- 五点逐条反向实证(见上),gate 独立重跑全绿(15/15 包 + 4 定向 PASS)。
- 本 worklog 单独 commit(docs 与代码分离,§6.2);不 push,不关 issue,停 completed-ready。

## 下一步 / OPEN

- **P2**:SetPermissionRecovery 补 `h.mu`(3 行),chat.go:1685 注释随之成立——留给
  代码侧返工 task,不在本审卡扩范围。
- **P3**:handler.go:331 注释改为如实描述(空串=allow 零值语义,装配层负责归一)。
- 观察:装配链 startLive 字面一行无直接测试(两端已夹),如后续改多行装配形态再议。
