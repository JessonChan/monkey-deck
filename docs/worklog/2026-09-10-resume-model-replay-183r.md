# #183r D2 值差异驱动 model 重放(codebuddy resume 上报默认值致用户 model 丢失)

- 日期:2026-09-10
- 任务:#29250(issue #183 重开,codebuddy 变体)
- 改动面:`internal/chat/chat.go`(replayResumeConfigGaps)+ `internal/chat/resume_config_replay_test.go`
- 基线:main `aea54b9`(任务书写 923d29f,main 在任务创建后又前进 3 个 docs/fix commit,锚点行实查一致,无冲突)

## 起因 / 根因

#183 的 D2 契约是「model 永不重放」:resume 响应里已报的键一律以响应为准(`reported[o.ID]` 命中即 skip),model 另有无条件 skip。前提是 harness resume 时自恢复 model、上报值即用户所选。

**codebuddy 不满足该前提**。本次本地实抓 wire 验证(非凭 issue 描述建模):

- 环境:`~/.bun/bin/codebuddy`(CodeBuddy Code,`--acp` stdio 模式,protocolVersion 1),临时空目录,Python 直驱 JSON-RPC。
- `session/new` → `session/update` `config_option_update` 报 4 个 select:`mode`(current=`default`)、`model`(current=**`hy3`**,options 15 项含 `glm-5.2`)、`thought_level`(=`enabled`)、`sandbox`(=`false`)。
- `session/set_config_option(configId=model, value=glm-5.2)` → result ok。
- **杀进程,新进程 `session/load` 同 sessionId** → model `currentValue` 回到 **`hy3`**(默认),options 全列表仍在。

即:codebuddy 的 resume **不自恢复 model 且上报默认值**。旧代码 `reported["model"]` 键命中 → skip → 用户缓存的 model 静默丢失。同时 resume 携带完整 options 列表,说明「缓存值是否合法」在 resume 时可判定——这是值差异驱动方案的可行性前提(§5.3 先验证外部事实再动手)。

## 修法

拆掉 `replayResumeConfigGaps` 里 model 的无条件 skip,D2 改为**值差异驱动**(重开评论拍板):

1. `reported` map 从 `map[string]bool` 改为 `map[string]acp.ConfigOption`(保留上报 option 全量,含 Options 列表)。
2. 循环规则:
   - 缓存项 `CurrentValue == ""` → skip(D3 原语义,只是判断提前,结果不变)。
   - 键未被上报 → 照旧走重放(model 现在也如此,见下方决策①)。
   - 键已报且**非 model** → skip(D3 reported-keys-win 语义零改动)。
   - 键已报且是 **model**:
     - 上报值 == 缓存值 → 天然 skip(opencode/omp 自恢复 model,上报即缓存值,零回归);
     - 上报值 ≠ 缓存值 且 缓存值 ∈ 上报 Options 列表 → 重放 `SetConfigOption("model", 缓存值)`(走既有 :1947 管线,D5 cache repair 语义:runner 以 set 响应换 ConfigOptions,startLive 尾部 emit+persist);
     - 缓存值 ∉ 上报列表(已下架)→ 静默不重放 + `slog.Warn`(D5 精神:绝不强设非法值,不炸 resume)。

**显式决策(评审关注点预告)**:

- ① model 完全未被 resume 上报时(现网三 harness 均会报 model,此路径当前无命中者),model 与 thought/mode 一致按「缺失键」重放、不另设门槛——与函数 doc 顶部「replay set = 缓存快照里 resume 缺失的键」一致,不为假想 harness 堆特例(§5.3 找不变量不堆 if)。
- ② 值差异重放意味着 model 上「缓存 > 上报」,与 D3「harness 是自己 session 配置状态的权威」在 model 上有意冲突:因为实抓证明 codebuddy 的上报值不是权威而是默认占位。代价是「用户在别处改了 model、本地缓存滞后」时会被打回缓存值——这是重开拍板接受的 tradeoff,且仅在缓存值仍合法时发生。
- ③ 合法性门槛只查**上报**的 options 列表(最新菜单),不查缓存里的旧列表(防陈旧)。

D1(重放在 emit+persist 之前)、D4(单键失败 best-effort)、D6/D7 场景语义零改动。

## 测试

`internal/chat/resume_config_replay_test.go` 扩 2 例 + 存量注释修订(触到的中文注释顺手转英文,§3.7):

- `TestResumeConfigReplayModelValueDiffReplays`(codebuddy 形态,worklog 注释标注 wire-verified):缓存 model=`glm-5.2`,resume 上报 `fake-model`(默认)且列表含 glm-5.2 → 断言 `recordedSets == ["model=glm-5.2","thought=high","mode=code"]`(调用参数即缓存值、快照序),且重放后 FlatConfigOptions 的 model 落到 glm-5.2。
- `TestResumeConfigReplayModelValueNotInListKeepsReported`:缓存 `fake-model` 不在上报列表 → 零 model 调用(静默,仅 warn 日志),thought/mode 照旧重放。
- opencode/omp 形态(上报=缓存)显式在列:omp 形态 = `TestResumeConfigReplayRestoresMissingKeys`(model-only 上报且等于缓存,断言恰好 `["thought=high","mode=code"]`);opencode 形态 = `TestResumeConfigReplayFullResumeNoReplay`(全量上报,零调用)。
- D1-D7 存量用例全部原样通过(e2e fakeagent 的 resume 形态 = model-only `fake-model` 等于种子缓存,天然落在「相等即跳过」路径,零改动)。

## 验证

- `go test ./internal/chat/ -run Resume -count=1` 全绿(10 用例:3 单元 D7 场景 + 2 新增 + SkipsNothingToRestore 3 子用例 + 3 e2e)。
- 验收门:`frontend/dist` stub 后 `go build ./...` exit=0、`go vet ./...` exit=0、`go test ./...` exit=0(15 包 ok,0 FAIL;ld 版本 warning 为本机工具链噪音)。
- `git status` 干净(仅 gitignore 的 `.rak/`、`frontend/dist` stub,无 `.rak-env` 等运行时文件)。
- 备注:本任务执行中会话两次中断导致 worktree 被重置、未提交改动两次丢失;同内容第三次重放后先 commit 再补门,结果一致。

## 下一步

- 流程约定:coder 完成即停,待 reviewer 复核;不 push、不关 issue。
- OPEN(供 review/后续参考):值差异重放在「多客户端同 session 各自改 model」场景会以最后 resume 的缓存为准,若未来成为实际问题,可考虑在重放成功后回写缓存时间戳/来源标记再评估(当前不做,记入观察)。
