# 2026-08-23 排查:set_config_option 报 -32602 model not found(opencode/x-preview-f-free)

## 起因

用户在 app 里选 `opencode/x-preview-f-free` 时,harness 回:

```json
{"code":-32602,"message":"Invalid params: model not found: opencode/x-preview-f-free",
 "data":{"modelId":"opencode/x-preview-f-free","providerId":"opencode"}}
```

要求排查原因(只排查,未改代码)。

## 根因

### 错误是谁发的

opencode harness 本身,不是我们的 Go 层。逐层定位:

- opencode 源码 `packages/opencode/src/acp/error.ts`:`ACPInvalidModelError` → `RequestError.invalidParams({providerId, modelId}, "model not found: <modelId>")`,与用户看到的 JSON 完全吻合(data 里 modelId 是全串、providerId 单独一个字段)。
- `packages/opencode/src/acp/service.ts` 的 `parseSelectedModel`(~L918):`session/set_config_option(configId="model")` 时,拿 value 去 **接收调用的那个 harness 进程自己持有的 Directory.Snapshot**(provider→models 目录快照)里查,查不到即抛此错。
- 我们的调用链:`App.tsx:1418 setSessionConfig` → `ChatService.SetSessionConfigOption`(chat.go:2432)→ `ChatSession.SetConfigOption`(internal/acp/runner.go:600)→ ACP `session/set_config_option`。我们只是原样回传 agent 自报的 value,没有构造错格式的空间(§3.6 的裸名坑不适用)。

### 为什么「下拉里有、harness 却说没有」

两个事实叠加:

1. **opencode 对每个 cwd 的目录快照是进程内永久缓存**(`acp/directory.ts`:SynchronizedRef map + Effect.cached,仅加载出错才失效)。harness 进程不重启,provider/model 目录就停留在 spawn 时刻;models.dev / opencode Zen 目录是动态的,x-preview-f-free 这种 preview 模型时有时无 → 不同代次 spawn 的 harness 快照内容不同。
2. **我们给前端渲染下拉的数据源与「真正接收 set 的活跃 harness」可以不同步**,共三个来源:
   - 活跃 harness 在 NewSession/LoadSession/config_option event 里自报(一致,安全);
   - 只读态从 SQLite `ConfigOptionsCache` 渲染(GetSessionCachedConfigOptions,chat.go:2459)——历史快照;
   - 点「刷新」走 `RefreshSessionConfig`(chat.go:2474)——spawn 独立 probe 进程拉**最新**目录并覆盖活跃 session 的下拉+缓存。

   (b)/(c) 展示的列表都可能包含活跃长命 harness 快照里没有的模型;用户选中 → set 到活 harness → 被它按旧快照拒绝。

### 实证

- 正在运行的 app:`/Users/jessonchan/temp/monkey-deck/bin/Monkey Deck.app`(周四起跑,M1 提交 dbe6971,含上述全部代码路径);其活 harness `opencode acp`(PID 99862,~/.opencode/bin/opencode v1.18.21,cwd=monkey-deck 项目 worktree)今天 08:48 起。
- opencode 自身日志(`~/.local/share/opencode/log/opencode.log`):08:52 同一活 harness 用 `providerID=opencode modelID=x-preview-f-free` 流式**成功**(title 小模型 + build 主模型)——说明新代次 harness 有该模型。
- 探针复现(Python 裸 JSON-RPC,同 binary、同 worktree cwd 全新 spawn `opencode acp`):Initialize → session/new 自报列表**含** `opencode/x-preview-f-free` → `session/set_config_option` **成功**回全量 configOptions。
- 结论:binary/配置/cwd 都无关;差异只在**接收 set 的那个进程的快照新旧**。报错的应是更早代次的 harness(app 长跑,idle reaper 15 分钟 reap 后下次使用才重 spawn;或 probe 刷新给了更新的列表)。

## 改法(2026-08-23 已实施)

**产品决策(用户拍板)**:不静默自动重连。切换模型是用户行为,恢复也由用户触发——我们只把错误讲人话、给出自救路径。

落地(internal/chat/chat.go):
1. `SetSessionConfigOption` 收到 harness 拒绝且 `isModelNotFoundErr`(匹配稳定的 "model not found" 消息子串,不看数字 code)时,转成人话错误:「模型 X 在当前会话中不可用(agent 进程的模型列表未包含它)。请关闭并重新打开该会话后再选择」——重开会话即重 spawn 新进程(resume 保住对话),新进程带最新目录。
2. 其它错误原样透传(peer disconnected 等已有自己的处理路径)。
3. 未做预校验拦截:活跃 session 的下拉列表本就来自活 harness 自报,预校验拦不住「probe 刷新后列表更新但快照没变」的主场景;统一在 set 失败处兜底更简单(KISS)。

测试(internal/chat/set_config_option_test.go,mock conn §5.1):
- model not found → 人话错误含模型名与「重新打开」,不含 -32602/Invalid params;
- 其它错误透传不变;
- isModelNotFoundErr 正反例 + nil。

## 验证

- 探针脚本:`/var/folders/.../T/opencode/acp_probe.py`(临时目录,不入库),两种 cwd(temp 目录 / 真实 worktree)均通过。
- 用户侧即时规避:重开 session(触发重 spawn 新 harness);现在报错会直接告诉用户这么做。
- `go test ./internal/chat/ ./internal/remote/` 全过(main 包的 frontend/dist embed 缺失为环境预存问题,需前端构建,与本改动无关)。

## 下一步

- 已按「用户自救」方案落地(见上);若后续用户仍觉得重开路径太绕,可再评估一键「重连会话」按钮。
- 观察其它 harness(omp 等)是否也有同类目录快照冻结问题;isModelNotFoundErr 按消息子串匹配,天然兼容。
