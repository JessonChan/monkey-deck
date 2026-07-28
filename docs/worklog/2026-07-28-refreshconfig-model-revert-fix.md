# 2026-07-28 修 RefreshConfig 把模型切回默认(打开下拉几秒后 Qwen→GLM-5.2)

## 起因

用户报:OMP 里新建对话、切换模型到 Qwen,几秒后自动变回默认 GLM-5.2。怀疑是上一条「turn 非 end_turn
报错」改动引入 —— 经 `git show 1cf364b` 证实**无关**(那次只动 runPrompt + 常量 + i18n,没碰 config/模型)。

## 根因

打开 model 下拉会防抖触发 `refreshConfig`(App.tsx)→ 后端 `RefreshSessionConfig` → `RefreshConfig`
(runner.go:445)spawn **全新 probe harness** + `NewSession` 拿「最新可选列表」。然后这一行:

```go
cs.ConfigOptions = sess.ConfigOptions   // probe 的全量,含 CurrentValue
```

**把活 session 整个 configOptions(连同当前模型)用 probe 的覆盖**。probe 是全新 session,其
`CurrentValue`(模型)= harness 默认 GLM-5.2,不是用户刚切的 Qwen。于是:打开下拉 → 切 Qwen(活 session 应用)
→ 几秒后 probe 跑完 → 推 config_option 事件(GLM-5.2)→ 前端把 Qwen 盖回 GLM-5.2。

RefreshConfig 的本意是**只刷新可选列表**(同步外部新加的 provider/model),不该动当前选择 —— 它越权覆盖了
`CurrentValue`。

## 改法

`RefreshConfig` 覆盖前用 `mergeConfigCurrentValues(old, fresh)` 合并,而非整列覆盖:
- fresh 保留 probe 的最新可选列表(同步外部新增的模型)。
- 各 Select 选项的 `CurrentValue` 从 old(活 session)还原回去,**仅当该值仍在 fresh 的可选项里**
  (避免还原已下架的模型)。Boolean(unstable)不处理 —— 模型/模式/思考档都是 Select。

抽成纯函数 `mergeConfigCurrentValues` + `selectOptionAvailable`(Ungrouped + Grouped 都查),便于单测。

## 改了哪些文件

- `internal/acp/runner.go`(RefreshConfig 改用 merge + 新增两个 helper)
- `internal/acp/refresh_config_test.go`(新增:preserve / drop-removed / no-old / grouped 四个用例)

## 验证

- `go build` 通过;`go test ./internal/acp/` 通过(4 个新单测:切到 Qwen 后 probe 刷新仍保留 Qwen;
  下架模型不强行还原;old 空用 probe;Grouped 可选项判定)。
- 单测即修复证据:merge 逻辑保证活 session CurrentValue 不被 probe 默认覆盖。

## 下一步 / OPEN

- 桌面 app 实测确认:打开 model 下拉 → 切模型 → 不再几秒后回退(server 模式浏览器 send 不稳,未做 E2E)。
- 该 bug 是下拉刷新功能的既有问题,与上一条「turn 报错」改动无关(diff 已证)。
