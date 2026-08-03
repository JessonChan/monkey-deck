# 2026-08-04 chat-select-and-cmdw-filetab.md

## 起因

两个用户报告的前端 bug:

1. **ChatView 无法选中文本**——鼠标拖选聊天区文字没反应。
2. **⌘W 总是关 session tab,不关当前 file tab**——开了文件预览 tab 后按 ⌘W,
   预期关掉文件 tab(内层),实际却把整个 session tab(外层)关了。

## 根因

### 1. 文本选中

`index.css` 全局 `body { user-select: none }`(L57,桌面应用防误选 UI 文字的常规做法)。
聊天内容层 `.chat-body`(滚动容器)/ `.chat-content`(虚拟化容器)/ `.cv-item`(虚拟化行)
都没有 `user-select: text` 覆盖。虽然单个气泡元素(`.bubble-agent`/`.bubble-agent *`/
`.bubble-user-body`/代码块等)各自带了 `user-select: text`,但选中体验仍割裂——气泡之间
的间隙、以及任何未被显式声明的子元素仍是 `none`,导致跨气泡 / 拖选常常断。

### 2. ⌘W 关错 tab

`App.tsx` 的 ⌘W handler(L1562-1574,改前)无条件 `closeTab(sid)`——它**不看当前激活的
file tab**。而 `closeFileTab`(L372-383)早就在(给 FileTabBar 的 × 按钮、EditorPane/
DiffPane 的关闭按钮用),只是 ⌘W 没接上。

次要问题:handler 的 `useEffect` 依赖是 `[isPopout, closeTab]`,若直接读 `activeFileTab`
闭包变量,捕获到的是 effect 注册时的值,按键瞬间可能是**陈旧的**(切了 file tab 但
`closeTab` 未变 → effect 未重订阅 → 读到旧值)。现有代码用 `selectedSessionIdRef`/
`openTabsRef` 这类 ref 解决同类「读最新值又不进依赖」的问题,照搬即可。

## 改法

### 1. CSS(一行)

`.chat-body` 加 `user-select: text`。`user-select` 是 CSS **继承属性**,设在滚动容器上
会级联到 `.chat-content` / `.cv-item` 及全部后代(气泡、代码块、工具输出……)。原本已
显式带 `user-select: none` 的**可交互摘要头**(`.tool-summary` / `.plan-summary` /
`.tool-group-summary` / `.code-toggle` 等)保持不变——它们带显式声明,优先级高于继承,
继续不可选(点它们是切换折叠,不是选文字)。即:正文可选、控件不可选,符合预期。

> 注:放在 `.chat-body`(而非 `.chat-content` / `.cv-item`)是因为它是整段聊天区的根滚动
> 容器,单一声明覆盖全部后代,且语义最清晰(「聊天正文区可选中」)。

### 2. ⌘W(file tab 优先)

- 新增 `activeFileTabBySessionRef`(镜像 `openTabsRef` / `selectedSessionIdRef` 模式),
  每次渲染同步 `activeFileTabBySessionRef.current = activeFileTabBySession`。handler 按键
  瞬间从 ref 读**最新**激活 file tab,避开 effect 闭包陈旧值。
- handler 分支:`aft = activeFileTabBySessionRef.current[sid]`;
  `aft && aft !== "chat"` → `closeFileTab(sid, aft)`(关文件/diff tab,回退 chat);
  否则 `closeTab(sid)`(关 session tab,仍在生成则弹 CloseTabDialog)。
- `useEffect` 依赖加 `closeFileTab`(稳定,`useCallback([])` 空依赖,不引发额外重订阅)。

行为表(与 editor ⌘W 惯例一致,内层 tab 先于外层):

| active          | ⌘W 行为                              |
|-----------------|--------------------------------------|
| `chat`          | 关 session tab(生成中弹 CloseTabDialog)|
| `file:<path>`   | 关该文件 tab → 回退 chat(只读预览,无 dialog)|
| `diff:s/u:path` | 关该 diff tab → 回退 chat(只读预览,无 dialog)|

## 改了哪些文件

- `frontend/src/index.css`:`.chat-body` 加 `user-select: text`(L386,一行)。
- `frontend/src/App.tsx`:
  - 新增 `activeFileTabBySessionRef`(L194-197,镜像现有 ref 模式 + 英文注释,§3.7)。
  - ⌘W handler(L1562-1584)改为 file-tab 优先分支,注释改英文,依赖加 `closeFileTab`。

## 验证

- `wails3 generate bindings`:成功(293 packages / 2 services / 103 methods / 19 models)。
  本 worktree 缺生成产物 `frontend/bindings`,补上以让 `tsc` 能解析 binding 导入。
- `bun install`:364 packages(fresh worktree 补 node_modules)。
- `bunx tsc --noEmit`:**通过(0 错误)**——两处改动类型干净,`closeFileTab` 已存在于作用域。
- 行为正确性:⌘W 分支复用既有的 `closeFileTab`(已被 FileTabBar × 按钮 / EditorPane /
  DiffPane 的 close 按钮实战验证过),逻辑与那些按钮一致;`activeFileTabBySessionRef`
  镜像 `openTabsRef` 等成熟模式,无新风险。

## 下一步

- 两个 bug 均为小修,无需新测试(前端无 ⌘W 现有测试基线;CSS 行为不可单测)。
- 后续若引入 ⌘W 的集成测试,用 server 模式(§5.5)+ browser 驱动:开文件 tab → 派发
  keydown → 断言 activeFileTab 回退 chat,而非关 session tab。
