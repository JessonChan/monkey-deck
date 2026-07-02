# 2026-07-02 stream-merge-tool-update-duplication

## 起因(用户报告)
用户在 session `14ca4e70-77aa-47bd-93b4-0287d3792113` 看到「最近的消息连续收到 `这个问题 / 这个问题值得我 / 这个问题值得我认真`」—— 一条 agent 回复被拆成多条「累积前缀」气泡。用户怀疑:DB 是不是并没有那么多重复?是前端去重的 bug?

## 还原现场
1. **DB 是干净的**(不是 DB 的锅):
   - `SELECT seq,role,kind,length(content) FROM messages WHERE session_id='14ca4e70...' ORDER BY seq DESC` → 每个 segment 一条,无重复、无累积前缀污染。`persistTurn` 逐 segment 写库(`internal/chat/chat.go`),段与段各自独立。
   - 抽查 seq 37/55/57/63 等长 agent 消息,内容连贯无前缀重复。
   - 结论:**重复只发生在前端流式渲染时**,从未落库。
2. **ACP chunk 语义确认**(SDK `types_gen.go`):`SessionUpdateAgentMessageChunk.Content ContentBlock` = "A single item of content",即 chunk 是**增量**的。`flattenUpdate`(`internal/acp/handler.go`)取 `Content.Text.Text` 作为 `e.Text`(增量)→ `handleEvent`(`internal/chat/chat.go`)`agentBuf.WriteString(e.Text)` 累积 → 对外发**累积全文**。前后端契约一致,DB 正确。

## 根因(纯前端 bug)
`frontend/src/App.tsx` 的 `applyEventToItems`(流式合并纯函数)把 `tool_call` 与 `tool_call_update` **共用一个 case**,二者都无条件调 `finalizeLast()`。`finalizeLast` 会把当前正在流式的 agent/thought 气泡的 `streaming` 置 `false`。

- `tool_call`(新工具开始)= 真正段边界,finalize 正确。
- `tool_call_update`(仅更新**已存在**工具)= **不是**段边界。

但 omp 的 async task(`async.enabled`,见 §5.4 #10)在 `execute()` 返回后,后台 job 完成时仍调 `onUpdate` → 发出 `tool_call_update`。这种 update 会在 **agent 后续文本流中反复穿插到达**。每来一个 `tool_call_update`,`finalizeLast` 就把正在流式的 agent 气泡打 `streaming=false` → 下一个 `agent_message_chunk` 发现 `last` 不是流式 agent → **新建气泡**。

叠加后端行为:后端只有 `tool_call` 才 `flushCurrentSegment`(重置 `agentBuf`),`tool_call_update` **不 flush** → 这些穿插期间的 chunk 持续累积进同一个 `agentBuf` → 后端对每个 chunk 发的累积全文是**单调增长的**。前端却把它摊到 N 个气泡 → 每个气泡的文本正好是「累积前缀」:`这个问题 / 这个问题值得我 / 这个问题值得我认真`。气泡数 = 穿插的 `tool_call_update` 次数 +1(用户看到 3,实测构造可到 4)。

## 改法
1. 把 `applyEventToItems` 从 `App.tsx` 抽到纯模块 `frontend/src/lib/streamMerge.ts`(便于单测,§5.3)。
2. **拆分** `tool_call` 与 `tool_call_update`:
   - `tool_call`(段边界):仍调 `finalizeLast`,登记/更新 tool。
   - `tool_call_update`:仅**就地更新已存在** tool(不调 `finalizeLast`,不打断流式的 agent/thought);仅当出现「孤儿 update」(无对应 `tool_call` 的异常乱序)时,才兜底 `finalizeLast` + 建一条 tool。
3. 回归测试 `frontend/src/lib/streamMerge.test.ts`(`bun test`,6 个用例),含:
   - 纯 agent chunks → 单个累积气泡。
   - **`tool_call_update` 穿插不得拆分正在流式的 agent**(核心回归)→ 2 个段(tool_call 边界前后各一段),不是累积前缀的多条。
   - `tool_call` 仍是段边界、乱序 chunk 忽略、thought→message 分段、tool 字段更新。

## 改了哪些文件
- `frontend/src/lib/streamMerge.ts`(新增):抽出的流式合并纯函数(含修复)。
- `frontend/src/lib/streamMerge.test.ts`(新增):回归测试。
- `frontend/src/App.tsx`:删内联 `applyEventToItems`,改 `import { applyEventToItems as applyEventToItemsPure } from "./lib/streamMerge"`,`useCallback(applyEventToItemsPure, [])`。
- `frontend/tsconfig.json`:排除 `*.test.ts(x)` 出生产 tsc(test 用 `bun:test`,生产 build 不含测试)。
- `frontend/package.json`:加 `"test": "bun test"` 脚本。
- `AGENTS.md` §5.4:新增坑 #11。

## 验证
- `cd frontend && bun test src/lib/streamMerge.test.ts` → 6 pass / 0 fail。
- `npx tsc --noEmit` → EXIT=0。
- `bun run build:dev` → 成功(390 modules,产出 dist)。
- 未改任何 Go 代码,后端 `agentBuf` / `handleEvent` / `persistTurn` 行为不变,DB 落库仍逐段一条(已用实数据确认干净)。

## 下一步
- 真机回归:用 omp 跑一个含 async task(后台 onUpdate)的 turn,确认前端不再出现累积前缀的重复气泡。
- 观察 §5.4 #10(单调状态保护)与本坑的协同:`tool_call_update` 既要更新 rawOutput(可能带终态内容),又不能回退 status、不能打断流式 —— 三者在 `streamMerge.ts` 已分层处理,后续若再加字段注意维持。
