# review #158 elicitation 形状补收+可见婉拒 后端面(Task #28391)

## 结论

**APPROVE**。commit `2093c4d`(后端面:`internal/acp/elicitation.go`、`handler.go`、`chat.go`;i18n 两 key 顺带核对)。零阻塞问题,3 条 P3 留档。

## 审查方法

按「类型补丁」反模式反向追踪:不从 commit message 顺推,从新字段 `OnElicitationUnrenderable` 定义点出发逐调用点确认真实消费链,再复核形状解析逻辑、并发纪律、wire 契约与测试锚定值。

## 逐项核验(全部实证)

### 1. 消费链通电(反模式反向追踪)

```
elicitFields err → h.notifyElicitationUnrenderable()(elicitation.go:63)
  → OnElicitationUnrenderable 快照读 + 锁外调用 + panic 恢复(elicitation.go:142-160)
  → startLive SetElicitationUnrenderable 闭包(chat.go:1688-1690)
  → s.emit(EventStatus="chat:status", StatusPayload{Status:"notice", Code:"elicitation_unrenderable"})
  → App.tsx:641 `s.code ? t('chat.notice.'+s.code) : detail`(既有通用 notice 路径)
  → chat.notice.elicitation_unrenderable 双语 key 实测解析成功 + zh/en key 全量 parity 无差
```

wire 契约核对:`StatusPayload` JSON tags(`sessionId`/`status`/`code`)与 `frontend/src/types.ts:127-130` 一致。非空壳字段。

### 2. session 作用域正确(状态机/API 正确性关键点)

`chat.Handler` **非共享**:`runner.NewChatSession`/`ResumeChatSession` 每次 spawn 内部 `NewHandler(...)` 新建(runner.go:121/152),闭包捕获的 `se.ID` 与连接一一对应,无跨 session 回调覆写/notice 串台。与 `SetElicitationResolved`(#154 之前)、`SetCommandsCache`(#152)同一接线纪律;mu 快照读 + 锁外调用 + panic 恢复与既有模式逐行同构。`-race` 下 Elicit/SchemaDump/Concurrent 全绿。

### 3. 形状解析逻辑

- 形状 (b) 裸数组检查在 map 断言之先(elicitation.go:274),`m=nil` 不触 title/description 读取;
- 形状 (a) 无 type + `enum` 空数组:`.([]any)` 命中但 `synthSelect` len==0 返 false → 汇入婉拒链路(不产空 select),与文档一致;
- 主干零改动:trunk string+enum 仍按「只收 string」过滤(elicitation.go:300-306 原样),url/超时/ctx-cancel 三路径未动,既有 4 个主干用例全过。

### 4. 语义边界

- unrenderable 路径**不置** `elicitDeclined`(仅用户主动 decline 置位,elicitation.go:94-96)→ empty-turn 检测照常兜底 + `drainQueue` 照常续发队列。用户可能看到两条 notice(「表单不可渲染」+「本轮没有更多回复」),worklog §53 已声明为有意设计,第一条解释原因、第二条保证状态机不变,接受;
- harness 侧仍拿到干净 Decline → 优雅降级行为不变。

### 5. 测试质量(锚定值)

新 5 测试全部断言具体值而非字段存在:形状 (a) `["fast","ulw","3"]` 逐位比对 + title/required;形状 (b) `"42"/"true"` Sprint 化锚定;端到端断言 `resp.Decline != nil` + notice 通道 1s 内到达 + 日志含 `(truncated)` 且总长有界。`go test ./internal/...` 全量 ok,`go build/vet ./internal/...` 干净。

## P3 留档(不阻塞)

1. **`synthSelect` 丢弃 `default`**:主干路径带出 `m["default"]`(elicitation.go:296-298),合成 select 不带——`{enum:[...], default:"x"}` 无 type 形状渲染后无预选。旧行为是整场 decline,此为纯增益;后续若 harness 实测依赖默认值再补。
2. **`schemaDump` 截断可劈开多字节 rune**:`string(b[:limit])` 在 2048 边界可能切出非法 UTF-8 尾巴,slog 原样落盘仅影响日志观感,marker 仍在、长度仍有界。可在截断处回退到 rune 边界。
3. **非字符串 enum 选项应答回传字符串**:`accept` 透传前端 `Content`(elicitation.go:220),`{enum:[1,2,3]}` 合成 select 的应答是 `"1"` 而非 `1`——严格校验的 harness 可能拒。worklog 已声明为 best-effort 取舍;旧行为是静默 decline,严格改进,维持现状。

## 验证记录

| 项 | 结果 |
|---|---|
| `go build ./internal/...` / `go vet ./internal/acp ./internal/chat` | ✅ |
| `go test ./internal/... -count=1` | ✅ 全 ok |
| `go test ./internal/acp -race -run 'Elicit|SchemaDump|Concurrent'` | ✅ |
| i18n key 路径解析(zh/en)+ zh/en key 全量 parity | ✅ |

(仓库根 `go build ./...` 因 worktree 未产 `frontend/dist` embed 报错,与本改动无关;按 internal 包域验证。)

## 下一步

无。3 条 P3 供后续 harness 实测触发时按需处理。
