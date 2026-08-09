# 2026-08-09 CodeViewer scrollTop Map 跨 session key 碰撞修复(Review #24183)

## 起因

前端验收 Review #24181(`feat(codeviewer): per-file scrollTop 持久化`,commit
`662eba5` / worklog `2026-08-09-codeviewer-per-file-scroll-persistence.md`)时,
核查 `scrollPositions` Map 的 key 设计,发现一处**前提事实错误**导致跨 session
滚动位置泄漏。

## 根因

上一条 worklog 的「根因 / 设计」节里写了:

> 按文件键(`filename` = `EditorPane` 传入的 `file.path`,**跨 session 的 worktree
> 路径天然唯一**)记忆

这条前提**不成立**。核查数据源:

- `internal/chat/chat.go:1244` `SessionReadFile(sessionID, rel string)` —— 第二个参数
  名叫 `rel`,实现走 `s.cwdOf(sessionID)` 拿到该 session 的 worktree 根,再
  `fsview.ReadFile(root, rel)`。即 `file.path` 是**钉在 session cwd 的相对路径**
  (如 `src/App.tsx`),**不是**绝对 worktree 路径。
- `EditorPane.tsx:128` `filename={file.path}` 把这个相对路径透传给 `CodeViewer`。
- `CodeViewer` 的 `scrollPositions = new Map<string, number>()` 是 **module 级**,
  跨整个 app 生命周期存活,且 key 只用了 `filename`(相对路径)。

后果:**同一相对路径在不同 session 间会碰撞**。

- 同一项目的两个 session(各自 worktree、不同分支)都打开 `src/App.tsx` → session A
  滚到 500 行,切到 session B 同名文件 → restore 到 500 行(从 A 泄漏过来)。
- 不同项目碰巧同名相对路径(如都有 `README.md`)同理。

违反 §5.3「外部事实是设计前提时,先验证再动手」——前提(`file.path` 全局唯一)没有
先验证就写进了设计。

严重度:**低**(只是滚动位置错乱,用户再滚一下即可;无数据损坏 / 崩溃),但前提错误
必须纠正,且修复成本极低。

## 改法

让 key 带 session 维度,使其全局唯一:

- `CodeViewer` 新增可选 prop `scrollKey?: string`。Map 的 key 用 `scrollKey ?? filename`
  (保留 `filename` fallback,CodeViewer 作为通用组件仍可独立使用)。JSDoc 明确要求:
  在多 context 共享同一 `filename` 时,caller **必须**传 context 唯一的 `scrollKey`。
- `EditorPane` 传 `scrollKey={`${sessionId}/${file.path}`}`(`sessionId` 来自
  `EditorPane` 已有 prop,`file.path` 是相对路径,二者复合全局唯一)。
- effect 依赖从 `[filename]` 改为 `[posKey]`(`posKey = scrollKey ?? filename`),
  语义不变(本应用里 EditorPane 的 loading gate 在换文件时 unmount/remount CodeViewer,
  单实例内 posKey 恒定,dep 仍只在 mount 触发 restore、unmount 触发 dump)。
- 更新 `CodeViewer` 顶部与 effect 处的英文注释,删掉「keyed by filename」字样,改为
  「callers must ensure the key is unique across all live contexts, since the Map
  is process-global」。

## 未处理(已知局限,非本次范围)

- **Map 无 session 关闭驱逐**:session 关闭后其 key 永久驻留(module 级、无清理)。
  桌面长期运行下每个「曾访问过的 (session,相对路径)」占一条(string + number),量级
  最多几百~几千条,可忽略;要做需把 close 信号接到 CodeViewer module,超出本次小修范围,
  暂不做(遵循 §3.1 阶段化、§5.3 Less is More)。

## 其余验收项(通过)

- **CSS `-webkit-user-select: text !important`**:加在 `.cv-line` 与 `.cv-code`。
  核查级联——`.cv-no`(行号)自身 `user-select: none` 是子元素直接声明,优先于父级
  inherited 值,故行号仍不可选(多行选择时被 WebKit 排除出选区,复制得到干净代码)。
  `-webkit-` 前缀 + `!important` 对老 WKWebView 的选中失效是合理兜底。✅
- **highlightLine 与 restore effect 协调**:highlightLine effect 定义在前、deps
  `[highlightLine,total,virtual,lines]`;restore effect 定义在后、deps `[posKey]`。
  mount 时前者先跑(有合法目标行则滚过去),后者后跑并 `hlActive` 时跳过 restore;
  纯 line-hint 变化(同文件内点不同行)不触发 restore(其 dep 未变)、也不触发其
  cleanup(不 dump),正确。✅
- **TS 类型**:`posKey` 经 truthiness guard 后窄化为 string,`Map.get/set` 无类型问题。
- **无 i18n / a11y / 新交互元素变更**;`data-testid` 未改。

## 改了哪些文件

- `frontend/src/components/CodeViewer.tsx`(新增 `scrollKey` prop + 注订正)。
- `frontend/src/components/EditorPane.tsx`(透传 `scrollKey`)。

## 验证

- worktree 补 `bun install`(364 packages)+ `wails3 generate bindings`(293 / 2 / 103
  / 19 models)以让 `tsc` 解析 binding 导入。
- `bun x tsc --noEmit`:**0 错误**(改动前后均通过,改动本身未引入类型问题)。
- 滚动持久化属 DOM 行为,单测难稳定断言 scrollTop;跨 session 隔离同理,留 server 模式
  (§5.5)做:两 session 同名文件 → A 滚到 N → 切 B → 断言 B scrollTop ≠ N(为 0)。

## 下一步

- 无。纯前端渲染层小修,无后端 / 协议影响。
- 上一条 worklog(`2026-08-09-codeviewer-per-file-scroll-persistence.md`)的「天然唯一」
  表述已知错误,以本条为准;不回改历史 worklog(忠实记录当时的判断),纠正放在本条。
