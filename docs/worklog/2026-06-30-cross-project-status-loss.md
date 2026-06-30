# 2026-06-30 切项目导致他项目进行中 session 丢失「生成中」状态

## 现象
在项目 A 起对话 s1 并开始回复(s1 处于 prompting/生成中),此时点项目 B 起一个新对话 ——
A 的 s1 虽然仍在持续输出消息,但状态错了:侧栏状态点 / 对话面板状态条不再显示「生成中」,
落到「空闲/空白」。切回 A 再点 s1 也是错的。

## 根因(纯前端,`frontend/src/App.tsx`)
`selectProject`(点项目行 → `Sidebar.handleProject` → `onSelectProject` = `selectProject`)
**切项目时清空了全部 per-session 缓存**:`setStatusBySession({})` / `setItemsBySession({})` /
`setStatusDetailBySession` / `setPermissionBySession` / `setUsageBySession` /
`setHasMoreBySession` / `setLoadingMoreSession` / `setQueueBySession` / `setDraftBySession` /
`setAttachmentsBySession` / `setMentionsBySession` / `loadedSessionsRef` / `oldestSeqRef` 全清。

这清空直接抹掉了 s1 的 `statusBySession[s1] = "prompting"`。而后端一轮对话里
`prompting` 只在 turn 开始时发一次(`internal/chat/chat.go:1034`),直到 turn 结束才发
`idle`(`chat.go:1233`)。所以清空后**没有任何新 status 事件能把 s1 的 prompting 补回来** ——
整个漫长生成期它停在 `undefined → "empty"`,UI 显示「空闲/空白」,但 `chat:event` 仍在按
sessionId 往 `itemsBySession[s1]` 累积(所以消息照流、状态不对)。

**侧栏可同时展开多项目**(`Sidebar.tsx` 遍历 `props.projects`,各项目 session 都从同一个
`statusBySession` 取状态点),所以这一清空会同时打掉所有可见项目里进行中 session 的状态点,
不止当前选中的那个。

### 为什么会有这段清空(历史)
`06e1677`(2026-06-29)`fix(chat): 切项目清空 per-session 缓存` 引入,为修「幽灵 spinner」:
切回旧项目 session 时残留的 `streaming:true` 思考块永不消失。但当时的**根因是 `applyEvent`
按 `selectedSessionId` 过滤事件**(切走就把 turn 结束的 `idle` 事件丢了 → 没人去 finalize
streaming 块)。后来 `applyEvent` 已改成**按事件所属 sessionId 写缓存、不再过滤 selectedSessionId**
(`App.tsx:146-147`「不再过滤 selectedSessionId」),`chat:status`/`chat:permission` 同理。
事件不再因切走而丢失 → 幽灵 spinner 在源头已修好 → 这段清空变成**多余且有害**(抹掉合法的
进行中状态)。

## 改法
1. **`selectProject` 不再清 per-session 缓存**,只做:`setSelectedProjectId` +
   `setSelectedSessionId(null)` + `refreshSessions`。理由:per-session 缓存按 sessionId
   全局唯一隔离,事件处理器都按事件所属 sessionId 写,与当前选中无关;`selectedSessionId=null`
   时派生视图(`items`/`status`/`permission`…)全空,旧项目残留不会泄漏进新项目视图。这正是
   文件顶部声明的设计意图(「切走再切回,进行中的流式/用量/状态/权限都保留在各自缓存里」)。
2. **`chat:status` 处理器在 `"closed"` 时也 finalize streaming items**(原只 `idle`/`error`)。
   idle reaper 关 session 会 emit `"closed"`(`chat.go:884`),此前不在 finalize 条件里 →
   被回收的 session 若残留 streaming 块会变幽灵 spinner。这是去掉清空后的**防御性补强**,
   彻底关掉 `06e1677` 当年想堵的那个口子。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | `selectProject` 删 13 行 per-session 清空(+注释改写,说明为何不清);`chat:status` 处理器 finalize 条件加 `\|\| s.status === "closed"` |

Go 零改动 —— 无需 `wails3 gen bindings`。

## 验证
- `npx tsc --noEmit`(frontend)exit 0。
- 逻辑审查:
  - 切项目后 `selectedSessionId=null` → `status`/`items`/`permission` 等派生值全 fallback 空,
    新项目视图不会显示旧 session 内容(无泄漏)。
  - 切回 A 点 s1:`openSession` 见 `loadedSessionsRef` 有 s1 → 不重读 DB、保留内存缓存;
    `statusBySession[s1]` 仍是 `prompting`(还在跑)或 `idle`(已结束),正确。
  - 侧栏多项目展开时,各 session 状态点持续从 `statusBySession` 取,切项目不再打掉他人状态。
  - `"closed"` finalize:idle reaper 回收 session 后,其内存 items 里 agent/thought 的
    `streaming` 被清,重开不残留幽灵 spinner。
- grep 确认 `setStatusBySession({})`/`setItemsBySession({})` 这类清空**全局仅此一处**
  (已删),无其它路径再抹状态。

## 权衡 / OPEN
- **未做实机验证**:无前端测试基建(无 vitest/testing-library,`package.json` 无 test 脚本),
  且该逻辑依赖 Wails3 运行时事件 + React 状态机,需 `wails3 dev` 实跑。复现步骤:① A 项目起
  s1 发一条让它开始长回复;② 点 B 项目起新对话;③ 观察 A 的 s1 侧栏状态点应保持「生成中」
  (修复前变空闲);④ 切回 A 点 s1,状态条应仍是生成中/回复中。
- **未引入前端测试**:为单条 1 行概念修改(停止清空)+ 1 处防御性 finalize 从零搭一套
  vitest+testing-library+mock `@wailsio/runtime` 是越界扩范围(且本身是另一桩原子改动)。
  若团队决定建前端测试基建,本场景可作首个用例(`selectProject` 不抹他人状态)。
- **缓存内存增长**:不再切项目清空 → per-session 缓存会随访问过的 session 累积。受 idle
  reaper(关 session)与正常使用量约束,非正确性问题;如需,将来可加 LRU 上限。
- **auto-continue 仍只对当前可见 session 生效**(`drainQueue` 用 `selectedSessionIdRef`):
  切走时 s1 队列不会自动续发 —— 这是既有限制,非本次 bug,未动。

## 提交说明
```
fix(frontend): 切项目不再清空 per-session 缓存,修复他项目进行中 session 丢失「生成中」状态
```
```
docs(worklog): 切项目状态丢失修复
```
(代码与文档分两个 commit,§6.2)
