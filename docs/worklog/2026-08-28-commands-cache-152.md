# 2026-08-28 · slash 命令表持久缓存:0022 commands_cache + handler 直落 + seed 通路(#152)

## 起因

Task #27987(父 issue #27986 四点拍板定版,与 config_options_cache(0011)先例同构):斜杠命令表此前只存在于前端内存(`commandsBySession`),懒 spawn 只读态(重开会话但 harness 未活跃)拿不到 `available_commands_update`,slash 菜单恒空。落地持久缓存:①迁移 0022;②事件整表覆盖写库(含空表);③handler 直落避免双写;④前端仅首次 seed。

## 方案与决策

### 存储层(0022)

- `internal/store/migrations/0022_session_commands_cache.sql`:`sessions` 加 `commands_cache TEXT NOT NULL DEFAULT ''`。**不用 NULL 哨兵**:三态显式——`''` = 从未 seed(harness 还没广告过命令表)、合法 JSON = 已 seed 的命令表、`'[]'` = 已 seed 但零命令(harness 清空是合法状态,不是「无缓存」)。
- **过期策略(完整版注记)**:缓存是 best-effort 快照不是真相源。应用/harness 升级导致命令形态变化时,下一次 spawn 的 `available_commands_update` 全表覆盖旧内容;live session 流式期间没有任何路径读缓存。**无版本戳、无 TTL**——升级失效语义就是「被下一次广告自然覆盖」。
- `Session.CommandsCache string`(json `commandsCache,omitempty`);`sessionColumns` 尾部追加 `commands_cache`,`scanSession` 扫进临时 string 直存(`CommandsCache` 是 raw JSON,**解析不落地在 store 层**——store 不能 import internal/acp(反向依赖,cycle),与 config_options_cache 同构:store 存原文,chat 层解析)。26 列 ↔ 26 scan dest,列数有守护测试。
- `UpdateSessionCommandsCache(ctx, id, cacheJSON)`:**raw 透传写**。空表 `'[]'` 是合法写;`''` 由调用方约定不写(避免混淆「从未 seed」与「seed 过但空」)。**不动 `updated_at`**——与 0011(config cache 直接触碰 updated_at)刻意偏离:命令表广告可能在 turn 中途重发,不是内容活动,touch 会洗侧栏二级排序(对齐 tags 0021/pinned 0008 的理据)。

### handler 直落(写点唯一,前端不参与写)

- `Handler` 新增 `OnCommandsCache func(sessionID string, cmds []SlashCommand)` 字段 + `SetCommandsCache` setter + `emitCommandsCache`——照 `emitGlobalRule`/`SetGlobalRule` 范式:**mu 快照回调指针、锁外调用、recover**(回调跑在 ACP reader goroutine,panic 不得拆连接)。
- `SessionUpdate` 里 `flattenUpdate` 返回 `kind == "available_commands"` 的事件时调用 `emitCommandsCache(e.SessionID, e.Commands)`。**空表照发**(整表替换语义;丢掉空表会让陈旧命令永驻缓存)。flatten 层 `make([]SlashCommand, 0, len)` 保证非 nil——marshal 出 `[]` 而非 `null`。
- **双写消除**:写库只发生在 handler→service 回调这一条链;`handleEvent` 对 `available_commands` 照旧只推前端(不写库),前端 `applyEvent` 只写内存不调 binding。
- `chat.go` 装配(`startLive`):`chat.Handler.SetCommandsCache(func(_ string, cmds) { s.persistCommandsCache(se.ID, cmds) })`——**闭包钉死 DB session id**:handler 发的是 ACP session id,与 onPermission/onElicitation 的 id 对齐同理。这是实现期抓到的关键坑:初版直接传 `s.persistCommandsCache` 会拿 ACP id 当主键 UPDATE,静默零行命中。
- `persistCommandsCache`:marshal → `UpdateSessionCommandsCache`;nil slice 归一为 `[]`(防 `null` 落库);失败只记日志(缓存 best-effort,不影主流程)。**不进 `handleEvent`**(那里写就双写了)。

### 读 binding + 前端 seed(仅首次)

- `ChatService.GetSessionCachedCommands(sessionID) ([]acp.SlashCommand, error)`:与 `GetSessionCachedConfigOptions` 同构——`''`/nil session → `nil, nil`;损坏 → `nil, nil`(下次 spawn 覆盖);`'[]'` → 空非 nil。
- `App.tsx`:`commandsSeededRef`(per-mount Set,照 `configSeededRef`);`openSession` 在 config seed 块后新增 seed 块——**长度>0 才写**,且 `prev[sessionId] ? prev : …` 不覆盖已有直播值;evictSessionCache 同步清 ref(删除/驱逐会话后重开可重新 seed)。`:336` 的 `available_commands` 事件覆盖分支**未动**(活跃事件整表替换内存表,与 seed 互补)。

## 硬测试(任务书四场景全绿)

1. **store JSON 三态往返**(`internal/store/commands_cache_test.go`):`''` 从未 seed → GetSession 读零值;合法 JSON 写→读一致(GetSession + ListSessions 双路径);`'[]'` 空表覆盖 + 后表覆盖前表;updated_at 不动;损坏行(`not json`/`{"a":1}`/`[1,2]`/`null`)store 原文透传不炸读取 + 前置旧行降级;pragma 钉死 TEXT/NOT NULL/DEFAULT '';sessionColumns 列数=26 守护。
2. **handler 回调落库含空表覆盖**:`internal/acp/commands_cache_test.go` 锁 handler 面—— populated 表 flattening 透传、**空表照发且非 nil**、nil 回调安全、回调 panic recovered(SessionUpdate 不返错);`internal/chat/commands_cache_test.go` 锁 service 面(生产回调体)——`persistCommandsCache`→store→`GetSessionCachedCommands` 往返、**空表覆盖后读回空非 nil**、损坏行(经 raw 透传植入)降级 `nil, nil`、updated_at 不动。
3. **mount 重启模拟 seed+仅一次+事件覆盖**(`frontend/src/App.commands-seed.mount.test.tsx`,真 App 组件):popout boot(`#popout=s1`)触发真 `openSession`;①首开 seed 一次 + slash 菜单(slash-popover)渲染缓存表;②`remote:resync`(真实重开路径)重开不重读 DB(seededRef 守卫);③`chat:event` available_commands 整表覆盖内存表(菜单立即换新);④**二次 mount(重启模拟)重新 seed 且 seed 回的是原始缓存**——若前端曾把覆盖表写回后端,mount 2 会 seed 覆盖表;mock holder 恒定 ⇒ 前端不参与写成为可观测事实。
4. **slash 菜单 :478 消费不回归**:既有 `Composer.mount.test.tsx`(slash-item 面板、未知命令拦截 send/enqueue)全数通过;`:478` 派生切片与 ChatView→Composer 透传未改动;上述 App mount 测试即端到端消费证明。

## 验证(门)

- `go build ./...` ✓、`go vet ./...` ✓、`go test ./...` 15 包全 ok(store/acp/chat 新增 8 测试全绿;ld macOS SDK warning 为环境噪声)。
- `bun run test`(仓库门 = `bun test --isolate`):**404 pass / 0 fail**(含新增 App.commands-seed.mount.test.tsx 与既有 Composer/Sidebar/ChatView 全套回归)。
- `bun run build:dev`(tsc + vite)✓ 产 dist 供 go:embed;bindings 经 `go run github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.106 generate bindings` 重生成(与 go.mod 同版;`GetSessionCachedCommands` 方法 + Session model `commandsCache` 字段在位;bindings 目录 gitignore 不入库)。
- **三端矩阵(§4.7)**:后端/binding 面按 §5.6 统一验一次(Go 层真 SQLite + 真 handler 链);前端行为面由真 App 组件 mount 测试覆盖(共享组件,通道无关)。桌面 GUI / 远程浏览器 / PWA 的目检与真机手感**未在本卡执行**(无 GUI 运行时),与仓库 review 流(前端面终审卡)衔接补做;本卡改动为纯增量(新列 + 新 binding + seed 块),`:336` 事件分支与 `:478` 消费未改,回归风险收敛于 seed 块本身(已有专项测试)。

## OPEN / 下一步

- **执行期教训**:本卡在 `internal/acp`/`internal/chat` 测试上先写了带占位的草稿再多次行级修补,数次引入语法损坏后整体重写才收敛——**新写的整文件应一次性 `write` 定稿,不做增量 hunk**(对自产小文件,整体重写比补丁更不易错)。
- bun `mock.module` 的模块命名空间会**急切实体化**(factory 返回的 Proxy 陷阱丢失,动态补 key 无效)——mock 全量 binding 面需静态穷举键;且被 mock 模块的**传递静态导入**需要 resolve-path 形式 + 显式补齐其要求的导出(如 `Clipboard`)。已固化在 App.commands-seed.mount.test.tsx 注释里,后续 App 级测试直接复用该脚手架。
- 真机/三端目检待 review 卡;`GetSessionCachedCommands` 在 popout 快照通路(主窗口→popout)不参与(popout 用主窗口内存快照),符合预期。
- 基线 main=c2788c6;未 push;issue 待人工复核后关闭。
