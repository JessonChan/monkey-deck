# 2026-07-02 移除 opencode 特殊的 model 注入逻辑

## 起因

调研 ACP 协议 + opencode/oh-my-pi 两端实现后确认:**ACP v1 没有「client 在
initialize / session/new 指定默认 model」的标准字段**。模型选择的标准路径是
session config option(`category=model`)+ `session/set_config_option`,opencode
和 oh-my-pi 都走这条。

我们之前对 opencode 单独走「在 cwd 写 `opencode.json` 注入 model」(规避协议层
传 model 被忽略的 bug),是一条 harness 专用旁路,违反 §1.1「harness 适配只在
`internal/acp` 抹平差异」的精神,也让 model 注入逻辑分裂成两套。用户决定先移除
这条 opencode 特殊处理,统一收敛到 ACP config option 路径。

## 根因(协议调研结论)

- `NewSessionRequest` 只有 `cwd` / `mcpServers` / `additionalDirectories`,无 model。
- opencode `acp/service.ts`:`newSession` 内部 `selectDefaultModel(snapshot)` 选
  默认模型,`setSessionConfigOption(configId="model")` 热切;value 是 `provider/model`。
- oh-my-pi `acp-agent.ts`:同构,`MODEL_CONFIG_ID="model"`,`#toModelId` = `provider/id`。
- 两端都在 NewSession 响应里返回 `configOptions`,client 据此渲染 + set_config_option。

结论:统一主路径 = 读 configOptions → `session/set_config_option("model", value)`。
opencode.json 注入只应作为 opencode 自身默认值的手段,不该由 client 强写。

## 改法

移除 opencode 专用 model 注入,保留 ACP config option 热切路径(SetSessionConfigOption
不变)。 Runner 不再持有/注入 model。

- **`internal/acp/runner.go`**:
  - 删 `Runner.Model` 字段、`WriteModelConfig`(写 opencode.json 的整段)、`strconv` import。
  - `NewRunner(command, env)` 去掉 model 参数。
  - `ChatSession` 删 `Model` 字段;`NewChatSession`/`LoadChatSession` 构造去掉 `Model: r.Model`。
  - `spawnAndInit` 删 `r.WriteModelConfig(workDir)` 调用,注释更新。
- **`internal/chat/chat.go`**(`startLive`):
  - 删 `harness.IsOpenCode` 分支(model 仅 opencode 注入的特判),`acp.NewRunner(cmdStr, nil)`。
- **`internal/harness/harness.go`**:删 `IsOpenCode`(仅用于上述特判)。
- **`internal/harness/harness_test.go`**:删 `TestIsOpenCode`。
- **`internal/store/sessions.go`**:`UpdateSessionModel` 注释去掉「写 opencode.json」措辞,
  改为「首条消息 NewSession 后改走 set_config_option 热切」(函数本身不动,仍用于首条消息前写库)。
- **`internal/acp/integration_test.go` / `resume_test.go`**:`NewRunner(..., nil)` 适配新签名。

## 不变的部分

- `SetSessionConfigOption`(chat 层)双模:活跃→`session/set_config_option` 热切;
  未活跃→`UpdateSessionModel` 写库。这条 ACP 主路径**保留**,是模型切换的正道。
- `project.Model` / `session.Model` / `cfg.DefaultModel` 字段保留(首条消息前写库 + UI 展示用)。
- §3.5「model 必须 provider/model 格式」仍成立 —— config option 的 value 就是这个格式。

## 改了哪些文件

`internal/acp/runner.go`、`internal/chat/chat.go`、`internal/harness/harness.go`、
`internal/harness/harness_test.go`、`internal/store/sessions.go`、
`internal/acp/integration_test.go`、`internal/acp/resume_test.go`、本 worklog。

无 Go 导出方法(Wails binding)签名变更 → **无需 `wails3 gen bindings`**;前端零改动。

## 验证

- `go build . ./internal/...` ✅(仅 macOS SDK linker warning,非错误)。
- `go test ./internal/acp/ ./internal/chat/ ./internal/harness/ ./internal/store/` ✅(4 packages ok)。
- `go vet` 干净;`gofmt -l` 干净。

## 下一步 / 可改进

- 实机验证(`wails3 dev`):opencode session 创建后用 model selector 切模型是否经
  `set_config_option` 即时生效(不再依赖 opencode.json)。
- 若实测发现 opencode 在「无任何 model 指定」时默认模型不理想,再考虑是否需要给
  opencode 提供一条「默认模型预设」的非侵入手段(优先 opencode 自身 config,而非 client 写文件)。
- §5.4 #13/#14 里关于 opencode.json 的历史描述现在只作背景,不再是 active 路径。
