# 2026-07-23 feat:删 ChatView refresh-config-btn,model 下拉打开自动重拉 configOptions(Task #22142)

## 起因
Task #22142:header 的 `refresh-config-btn`(刷新模型列表按钮)是多余入口——刷新 configOptions
本质是「同步外部 harness 配置改动」,最自然的触发时机是**用户打开 model 下拉**(这时才关心有哪些
可选模型)。把刷新从「手动按钮」改成「打开下拉自动重拉(防抖)」,删掉 header 按钮,收敛入口。

## 改法
1. **触发点下沉到 model 下拉**:`Composer.ConfigSelect` 是 Radix Popover,已有受控 `open` state。
   新增可选 `onRefreshConfig` prop,`useEffect` 在 `open` 由 false→true(及为 true 时)触发;只在
   model 那个 ConfigSelect(`groupByProvider`)上传,mode/effort 不传 → 不触发(只有 model 选项会
   因外部 provider 增删而变)。
2. **防抖(400ms)**:下拉快速开合 / Radix 动画期间可能多次触发 open,`App.refreshConfig` 用
   `refreshTimerRef` setTimeout 防抖,最后一次触发后 400ms 才真正 spawn probe harness。避免连点连
   spawn 多个 probe 进程。
3. **readonly/empty 跳过**:`RefreshSessionConfig` 要求 session active(spawned),懒 spawn 只读态
   调用会报 "session not active"。`refreshConfig` 内部用 `statusRef.current` 判 `readonly`/`empty`
   直接 return(不报错、不 spawn)——只读态下拉仍渲染持久化缓存(`GetSessionCachedConfigOptions`
   seed),用户 Continue 唤醒后首次开下拉才真正重拉。
4. **删 header 按钮 + 清理**:`ChatView` header 的 `refresh-config-btn`、`RefreshCw` import、
   `refreshingConfig` prop 全删;`App` 删 `refreshingConfigBySession` state(不再需要 loading 态——
   重拉是后台静默行为,成功后由 `config_option` event 自动更新下拉,无需 spinner)。i18n 删
   `refreshConfigTip`/`refreshingConfig`/`refreshConfigDone`(保留 `refreshConfigFailed` 仍用于
   catch 错误提示)。

## 改了哪些文件
- `frontend/src/App.tsx`:删 `refreshingConfigBySession` state;`refreshConfig` 改防抖 +
  readonly/empty 守卫 + `refreshTimerRef`;删 `refreshingConfig` 传参。
- `frontend/src/components/ChatView.tsx`:删 `refresh-config-btn` 按钮 + `RefreshCw` import +
  `refreshingConfig` prop;Composer 传 `onRefreshConfig`。
- `frontend/src/components/Composer.tsx`:`Props`/签名/`ModelSelect`/`ConfigSelectProps`/`ConfigSelect`
  全链路加 `onRefreshConfig`;model `ConfigSelect` 开下拉触发。
- `frontend/src/i18n/locales/{en,zh}.json`:删 3 个无用 key。
- 测试同步:`ChatView.virtual.mount.test.tsx`、`TurnDivider.duration.mount.test.tsx`(删
  `refreshingConfig` stub)、`ModelSelect.mount.test.tsx`、`Composer.mount.test.tsx`(加
  `onRefreshConfig` stub)。

## 验证
- `wails3 generate bindings` + `cd frontend && bun run build`(`tsc && vite build`):**通过**(无 TS 错误)。
- `cd frontend && bun test`:**107 pass / 0 fail**。
- `go build ./...`:通过(仅 macOS linker 版本 warning,无关);`go vet ./...`:clean。
- 改动纯前端,未改 Go 后端 / 数据库。

## 下一步
- 桌面 app 实测:开 model 下拉 → 400ms 后后端日志应见 `refreshed config options`;外部改 harness
  配置加 provider 后重开下拉应看到新选项。readonly 态开下拉不报错(静默跳过)。
- 后端 `RefreshSessionConfig` 暂未改(仍是 spawn probe 模型),后续若 ACP 出 config refresh RPC 可
  顺势替换,前端触发逻辑不变。
