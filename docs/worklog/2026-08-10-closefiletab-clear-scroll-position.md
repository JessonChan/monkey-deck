# 2026-08-10 closeFileTab 清 CodeViewer scrollPositions(Task #24267)

## 起因

Task #24182 给 CodeViewer 加了 per-file scrollTop 持久化(module 级 `scrollPositions`
Map),Task #24183 又把 key 收紧成 `${sessionId}/${file.path}` 防跨 session 碰撞。但
当时的工作日志(`2026-08-09-codeviewer-scrollkey-session-scoping.md`「未处理」节)明确
记了一条已知局限:

> **Map 无 session 关闭驱逐**:session 关闭后其 key 永久驻留(module 级、无清理)。
> 要做需把 close 信号接到 CodeViewer module,超出本次小修范围,暂不做。

Task #24267 收尾这个尾巴:**关文件 tab 时清掉对应的 scrollTop 条目**,让 Map 不随
「打开过的文件」单调增长。

## 改法

三处对齐,核心是 **posKey 必须与 CodeViewer 内部计算一致**:

1. **CodeViewer 导出 `clearScrollPosition(posKey)`**(`frontend/src/components/CodeViewer.tsx`):
   命名导出一个 thin wrapper,内部 `scrollPositions.delete(posKey)`。idempotent(删不存在的
   key 是 no-op)。JSDoc 写清「`posKey` 必须等于 CodeViewer 内部 `scrollKey ?? filename`」,
   并指明 EditorPane 的 `scrollKey = ${sessionId}/${file.path}`。
2. **App.closeFileTab 调用它**(原 `App.tsx:400`,现因加注释下移):在 `setFileTabsBySession`
   的 functional updater 里,先 `cur.find(t => tabKey(t) === key)` 找到被关的 tab;仅当
   `closing?.kind === "file"` 时调 `clearScrollPosition(`${sessionId}/${closing.path}`)`。
   - **只清 file tab**:diff tab 渲染的是 DiffPane(`DiffView`),不进 CodeViewer 的 Map,
     清它没意义(diff tab 的 key 是 `diff:s|u:<path>`,路径相同但语义不同,故用 kind 守门)。
   - **posKey 对齐**:`${sessionId}/${closing.path}` 与 `EditorPane.tsx:335` 的
     `scrollKey={`${sessionId}/${file.path}`}` 逐字符一致 —— 这是本次修复的正确性关键,
     错一位就清不到(残留)或清错(误删别人的)。
   - **lookup 放 updater 内**:closeFileTab 的 `useCallback` deps 是 `[]`(与 openFileTab /
     openDiffTab 一致的风格),闭包不持有 `fileTabsBySession`,只有 functional updater 里
     的 `prev` 才是最新的。clearScrollPosition 是 idempotent 的 module 级副作用,StrictMode
     double-invoke updater 也无害(删两次 = 删一次)。
3. **import**:`App.tsx` 顶部加 `import { clearScrollPosition } from "./components/CodeViewer"`。

## 改了哪些文件

- `frontend/src/components/CodeViewer.tsx`:新增 `clearScrollPosition` 命名导出 + JSDoc。
- `frontend/src/App.tsx`:import + `closeFileTab` 内 lookup + 调用。

## 验证

- `cd frontend && bun install`(364 packages)+ `wails3 generate bindings`
  (293 / 2 / 106 / 19 models)以让 tsc 解析 binding 导入。
- `bun x tsc --noEmit`:**0 错误**。
- `bun run build`:**成功**(仅有既有的大 chunk 警告,与本次无关)。
- `bun test --isolate`:219 pass / 5 fail。5 个 fail 全在 `NewSessionModal` 测试,**stash
  本次改动后同样 fail** → 全部是预存在、与本次无关。
- `go build ./... && go vet ./...`:clean(本次无 Go 改动,仅确认门槛未破)。

滚动持久化 / 清理属 DOM 行为,jsdom 无真实 layout 难稳定断言 scrollTop(同
`2026-08-09-codeviewer-scrollkey-session-scoping.md` 的判断);posKey 对齐的正确性靠
代码核对(EditorPane scrollKey 与 closeFileTab 构串逐字符一致)保证,端到端留 server
模式(§5.5)做:开文件 → 滚 → 关 tab → 重开同名文件 → 断言 scrollTop 回 0(未 restore)。

## 下一步

- 无。纯前端渲染层小修,无后端 / 协议影响。
- 「session 整体关闭 / 删除时批量清其所有 file 的 scrollTop」仍不是本次范围(本次只做
  closeFileTab 单 tab 关闭)。若后续要做,接入点是 `App.tsx` 里 `setFileTabsBySession(drop)`
  的那两处(session close / delete),遍历被丢 session 的 file tabs 调 clearScrollPosition
  即可 —— 留给对应任务。
