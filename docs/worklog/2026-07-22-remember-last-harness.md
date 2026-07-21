# 2026-07-22 新建对话记住上次 harness(Task #21331)

## 起因

每次点「新建对话」,NewSessionModal 的 harness 默认选中列表首个(`harnesses[0]?.id`,恒为 omp)。
用户若常用 opencode,每次都要手动点一下切换。期望:记住上次新建对话选的 harness,下次默认选中。

## 设计

- **后端 lastHarness setting**:CreateSession 把用户选的 harness(经 Normalize)写进 SQLite settings 表
  (`key=lastHarness`),复用既有 `GetSetting/SetSetting` 通道(defaultModel 同范式,§5.3 本地是真相来源)。
  暴露 `GetLastHarness() string` 给前端读。空/未知 id 经 `harness.Normalize` 回退到默认 omp。
- **NewSessionModal 照抄 worktree null 范式**:worktree 的依赖值(isGit)是在弹窗打开时预取、
  塞进 `newSession` 状态、作为 prop 传给 modal 的。lastHarness 照搬:`createSession` 并行预取
  `IsGitProject + GetLastHarness`(Promise.all)→ 塞进 `newSession.lastHarness` → 传 `lastHarness` prop。
  modal 的 harness state 初始化:`lastHarness && harnesses.some(id 命中) ? lastHarness : harnesses[0]?.id`(未安装/未知回退首个)。

## 改法

1. `internal/chat/chat.go`
   - `CreateSession`:在 `hid := harness.Normalize(harnessID)` 后 `SetSetting(ctx,"lastHarness",hid)`(失败仅 Warn)。
   - 新增 `GetLastHarness() string`(读 setting,无则空串,前端自行回退)。
2. `frontend/src/App.tsx`
   - `newSession` 状态类型加 `lastHarness: string`;`createSession` 用 Promise.all 预取 isGit+lastHarness;
     渲染 `<NewSessionModal>` 传 `lastHarness` prop。
3. `frontend/src/components/NewSessionModal.tsx`
   - Props 加 `lastHarness: string`;harness state 初始化按命中规则取默认(注释更新)。
4. `frontend/bindings/...`(不入库):`wails3 generate bindings` 重生成,新增 `GetLastHarness`。
5. 新增测试 `internal/chat/last_harness_test.go`:覆盖「未建过=空 / opencode 记下 / 空→omp / 未知→omp」。

## 验证

- `go build ./internal/...` + `go vet ./internal/chat/ ./internal/store/`:CLEAN。
- `go test ./internal/chat/ ./internal/store/`:PASS(含新 TestCreateSessionPersistsLastHarness)。
- `npm run build`(frontend,tsc+vite):PASS(绑定已重生成)。

## 下一步

无 OPEN。可选增强:lastHarness 可考虑做 per-project(某项目常用某 harness),但当前全局一个足够简单(KISS)。
