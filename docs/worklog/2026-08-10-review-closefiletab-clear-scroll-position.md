# 2026-08-10 Review #24267 closeFileTab 清 CodeViewer scrollPositions 前端 (APPROVE, Task #24268)

**起因**:Task #24268 对 #24267(2 commit:`dafc798` 功能 + `bd34d17` worklog)做
Frontend Reviewer 端到端验收。改动纯前端(`CodeViewer.tsx` + `App.tsx`),无后端 /
binding 变更。

## 复审范围

- `components/CodeViewer.tsx`:新增 `clearScrollPosition(posKey)` 命名导出(thin wrapper
  over `scrollPositions.delete`,idempotent)+ JSDoc 说明 posKey 必须等于内部
  `scrollKey ?? filename`。
- `App.tsx`:import `clearScrollPosition`;`closeFileTab` 的 `setFileTabsBySession`
  functional updater 内先 `cur.find` 找被关 tab,仅 `closing?.kind === "file"` 时调
  `clearScrollPosition(`${sessionId}/${closing.path}`)`。

## 正确性 ✅

### posKey 对齐(本次修复的正确性关键)✅

三处逐字符核对:

| 位置 | 表达式 |
|---|---|
| `EditorPane.tsx:335`(写入) | `scrollKey={`${sessionId}/${file.path}`}` |
| `CodeViewer.tsx:180`(内部 key) | `const posKey = scrollKey ?? filename;` |
| `App.tsx:413`(驱逐) | `clearScrollPosition(`${sessionId}/${closing.path}`)` |

- EditorPane 传 `file.path`(FileTab.path);closeFileTab 用 `closing.path`(同一
  FileTab.path 字段)。**字符级一致**,错一位就清不到(残留)或清错(误删别人的)。✅
- `file.path` 是相对路径(worktree 内),`${sessionId}/` 前缀做 session scoping —— 与
  Task #24183 的 key 收紧一致,无跨 session 碰撞。✅
- CodeViewer 内部 `scrollKey ?? filename`:EditorPane 总是传 scrollKey,故走 scrollKey
  分支,filename fallback 不参与(closeFileTab 也不依赖它)。✅

### kind 守门(diff tab 正确跳过)✅

`if (closing?.kind === "file")` 守门:

- diff tab 渲染 DiffPane → DiffView,**从不写 CodeViewer 的 `scrollPositions` Map**
  (DiffView 无 scroll 持久化)。跳过 diff tab 清理无残留。✅
- 同一路径可同时作为 file tab + diff tab(s) 打开(`FileTabBar.tsx:16-18` 注释明示);
  kind 守门保证关 diff tab 不会误清 file tab 的 scrollTop(即使 DiffView 将来也进 Map,
  语义也不串)。✅
- `FileTab.kind` 类型 `"file" | "diff"`,TS narrowing 后 `closing.path` 访问合法。✅

### functional updater 内 lookup(deps [] 风格一致性)✅

`closeFileTab` 的 `useCallback` deps 是 `[]`,与同族 `openFileTab` / `openDiffTab` /
`selectFileTab` 风格一致 —— **闭包不持有 `fileTabsBySession`**,只有 functional updater
里的 `prev` 才是最新。把 `cur.find` 放 updater 内是**唯一能读到 fresh tab list 的位置**
(放外面只会读到首次 render 的快照,关错 / 漏清)。注释明确说明此意图。✅

### StrictMode double-invoke 安全 ✅

StrictMode dev 下 functional updater 会被调用两次。`Map.delete` 对不存在的 key 是 no-op
→ 删两次 = 删一次。注释「the delete is idempotent so a StrictMode double-invoke of the
updater is harmless」正确覆盖此点。✅

### TypeScript 类型安全 ✅

- `clearScrollPosition(posKey: string): void` —— 纯 string 入参,无 `any` / 无 `as`。✅
- `closing?.kind === "file"` 正确 narrowing FileTab 联合类型。✅
- `bun x tsc --noEmit`(gen bindings 后):**0 错误**。✅

### 无类型补丁反模式(§5.3)✅

`clearScrollPosition` 是纯函数导出,**全链路有消费端**(`App.tsx:413` 调用),
非「字段加了没人用」。无新增 prop / state 字段,无 dangling 类型。✅

### i18n ✅

纯逻辑改动(scroll position 是 DOM 行为),**无新增 user-facing 字符串**,无 i18n key
变动。zh/en 无影响。✅

## 观察项(非阻塞,不改)

### #1 state updater 内做 module 级副作用(理论纯度)

`clearScrollPosition(...)` 是 module-level mutation,放在 `setFileTabsBySession(prev => ...)`
的 functional updater 内执行。React 的 updater 纯度指引建议 updater 应为纯函数 —— 并发渲染
下 React **可能**调用 updater 后丢弃该次 render 的结果(speculative render)。若 updater
执行但 state 未 commit,会出现「scroll position 已清但 tab 未移除」→ 重开该文件丢失 scrollTop。

**严重度:很低**。(1) 唯一后果是丢失一个 scroll 位置(非数据损坏 / crash);(2) 作者明确
aware StrictMode(concurrent 前身)并文档化;(3) 副作用 genuinely idempotent;(4) 纯净替代
方案(`fileTabsBySession` 入 deps → 改 callback identity、偏离同族风格;或 ref 持有最新值 →
更多代码)trade-off 更差。**不阻塞,记为可选讨论**。

### #2 session 整体关闭 / 删除仍不清(已知 out-of-scope)

`closeFileTab` 只清单 tab 关闭。session close / delete 走 `setFileTabsBySession(drop)`
两处,**不遍历清**该 session 所有 file 的 scrollTop → Map 仍残留(session 关闭场景)。
worklog「下一步」明确记此为后续任务范围、接入点已指明(`setFileTabsBySession(drop)` 两处)。
**本次范围正确收窄,不阻塞**。

## 验证(acceptance gate)

1. `cd frontend && bun install` → 364 packages。
2. `wails3 generate bindings` → 293 / 2 / 106 / 19(让 tsc 解析 binding 导入)。
3. **`cd frontend && bun x tsc --noEmit`**:**0 错误**。✅
4. **`cd frontend && bun test --isolate`(全量)**:219 pass / 5 fail。5 fail 全在
   `NewSessionModal.mount.test.tsx`(workdir mode / base-ref selector / quick picks),
   与 CodeViewer / App.closeFileTab **完全无关**(NewSessionModal 不 import 这两处的
   改动路径)。worklog 亦记「stash 本次改动后同样 fail」。**无新增失败 = 无回归**。✅

滚动持久化 / 清理属 DOM 行为,jsdom 无真实 layout 难稳定断言 scrollTop;posKey 对齐的正确性
靠代码逐字符核对(EditorPane scrollKey ↔ closeFileTab 构串)保证,与作者 worklog 判断一致。

## Verdict:APPROVE

改动最小、聚焦:posKey 三处字符级对齐(本次修复的命门)、kind 守门正确跳过 diff tab、
functional updater 内 lookup 是 deps [] 风格下读 fresh list 的唯一正确位置、StrictMode
double-invoke 因 idempotent 无害、tsc 0 错、无类型补丁反模式、无 i18n 影响、无回归测试失败。
两项观察(updater 纯度理论问题 / session 关闭批量清)均非阻塞且已文档化。建议合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-review-closefiletab-clear-scroll-position.md`(本条,新增)。
