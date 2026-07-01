# tool 卡片残留「执行中」状态

## 起因

用户反馈 session `f1131e2e` 最新的两个 edit 工具调用永远显示「执行中」，重新打开 session 后恢复正常。

## 根因

ACP agent 发工具调用的协议流是两步：
1. `tool_call` 事件 → status=`in_progress`（或 `pending`）
2. `tool_call_update` 事件 → status=`completed` + rawOutput

前端通过 Wails3 event 实时收到①时创建 ChatItem（status=in_progress），收到②时更新为 completed。

如果②因时序/投递问题没到达前端（或到达了但状态字段为空），前端缓存就永远卡在 in_progress。

**后端 DB 是正确的**：`runPrompt` 收尾时从 `ls.tools`（已被 handleEvent 更新为终态）持久化，DB 里 status=completed。但前端缓存没同步到。

前端在回合结束（idle/error/closed）时已有逻辑清理 agent/thought 的 `streaming` 标志，但**遗漏了 tool 的中间态收口**。

## 改法

`App.tsx` 的 `chat:status` handler，在 idle/error/closed 分支中（原 agent/thought streaming 清理旁边），把残留的 `in_progress`/`pending` tool 强制收口：
- idle → `completed`（Prompt 正常返回意味着所有 tool 必然到终态）
- error/closed → `failed`

只改中间态（in_progress/pending），已到终态（completed/failed）的 tool 不受影响。

## 改了哪些文件

- `frontend/src/App.tsx`：`chat:status` handler 的回合结束分支，新增 tool 中间态收口逻辑（~3 行新增）

## 验证

- `npx tsc --noEmit` 编译通过
- 逻辑验证：ACP Prompt 正常返回（StopReason=endTurn）时所有 tool 必然已到终态；已标 completed/failed 的不受影响；只有残留中间态被收口

## 下一步

可选增强：后端在 `persistTurn` 之后、`emitStatus("idle")` 之前，emit 一批 `tool_call_update` 事件把最终 tool 状态同步给前端（更精确，用已有协议路径，前端零改动）。当前前端兜底方案已足够覆盖该场景。
