# 2026-07-27 duration 改挂 agent 回复 msg-meta(从 user 移走)

## 起因

Task #23433 / 修正 #68。上一轮(5ba95a2 `feat(chat): user msg-meta 显示历时,删除
TurnDivider`)把 turn 持续时间(`.msg-dur`)挂到了 user 消息的 msg-meta。但需求 #68
**钉死:duration 必须挂 agent 回复 msg-meta,不许放 user 消息**——回合耗时是 agent 干活
花的时间,语义上属于 agent 的回复而非用户的提问。TurnDivider 时间已在上轮删除,本次只
处理 duration 归属错误。

## 改法

1. **duration 锚点从「user 消息」改为「该回合最后一条 agent 回复」**:`turnBounds`
   (Map<userIdx, {start,end}>)改为 `agentTurnDuration`(Map<agentIdx, durationMs>)。
   对每个 user 锚定的回合,扫描 `[start, endIdx]` 找最后一条 `type === "agent"` 的 item,
   把 `endTs - startTs` 挂到该 agent 下标。无 agent 段的回合(异常)自然不显示(graceful)。
   - 不变量不变:turn start = user ts;turn end = 该回合最后一条 item ts(persistTurn 回合
     结束统一写库,§5.3 尊重数据源);仅已结束回合算 duration(prompting 末回合无 end)。
2. **render loop**:删掉只为 user 行算 duration 的 `userItem`/`tb`/`durationMs` 三行;改为
   仅 `row.kind === "agent"` 时查 `agentTurnDuration.get(row.first)`。
3. **ChatRow**:
   - user 分支删去 `formatDuration` + `.msg-dur` 段(msg-meta 只剩时间 + 复制)。
   - agent 分支新增 `formatDuration(durationMs)` + `.msg-dur` 段(msg-meta:时间 · 历时 + 复制)。
4. CSS 零改动:`.row-agent:hover .msg-actions` 早已存在;`.msg-dur { opacity: 0.7 }` 复用。

## 多 agent 段语义

一个回合可能有多条 agent 消息(thought→tool→agent→tool→agent 交错)。duration 挂**最后一条
agent**(最终回复)——它是 turn 的视觉收尾,也是离 turn end 最近的 item。中间 agent 段不挂,
避免一个回合出现多个耗时。测试覆盖此场景(新增第 5 个用例)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - `turnBounds` → `agentTurnDuration`(键改为 agent item 下标,值改为 durationMs)。
  - render loop:`durationMs` 仅 agent 行查 map 传入。
  - ChatRow user 分支:删 dur 段;agent 分支:加 dur 段。
- `frontend/src/components/msgmeta.duration.mount.test.tsx`:
  - 断言选择器全从 `[msg-user] .msg-dur` 改为 `[msg-agent] .msg-dur`;头部语义注释同步。
  - 多轮用例补「user 消息底部无 dur 段」断言(钉死 #68 不许放 user)。
  - 新增第 5 个用例「多 agent 段:duration 只挂最后一条 agent 回复」。
- `docs/worklog/2026-07-27-duration-on-agent-not-user.md`:本条。

## 验证

- `bun install`(worktree 无 node_modules)。
- `wails3 generate bindings`(补齐前端 bindings,否则 tsc 报 TS2307,与本次改动无关)。
- `npm run build`(`tsc && vite build --mode production`):**通过**(仅既有 chunk size 警告)。
- `bun test src/components/msgmeta.duration.mount.test.tsx`:**5/5 通过**(含新增多 agent 段用例)。

## 下一步

- 实机抽验(`wails3 dev`,macOS WebKit):agent 回复底部出现 `时间 · 历时 + 复制`,
  回合结束后历时出现,prompting 中无历时;user 消息底部只剩 `时间 + 复制`,无历时。
