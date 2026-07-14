# 2026-07-14 懒 spawn 会话切换模型触发 spawn + 缓存 configOptions 展示

## 起因

Task #15148。懒 spawn(见 `2026-07-14-lazy-spawn-harness.md`)落地后,历史会话只读打开时
不 spawn harness,导致两个体验退化:
1. **只读态模型选择器消失**:`configOptions` 全靠 spawn 后 harness 自报推 `config_option`
   event 填充;只读态没 spawn → `configOptions` 空 → `ModelSelect` `return null`(消失)。
2. **只读态切换模型落空**:`SetSessionConfigOption` 原本要求 session 已活跃,只读态直接报错
   `session not active`,用户选了模型但 harness 没跑、没生效。

## 设计

三条互补,语义统一为「切换模型 = 先 spawn 再应用配置」,与「发消息触发 spawn」一致:

1. **缓存展示**:把 spawn / `config_option_update` / `set_config_option` / refresh config 时
   agent 自报的 `configOptions`(model/mode/effort)持久化到 session store(`config_options_cache`
   列),只读态打开时用缓存渲染 `ModelSelect`(不再 `return null`)。无缓存(空会话 / 从未 spawn)
   仍走空(等 spawn 推送)。
2. **动作及时响应**:只读态下用户切换 config option 视为「继续会话」触发 spawn;spawn 完成后
   应用用户选的配置(`SetConfigOption` 在 spawn 后调用)。已活跃则直接热切(原行为)。
3. **语义统一**:`SetSessionConfigOption` 与 `SendMessage` 共用 `ensureLive`(spawnMu 串行化,
   不双 spawn),「切换 = 先 spawn 再应用」与「发消息触发 spawn」路径一致。

## 改法

### 后端

- `internal/store/migrations/0011_session_config_options_cache.sql`(新):`sessions` 加
  `config_options_cache TEXT NOT NULL DEFAULT ''`。
- `internal/store/store.go`:`Session` 加 `ConfigOptionsCache` 字段。
- `internal/store/sessions.go`:
  - `sessionColumns` / `scanSession` 补 `config_options_cache`(统一列与扫描,防漂移)。
  - 新增 `UpdateSessionConfigOptionsCache`(回写 cacheJSON)。
- `internal/chat/chat.go`:
  - 新增 `persistConfigCache(sessionID, opts)`:序列化 `[]acp.ConfigOption` 写库(空切片不写,
    避免清空有效缓存;写失败只记日志)。
  - `startLive`:spawn 完成推送 `config_option` event 后 `persistConfigCache`(冷启动落盘)。
  - `handleEvent`:`config_option` 事件 `persistConfigCache`(agent 主动推的最新全量)。
  - `SetSessionConfigOption`:只读态(ls==nil)走 `ensureLive` spawn,spawn 后再 `SetConfigOption`
    + 推 event + `persistConfigCache`(语义统一:切换 = 先 spawn 再应用)。
  - 新增 `GetSessionCachedConfigOptions`:读持久化快照,无缓存/损坏返回 `nil, nil`(前端据此决定
    是否渲染 `ModelSelect`)。
  - `RefreshSessionConfig`:probe 拉到最新后 `persistConfigCache`(刷新也落盘)。
- `internal/chat/lazy_spawn_test.go`:补 `TestSetConfigOptionOnReadOnlyTriggersSpawn`
  (只读态切换 → spawn 一次 + `SetConfigOption` 被调一次,记录 `model=provider/foo`),
  更新文件头注释列表(第 7 条不变量)。
- `internal/chat/queue_test.go`:`fakeChat.SetConfigOption` 记录调用(`configSets []string`,
  `"configId=value"`),供新测试断言「spawn 后应用配置」。

### 前端

- `frontend/src/App.tsx`:
  - 新增 `configSeededRef`(Set):懒 spawn 只读态用持久化缓存渲染 `ModelSelect`,仅首次打开 seed
    (活跃 session 的 `config_option` event 会覆盖;切走再切回不重读 DB,保留内存直播值)。
  - `openSession`:首次打开调 `GetSessionCachedConfigOptions`,归一化(`options ?? []`,
    bindings 的 `ConfigOption.options` 是 `[] | null` —— Go nil slice → JSON null,本地
    `types.ts` 是非空数组,渲染层假设非空)后 seed 进 `configOptionsBySession`。
  - `removeSession`:`configSeededRef.current.delete(sessionId)` 随删清。

Go 导出方法签名有变更(新增 `GetSessionCachedConfigOptions`)→ `wails3 task build` 自动重生成
前端 bindings(bindings 不入库,dev/build 时重生成)。

## 改了哪些文件

后端:
- `internal/store/migrations/0011_session_config_options_cache.sql`(新)
- `internal/store/store.go`
- `internal/store/sessions.go`
- `internal/chat/chat.go`
- `internal/chat/lazy_spawn_test.go`
- `internal/chat/queue_test.go`

前端:
- `frontend/src/App.tsx`

(bindings 自动重生,不入库)

## 验证

- `go build ./...` ✅(仅 macOS SDK linker warning,非错误)
- `go vet ./...` ✅ 干净
- `go test ./...` ✅ 全绿(含 7 条懒 spawn 单测,新增 `TestSetConfigOptionOnReadOnlyTriggersSpawn`)
- `wails3 task build` ✅ 零 TS 错误(bindings 重生 + tsc + vite + go build 全过)
- `git status`:无 AGENTS.md / RAK 运行时文件 / dist / bindings / node_modules 入库

## 设计权衡 / 已知限制

- **缓存可能过期**:用户在 harness 配置外部改了 provider/model 后,只读态的缓存仍是旧的。
  但用户一旦切换(触发 spawn)或点「刷新」(`RefreshSessionConfig` probe harness)就会拿到最新;
  只读浏览历史时看到旧选项无实质危害(切换即 spawn 即刷新)。
- **options null 归一化在边界做**:`types.ts` 的 `ConfigOption.options` 保持非空(渲染层假设非空,
  改 nullable 会波及 `Composer.tsx` 的 `ConfigSelect`),在 DB-read 边界 `?? []` 归一化。
  与 event 路径一致(runtime 数据是 JSON,TS 不校验;只有显式调 binding 方法才暴露类型差异)。

## 下一步

- 实机验证(`wails3 dev`):打开历史会话应见模型选择器(缓存渲染);只读态切换模型应触发 spawn
  且切换生效;spawn 后再切回该会话(已活跃)应直接热切。
