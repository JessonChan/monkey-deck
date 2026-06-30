# 2026-06-30 新建会话即显示 model 选择:冷缓存时预热 spawn(keep alive)+ 缓存

## 起因

用户反馈:**打开一个新对话时,除非发了消息,否则输入框里没有当前 harness 的 model 选择工具**。

## 根因

model/mode/effort 下拉的数据源是 agent 自报的 `configOptions`,而 `configOptions` 只在
**`NewSession` 响应**里返回(§5.4 #14)。懒启动(§5.4 #9)使 harness 只在**首条消息**时才
spawn + NewSession → `startLive` 才 emit `config_option` → 前端 `configOptionsBySession` 为空 →
`ModelSelect` 的 `if(!modelOpt)return null` 不渲染。

## 设计:冷缓存预热 spawn(keep alive)+ 按 `harness|project` 缓存

用户拍板方向:**当前 harness 完全没有缓存的 model 时,不要 lazy,直接 spawn、拿到 configOptions、
保持连接活着等用户消息**(而非 probe-and-close)。首条消息复用连接,免再 spawn。

**源码研读结论(opencode)**:`references/opencode/.../cli/cmd/acp.ts` 的 `acp` 命令只
`process.stdin.on("end")` 等客户端关 stdin,**并不主动空闲断连**。故 §5.4 #9 的"~1s 断连"并非
opencode 自关 stdio(更可能是其内部 HTTP server / SDK 层),warm(keep alive)在 opencode 上安全;
`IsAlive()` 进程探活作为兜底保险(进程真死了就拆掉重 spawn,不把 broken pipe 抛给用户)。

具体:
- **model 列表是 harness 全局属性**(不随 session 变)。每个「项目×harness」冷缓存首次时
  `maybeWarmSession` 异步 `ensureLive`→`startLive`(spawn + NewSession,keep alive、注册 active、
  持久化 ACP id),`startLive` 本就 emit `config_option` → 下拉立即可见;随后把 model 列表缓存进
  `cfgCache`,同项目后续会话**直接用缓存即时展示、免 spawn**(走 `emitSessionConfig` 推 model-only、
  首条消息再 lazy spawn)。
- **`ensureLive` 加活性守卫 + spawn 串行化**:活跃 session 若 `ls.chat.IsAlive()` 为假(进程已退出,
  空闲断连/崩溃)→ 先 `teardownLive` 再 spawn(LoadSession resume),用户无感;spawn 段持 `spawnMu`
  串行化,杜绝「预热 goroutine 与首条消息并发各 spawn 一个 harness」(二者都不持 sendMu)。
- **未活跃(首条消息前)只展示 model 项**(`buildSessionConfig` 过滤 category==model,
  currentValue=se.Model):mode/effort 是运行时热切项,首条消息前改不生效(NewSession 时才定),
  展示即假交互;session 活跃后 `startLive` 推完整 live configOptions 覆盖,mode/effort 自然出现。
- **未活跃改 model = 写 DB**(`store.UpdateSessionModel`,首条消息 NewSession 钉死),**不 spawn**;
  `SetSessionConfigOption` 双模(活跃→`set_config_option` 热切;未活跃→仅 model 写 DB)。

## 改法

- **`internal/acp/runner.go`**:加 `syscall` import + `ChatSession.IsAlive()`(`Process.Signal(0)`
  探活,Unix 标准:进程在返 nil、已退出返 ESRCH)。**移除**上一版 probe 方案的 `ProbeConfigOptions`。
- **`internal/store/sessions.go`**:`UpdateSessionModel`(首条消息前在 selector 改 model 时写库)。
- **`internal/chat/chat.go`**:
  - `ChatService` 加 `spawnMu sync.Mutex` + `cfgCache`/`cfgProbing`(预热缓存/标记)。
  - `chatConn` 接口加 `IsAlive() bool`。
  - `ensureLive` 重写:活性守卫(IsAlive→死则 teardown)+ spawn 段持 spawnMu(重检 active 防双 spawn)。
  - `maybeWarmSession`(替代 probe):冷缓存异步 `ensureLive` 拿到 live configOptions → 缓存 model 列表
    + `emitCachedConfigForProject` 推给该项目同 harness 的所有未活跃 session。
  - `buildSessionConfig`/`emitSessionConfig`/`emitCachedConfigForProject`(缓存派生,unchanged)。
  - `CreateSession`/`OpenSession`:缓存热→`emitSessionConfig`(model-only、lazy);缓存冷→`maybeWarmSession`。
  - `SetSessionConfigOption` 双模(活跃热切 / 未活跃 model 写 DB),`GetSessionConfigOptions` 未活跃返缓存。
- **测试**:`internal/chat/config_select_test.go`(原 config_probe_test.go,改名)灌 `cfgCache` 测缓存派生
  逻辑(不启真 harness):`buildSessionConfig` model-only/cold-nil、`SetSessionConfigOption` 未活跃写 DB
  model/忽略 mode;`queue_test.go` 的 `fakeChat` 补 `IsAlive()→true`。

无 Go 导出签名变更 → **无需 `wails3 gen bindings`**;前端零改动(`ModelSelect` 本就按 `configOptions`
渲染、`disabled={!session}` 新会话下为 false)。

## 改了哪些文件

`internal/acp/runner.go`、`internal/store/sessions.go`、`internal/chat/chat.go`、
`internal/chat/config_select_test.go`(新,原 config_probe_test.go 改名)、
`internal/chat/queue_test.go`、`AGENTS.md`(§5.4 #19)、本 worklog。

## 验证

- `go build . ./internal/...` ✅;`go test ./internal/... -race` ✅(9 packages);
  `go vet` 干净;`gofmt -l` 干净。
- `config_select_test.go` 4 例 ✅(model-only/cold-nil/pre-live-writes-model/ignores-non-model)。
- 前端 `tsc --noEmit` ✅(未改动)。
- **未做实机验证**(待 `wails3 dev`):① 新建会话后 model 下拉是否在预热完成后(~1-2s,首次)
  立即出现;② 同项目第二条会话是否即时(缓存命中);③ 首条消息是否复用 warm 连接(快);
  ④ warm 后若迟迟不发消息、harness 真死了,首条消息是否无感重 spawn(不报 broken pipe);
  ⑤ warm 的 `startLive` 推 `"started"` 状态对空闲 warm session 的 UI 显示是否正常(待观察)。

## 下一步 / 可改进

- 实机验证上述五点。
- §5.4 #9 的"~1s 断连"根因尚未彻底定位(opencode 内部 HTTP server / `@agentclientprotocol/sdk`
  层);若实机发现 warm 后频繁被断,需进一步读 opencode server shutdown / SDK 心跳逻辑。
- omp(默认 harness,Rust)的 stdio ACP 空闲行为未单独验证(默认用它);若 omp 行为不同需补。
- 缓存为内存态,重启后首个新会话仍需一次预热(可落 settings 持久化免探测)。
