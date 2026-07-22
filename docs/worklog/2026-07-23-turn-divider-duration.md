# 2026-07-23 feat:TurnDivider 显示本轮持续时间(Task #22112)

## 起因
Task #22112:回合分隔线(`TurnDivider`,`ChatView.tsx`)目前只在每轮用户消息前显示
回合**开始时刻**(`formatTime(user.ts)`),看不出这一轮 agent 跑了多久。需要在分隔线上
追加显示**本轮持续时间**。两个子问题:(1) turn 结束时刻从哪来;(2) 前端如何格式化展示。

## turn 结束时间来源(调研 / 设计)
- 数据模型(`internal/store/messages.go` `AppendMessage`):每条 message 落库时 `created_at = now()`。
- 关键事实(`internal/chat/chat.go`):
  - user 消息在**发送时**单独落库(`SendMessage`/`runPrompt` 调 `AppendMessage("user", …)`),
    `created_at` ≈ 回合**开始**时刻。
  - 本轮 thought/agent/tool 消息在**回合结束时**由 `persistTurn` 统一顺序写库,因此回合
    **最后一条** message 的 `created_at` ≈ 回合**结束**时刻。
- 结论:**turn end = 该回合最后一条 item 的 `ts`**(历史回合精确);turn start = user 消息 `ts`。
  duration = lastItem.ts − user.ts。这复用现有 `ChatItem.ts`(持久化路径 `messagesToItems`
  已把 `createdAt` 映射成 `ts`),无需新增后端字段 / 接口 —— 符合 §5.3「尊重数据源,不重新发明
  协议已给的东西」。

## 改法(KISS,纯前端)
1. **`turnBounds` useMemo**(`ChatView.tsx`):单遍 O(n) 扫 items,按 user 消息索引切分每个回合,
   算出 `{ start, end }`(end 取回合最后一条 item 的 `ts`)。只在「已结束」回合给出 end:
   - 有后续 user 消息 → 必已结束(下回合已开始);
   - 最后一回合 → 仅当 `props.status !== "prompting"`(idle/error/…)视为结束;进行中的回合
     没有结束时刻,不显示时长(无值 → `formatDuration` 返回空,不渲染)。
2. **渲染分支**:在 user 行的 `else` 分支取 `turnBounds.get(row.first)`,算出 `durationMs` 传给
   `TurnDivider`。顺手把重复的 `items[row.first] as user` 收敛成一个 `userItem` 变量。
3. **`TurnDivider` + `formatDuration`**:`durationMs` 格式化为 `Ns` / `Mm SSs` / `Hh MMm`
   (`<1s` 返回空),用 ` · ` 分隔追加在开始时刻后,套 `.turn-divider-dur`(`opacity:0.7`)略微
   弱化以与开始时刻区分。
   - 进行中回合 / 无 ts / `end<=start` → 不显示时长,行为与改动前一致(零回归)。

## 改了哪些文件
- `frontend/src/components/ChatView.tsx`:新增 `turnBounds` useMemo、`formatDuration`;`TurnDivider`
  增 `durationMs` prop;渲染分支传值。
- `frontend/src/index.css`:`.turn-divider-dur` 样式。

## 验证
- `make bindings`(`wails3 generate bindings`)补齐生成 bindings 后 `cd frontend && npm run build`
  (`tsc && vite build`):**通过**(无 TS 错误)。
- `cd frontend && bun test`:**83 pass / 0 fail**。
- `go build ./...`:通过(仅 macOS linker 版本 warning,无关);`go vet ./...`:clean。
- 改动纯前端,未改 Go 后端 / 数据库。

## 下一步
- 桌面 app 实测:多轮对话(≥2 轮)后,第 2 轮起的分隔线应显示「HH:mm · 1m 23s」;进行中的回合
  不显示时长,回合结束(idle)后出现;WebKit(macOS)优先,WebView2 抽检。
- 已知边界:实时刚结束的最后一回合 items 仍在内存(未重载)时,tool item 的 ts 缺失 / agent
  item 的 ts 为流式开始时刻 → 时长为下界估计;重开会话从 DB 重载后精确。日常不影响(分隔线主要
  看历史回合)。
