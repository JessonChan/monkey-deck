# 2026-08-09 CodeViewer per-file scrollTop 持久化 + 强制可选中

## 起因

Task #24182 两个前端问题:

1. **文件 tab 切走再切回,CodeViewer 总是回到顶部**——阅读长文件滚到中间,切到别的
   文件 tab(或回 chat)再切回来,滚动位置丢失,体验割裂。
2. **代码区在某些 WebKit 下选中不了**——`.cv-line` / `.cv-code` 只声明了无前缀的
   `user-select: text`,WKWebView(Wails3 macOS)对无 `-webkit-` 前缀的 `user-select`
   不一定买账,导致代码正文无法用鼠标拖选。

## 根因 / 设计

### 1. 滚动位置丢失

`EditorPane` 的 loading gate(`loading` 为真时不渲染 `CodeViewer`,改显 loading 占位)在
每次切换文件 tab 时**先 unmount 旧 CodeViewer、fetch 完再 mount 新 CodeViewer**——组件
内状态天然不跨实例存活,滚动位置随之丢。需要把滚动位置存到**组件外**(module 级),
按文件键(`filename` = `EditorPane` 传入的 `file.path`,跨 session 的 worktree 路径天然
唯一)记忆,unmount 时 dump、mount 时 restore。

与既有 `highlightLine` 的 `useLayoutEffect` 协调:

- 那个 effect 在文件里**定义在前**,同一 commit 里先跑;有合法 `highlightLine` 时它
  负责滚到目标行,必须让它赢。
- 新增的 restore effect 定义在后,跑在其后;只在**没有**激活的 highlight 时才 restore。
- 两者都用 `useLayoutEffect`:对 filename 变化,React 先跑旧 cleanup(dump)再跑新
  setup(restore),且都在 paint 前——既保证 dump 读到的是「restore 之前的真实值」(同
  一实例 filename 变化的边缘场景),又无可见闪烁。
- 依赖故意只写 `[filename]`:restore 只在 mount / 换文件时触发,不在每次 highlight /
  resize 变化时重跑(避免无谓地把用户当前滚动重置回旧值)。`highlightLine`/`total`
  在闭包里读取当前值即可,不需要进依赖;附 `eslint-disable-line` 注明意图(项目无
  eslint gate,留作自说明)。

### 2. 选中失效

补 `-webkit-user-select: text !important` 到 `.cv-line` 与 `.cv-code`(保留原无前缀
`user-select: text` 兼顾标准引擎);`!important` 压过任何上游 `user-select: none` 的
级联,确保代码正文在所有 webview 引擎可选中。

## 改法

- `frontend/src/components/CodeViewer.tsx`:
  - 新增 module 级 `const scrollPositions = new Map<string, number>()`(key = filename)。
  - 在 `highlightLine` 的 `useLayoutEffect` 之后新增一个 `useLayoutEffect`:setup 里
    `!hlActive` 时按 `filename` restore `el.scrollTop`;cleanup 里把当前 `el.scrollTop`
    dump 回 Map。
- `frontend/src/index.css`:`.cv-line` 加 `-webkit-user-select: text !important`;
  `.cv-code` 同样加(行尾追加,与既有 `user-select: text` 并存)。

## 改了哪些文件

- `frontend/src/components/CodeViewer.tsx`
- `frontend/src/index.css`

## 验证

- worktree 缺生成产物,补 `bun install` + `wails3 generate bindings`(293 packages /
  2 services / 103 methods / 19 models)以让 `tsc` 解析 binding 导入。
- `npm run build`(= `tsc && vite build`):**通过(0 错误)**,只有既有的 chunk 体积
  warning(与本改动无关)。改动文件本身无类型错误。
- `bun test`:149 pass / 31 fail——31 个失败全为预存的 happy-dom 环境问题(McpChip /
  msg-meta / ChatView 虚拟化 / NewSessionModal 等,见 `2026-08-03-sidepanel-tab-switch-
  state-loss.md` 已记录),与本次改动无关;CodeViewer 无现有单测。
- 滚动持久化属 DOM 行为,单测里难以稳定断言 scrollTop;若后续要覆盖,走 server 模式
  (§5.5)+ 浏览器驱动:开文件 tab → `el.scrollTop = N` → 切 chat → 切回 → 断言
  scrollTop ≈ N。

## 下一步

- 无。纯前端渲染层小修,无后端 / 协议影响。
- 若未来 CodeViewer 被复用到「同实例 filename 不变但 content 异步到达」的场景,可把
  `total` 加入 restore 依赖以在内容就绪后再次 restore;当前 `EditorPane` mount 时
  content 已就绪,不需要。
