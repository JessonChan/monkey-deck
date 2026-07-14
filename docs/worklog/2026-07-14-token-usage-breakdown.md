# 2026-07-14 token 用量展示 + 模型切换成本提示

## 起因

Task #15138:展示 token 用量(CachedRead/Write tokens)到用量面板 + 模型切换前成本提示。
不依赖上游压缩,只做我方可控的采集、展示与提示。

## 协议调研

- `PromptResponse.Usage`(UNSTABLE)携带 token 明细:`CachedReadTokens`/`CachedWriteTokens`/
  `InputTokens`/`OutputTokens`/`ThoughtTokens`/`TotalTokens`。SDK 注释:这些是 session 级累积值
  ("across all turns"),直接覆盖即可。
- streaming `SessionUsageUpdate` 只含 `Used`/`Size`/`Cost`,**不含明细**。
  → 明细只能从 Prompt **响应**(turn 结束时)取,不能从消息流取。
- 现状:`ChatSession.Prompt` 丢弃了 `resp.Usage`,前端用量面板只展示 used/size/cost。
- AGENTS.md §1.6/§5.4 #2 提示:`PromptResponse.Usage` 多数为 nil(harness 不回填)→ 无明细时不展示,降级。

## 改法

### 后端数据采集(internal/acp)
- `SessionEvent` 新增 6 个 token 明细字段(CachedRead/Write/Input/Output/Thought/Total)。
- `Handler` 新增 `lastUsed/lastSize/lastCost` 跟踪(streaming UsageUpdate 写入时记录),
  供 `EmitTurnUsage` 携带转发 —— 否则明细事件不含 used/size,前端会用 0 覆盖既有占比。
- `Handler.EmitTurnUsage(sessionID, *acp.Usage)`:Prompt 返回后转发明细 + 携带 streaming 快照。
- `ChatSession.Prompt`:resp.Usage 非 nil 时调 EmitTurnUsage。

### 后端持久化(internal/store)
- migration 0010:新增 6 列(cached_read/write_tokens, input/output/thought/total_tokens)。
- `Session` 结构体 + `sessionColumns`/`scanSession` 同步扩展。
- 新增 `UpdateSessionTokens`(与 `UpdateSessionUsage` 分离:明细只在 Prompt 返回后写,
  streaming 不含明细,互不覆盖)。

### 后端连线(internal/chat)
- `handleEvent` 对 usage_update 事件:除既有 used/size/cost 持久化外,
  若事件带明细(Total/Input/Output 任一非 0)则额外调 UpdateSessionTokens。

### 前端展示
- `types.ts`:新增共享 `Usage` 接口(收敛 App/ChatView/Composer 三处重复定义)。
- `App.tsx`:Usage 类型扩展 + usage_update 事件合并(明细仅在事件带时覆盖,否则保留旧值)+
  DB 恢复(openSession 从 session 字段恢复明细)。
- `ChatView`:usage-bar 改用 react-tooltip(§4.5),有明细时 tooltip 展示分项明细(\n 多行,
  CSS `white-space: pre-line` 渲染);无明细则保持原标题。
- `Composer`:ModelSelect/ConfigSelect 新增 contextTokens + 模型切换成本提示:
  - popover 顶部 hint 展示当前上下文 token 量级(始终,有上下文时)。
  - 每个模型选项右侧附预估单轮成本(有定价时;lookupModelPricing 精确+模糊匹配)。
  - `lib/modelPricing.ts`:定价表(尽力而为快照,非计费依据)+ estimateSwitchCost 估算。

## 改了哪些文件
- `internal/acp/handler.go`(SessionEvent 字段 + Handler 跟踪 + EmitTurnUsage)
- `internal/acp/runner.go`(Prompt 调 EmitTurnUsage)
- `internal/acp/usage_emit_test.go`(新增,EmitTurnUsage + streaming 跟踪测试)
- `internal/store/migrations/0010_session_token_breakdown.sql`(新增)
- `internal/store/store.go`(Session 结构体)
- `internal/store/sessions.go`(columns/scan + UpdateSessionTokens)
- `internal/store/store_test.go`(TestSessionTokenBreakdownPersist)
- `internal/chat/chat.go`(handleEvent 持久化明细)
- `frontend/src/types.ts`(共享 Usage 接口)
- `frontend/src/App.tsx`(Usage 类型 + 事件合并 + DB 恢复)
- `frontend/src/components/ChatView.tsx`(usage-bar 明细 tooltip)
- `frontend/src/components/Composer.tsx`(model 切换成本提示)
- `frontend/src/index.css`(tooltip pre-line + cfg-ctx-hint/option-cost 样式)
- `frontend/src/i18n/locales/{zh,en}.json`(usage 明细 + switchCostHint)
- `frontend/src/lib/modelPricing.ts` + `.test.ts`(定价估算)

## 验证
- `go build ./...` / `go vet ./...` clean。
- `go test ./...` 全绿(含新增 usage_emit / token breakdown persist 测试)。
- `tsc --noEmit` 无类型错误;`vite build` 成功;`bun test` 34 pass。
- 不依赖上游压缩:仅展示与提示,不修改 ACP 协议行为。

## 下一步
- 真实 harness(opencode)联调:确认 resp.Usage 实际回填的模型/harness 组合,定价表据此补全。
- Pricing 表维护:目前仅收录 Anthropic/OpenAI/Google 几款常见模型;后续可按需追加或外置配置。
