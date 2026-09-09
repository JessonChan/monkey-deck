# 2026-09-09 fix(chat): #209 跨 turn 重复 toolCallId 致渲染错乱——行身份加 turn 维度

## 起因

用户报告:「603515 欧普照明…」会话页面渲染错乱(布局/内容位置乱)。

## 取证(生产 DB)

session `24f71148`(harness=codebuddy-code,project stock-quant),140 行消息里发现
**13 组跨 turn 的重复 entry_key**——同一 `toolCallId`(如 `chatcmpl-tool-838251b8…`)在
turn `d7f374ff` 与 turn `5bdc00db` 各落一行;另有同 turn 双写(seq 131/132 同内容、同长度,
一个 fallback key `_fb:3:agent`、一个主键 key `msg:5308…:agent`——codebuddy 先发无 id 的
chunk 流再发带 id 的最终消息,两条路径各开一个 entry)。

日志时序:17:53 turn 1 中 peer disconnected → 自动重连 resume → **codebuddy resume 后把
turn 1 的历史按事件重放**,重放的 tool_call 带原 toolCallId 落进新 turn 的 timeline
(时间戳 17:53:17.032-061,密集 30ms,是重放批次;turn 3 19:15 resume 同样再重放)。

## 根因(§5.3 违规:转换层丢弃稳定标识)

- **DB 层无恙**:唯一索引 `(session_id, turn_id, entry_key)` 含 turn 维度,重放插新行是合法的。
- **前端把裸 key 当 session 内全局唯一**:
  - `messagesToItems`(DB 读路径):tool 行 id = 裸 `toolCallId` → 重复;
  - `streamMerge`(实时路径):`findIndex(id===toolCallId)` 命中**第一个**旧 tool,就地 patch
    → 重放内容写进旧行位置;
  - `buildRows` 行 id / 虚拟列表高度模型 `model.set(rs[idx])` / React `key={row.id}` 全部
    以行 id 为键 → 同 id 双行共享高度记录、keyed reconcile 错复用 → **布局错乱**。
- **实时事件同样丢 turn**:`handleEvent` 只给 plan 事件盖 TurnID,内容事件不带。

## 改法(修不变量:行身份 = turn + 原始 key)

1. **后端** `handleEvent`(internal/chat/chat.go):agent/thought chunk、tool_call、
   tool_call_update 事件统一盖 `e.TurnID = ls.currentTurnID`(有 live turn 时);idle 重放
   窗口(无 live turn)留空,前端回退裸 id。
2. **前端 `messagesToItems`**(App.tsx):agent/thought/tool 行 id =
   `turnId ? turnId:key : key`(user 行 id 本就是唯一 message id,不动;plan 行不动)。
3. **前端 `streamMerge`**(实时):tool_call / tool_call_update 的归并 id 同样加 turn 前缀。

三条路径(DB 读、实时归并、React 渲染)的行身份同构;同 turn 内语义不变(重复 tool_call
仍就地 patch)。

## 改了哪些文件

- `internal/chat/chat.go`:内容事件盖 TurnID。
- `internal/chat/turn_stamp_test.go`(新增):idle 留空 + live 盖章断言。
- `frontend/src/App.tsx`:messagesToItems 行 id 加 turn 前缀。
- `frontend/src/lib/streamMerge.ts`:tool 归并 id 加 turn 前缀。
- `frontend/src/lib/streamMerge.turnscope.test.ts`(新增):跨 turn 分行 / 同 turn 就地
  patch / 空 turnId 回退 4 场景,pre-fix 2 fail → post-fix 全 pass。

## 验证

- 后端:`go test -count=1 ./...` 多轮全绿(0 FAIL);新 turn_stamp 测试 PASS。
- 前端:`bunx tsc --noEmit` 0 错;`bun run build` 通过。
  - 变更相关:lib 全家(sessionDrop/streamMerge/virtualList/sessionStatusMerge)69 pass;
    mount(busy-switch-back + fork-prefix-pagination)10 pass。
  - 全量 590:失败集合与干净树逐条 diff **完全一致**(worktree-guard 4 条系既有
    chatservice-mock 静态 import 环境问题,2026-09-08 worklog 已记录),非本次引入。
- **端到端**(server 二进制 + 生产 DB 副本 + binding 取全 140 行):裸 id 重复 10 组;
  turn 加前缀后重复 0——生产数据形状下行身份唯一性恢复。

### 三端覆盖

纯渲染身份逻辑,无 UI 面/样式/断点改动,三端同一前端同一 binding:

- **桌面 GUI / 远程浏览器 / PWA**:同构路径已由单测 + 真实 DB 端到端覆盖;建议用户重开
  「欧普照明」会话复核不再错乱。

## 遗留(后续任务,不在本卡)

- codebuddy 同 turn 双写(131/132):harness 先发无 id 流再发带 id 终稿,内容级去重需要
  内容指纹,风险高于收益,暂不处理(渲染上已是两行独立内容,不再互相污染)。
- resume 重放本身(codebuddy 回放历史)如需在 UI 上隐藏,应走「重放抑制门」类 fork 的
  窗口机制,另行设计。

## 下一步

- 用户重开会话复核渲染。
