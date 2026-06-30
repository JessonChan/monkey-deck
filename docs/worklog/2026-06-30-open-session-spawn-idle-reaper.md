# 2026-06-30 B 方案:OpenSession 异步 spawn + idle reaper 回收(替换预热方案)

## 起因

上一版「冷缓存预热 spawn + cfgCache + DB 兜底」方案(见
`2026-06-30-model-selector-on-create.md`)虽然能让历史/新会话的 model 下拉显示,
但有几处体验/复杂度问题:

1. **打开历史 session 仍有 ~1-2s 空窗**:cfgCache 冷时 `maybeWarmSession` 后台
   spawn,完成前下拉要么不渲染(旧版)、要么靠 DB 单选项灰色占位(中途加的 DB 兜底)。
2. **mode/effort 首条消息前永远不显示**:`buildSessionConfig` 只返回 model 项
   (mode/effort 视为运行时热切项),用户体验上「打开对话界面太素」。
3. **整套 cfgCache / maybeWarmSession / buildSessionConfig / DB 兜底逻辑复杂**:
   冷/热缓存两套路径、前端还要 `isStaticFallback` 双模渲染,维护成本高。

用户实测后发现:**ACP 其实自带完整 model 列表**(诊断脚本验证,NewSession 响应
直接返回 48 个 model + mode 项),DB 兜底属于「不必要」—— 真问题是「session 没活
就拿不到 config_option」,而非「ACP 没数据」。

## 根因(诊断实证)

独立诊断程序(`acp.NewRunner(model="").NewChatSession(/tmp/diag-wt)`,空 model 不
显式注入,只看 opencode 默认)抓 `NewSession` 响应:

```
FlatConfigOptions count: 2
  [0] category=model currentValue=zai-coding-plan/glm-5.1 options=[48 个 model]
  [1] category=mode  currentValue=build             options=[build/plan]
```

**结论:ACP 始终返回完整 configOptions。** 历史打开时下拉消失/不全,不是 ACP 没给,
是**当前设计下 session 是 ACP-idle**(lazy spawn,没连接就拿不到),前端只能靠 cfgCache
/ DB 兜底拼凑,首条消息前永远拿不到 mode/effort。

## 设计:B 方案(session 一打开就 spawn + idle reaper 回收)

用户拍板:**OpenSession 即 spawn,idle 5min 再关,新建也走这条**。

核心思路 —— **让 session 始终真活**,永远有真 configOptions,删掉所有兜底/缓存:

- **`OpenSession` 异步 spawn**:`go ensureLive`(spawn + NewSession/LoadSession),
  立即返回不阻塞前端加载历史(历史从 DB 读,独立于 harness)。spawn 完 `startLive`
  emit 完整 `config_option`(model/mode/effort 真值),下拉立即完整。`ensureLive` 的
  `spawnMu` 串行化保证用户在 spawn 完成前发消息不会双 spawn。
- **`CreateSession` 不主动 spawn**:用户切到该 session 时 `App.tsx` 的 `openSession`
  回调调 `OpenSession` → 异步 ensureLive。「没切过去就不 spawn」省资源。
- **idle reaper**(`idleReaper` goroutine,`ServiceStartup` 起、`ServiceShutdown` 优雅停):
  周期扫(interval = idleTimeout/5,生产 5min→1min),超 `idleTimeout`(默认 5min,
  **从最后 turn 结束算**)且非 busy 的 session 自动 `CloseSession`(杀进程组,释放资源)。
  busy 双重检查(reaper 收集 + `CloseSession` 内)防误杀进行中 turn。
- **用户切回 / 发消息时 `ensureLive` 探活**:进程已死(idle 被 reaper 杀 / 空闲断连 /
  崩溃)→ `teardownLive` + `LoadSession` resume 无感重连(§5.4 #9/#16 已验收)。

### idle 计时口径

`lastActivity` 更新点:`startLive` 初始化(spawn 完成)、`runPrompt` finalize(turn 结束,
含取消/失败)。**idle 计时 = 最后一次 turn 结束后 5min**。turn 进行中(busy)不计时
(reaper 跳过),turn 结束后重新开始 5min 倒计时。

### 锁顺序(防死锁)

- `s.mu`(ChatService,保护 active map)→ `ls.mu`(liveSession,保护 busy/lastActivity)
  在 startLive / CloseSession 中一致;idleReaper 持 `s.mu.RLock` 遍历收集 toClose,
  **释放 RLock 后**逐个调 `CloseSession`(自身拿 Lock),无死锁。
- busy 双重检查:reaper 收集时查一次 busy,`CloseSession` 执行前再查一次(防收集后
  用户并发发消息把 busy 翻 true 致误杀)。

## 改法

- **`internal/chat/chat.go`**:
  - `OpenSession`:异步 `go ensureLive`,立即返回。
  - `CreateSession`:删预热调用(`emitSessionConfig`/`maybeWarmSession`),worktree
    建完直接 return。
  - 新增 `idleReaper`/`startIdleReaper`/`closeIdle`(goroutine + 周期扫描回收)。
  - `liveSession` 加 `lastActivity int64`;`startLive` 初始化、`runPrompt` finalize 更新。
  - `CloseSession` 加 busy 守卫(busy 返 `errSessionBusy`),idler reaper 静默跳过。
  - `ServiceStartup` 起 `startIdleReaper`,`ServiceShutdown` 优雅停(`reaperStop` +
    等待 `reaperDone`)。
  - `ChatService` 加 `idleTimeout`/`reaperStop`/`reaperDone` 字段(`idleTimeout` 可
    注入,测试用 100ms)。
  - **删** `buildSessionConfig`/`emitSessionConfig`/`maybeWarmSession`/
    `emitCachedConfigForProject`/`configCacheKey`/`cfgCache`/`cfgProbing`。
  - `SetSessionConfigOption`/`GetSessionConfigOptions` 简化为仅活跃路径(未活跃返 error)。
- **`frontend/src/components/Composer.tsx`**:`ModelSelect` 删 `isStaticFallback`
  静态 input 分支(永远走 live 真值,多选项);顺带修复之前编辑遗留的 `modeOpt` 条件
  包装缺失(`{modeOpt && (` + `<select` 开标签丢失)的结构损坏。
- **测试**:删 `config_select_test.go`(全旧测试),新增 `idle_reaper_test.go`(6 例,
  mock chatConn 不启真 harness):`TestCloseIdle{ExpiresIdleSession,SkipsBusySession,
  SkipsRecentSession,ActivityResetsTimer}` + `TestIdleReaperGoroutineRecyclesAndStops`
  + `TestCloseIdleConcurrentSafe`。
- **`AGENTS.md` §5.4 #19**:保留 ①②③ 根因调研,重写 ④⑤⑥ 为 B 方案修法/验证/取舍。

## 改了哪些文件

`internal/chat/chat.go`、`internal/chat/idle_reaper_test.go`(新)、
`internal/chat/config_select_test.go`(删)、`frontend/src/components/Composer.tsx`、
`AGENTS.md`(§5.4 #19)、本 worklog。

## 验证

- `go build ./internal/...` ✅;`go test ./internal/... -race` ✅(9 packages)。
- `idle_reaper_test.go` 6 例全绿(含 `-race`):超时关 ✅、busy 留 ✅、未超时留 ✅、
  activity 重置计时 ✅、reaper goroutine 后台回收 ✅、并发安全 ✅。
- 前端 `tsc --noEmit` 无法跑(node_modules 未装,全量 TS2307 是依赖缺失非代码问题);
  `ModelSelect` 重写对照原版纯 select 模式,语法/类型在装依赖后应正常,真实验证留
  `wails3 build`/`wails3 dev`。
- 两个原子提交(`e6a27a3` 代码、`bb3dcb1` 文档),工作树干净。

## 下一步 / 可改进

- **实机验证**(待 `wails3 dev`):① 打开历史 session 下拉是否即时完整(model+mode+effort);
  ② 切走 session 5min 后 harness 是否被 reaper 回收(查进程 + `<DataDir>/monkey-deck.log`
  落 `session idle timeout, closing`);③ 切回被回收的 session 是否无感重连(LoadSession resume);
  ④ 进行中 turn 的 session 不被 reaper 误杀。
- **idle timeout 可配**:当前硬编码 5min(`NewChatService` 默认),后续可暴露到设置 UI
  或 settings 表。
- **多 session 内存观察**:同时开 5+ 个历史 session 的内存占用(每个 idle opencode ~50-150MB),
  确认 reaper 5min 回收够及时。
- **idler reaper 进程退出即时检测**(可选优化):当前靠 ticker 周期扫,最坏延迟 1 个 interval;
  可加 `cmd.Wait()` goroutine → 进程退出立即通知(类似 §5.4 #16 的绝对超时即时化建议)。
