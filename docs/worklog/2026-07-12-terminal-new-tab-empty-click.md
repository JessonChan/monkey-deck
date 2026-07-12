# 终端面板:点击空白处新建 + 加号移到最后一个 tab 后(Chrome 式)

## 起因
终端面板新增终端只能点工具栏最右的 `+` 按钮,位置远离 tab 区;用户希望像 Chrome 那样:
1. `+` 按钮紧跟最后一个 tab(随 tab 横向滚动)。
2. 点击 tab 条空白区域也能新建终端。

## 改法
- 把 `+` 按钮从 `.terminal-tabs-bar` 末尾移进 `.terminal-tabs-scroll`,排在 `tabs.map(...)` 之后(随 tab 一起滚动,Chrome 式)。
- `.terminal-tabs-scroll` 加 `onClick`:仅当 `e.target === e.currentTarget`(点中的是滚动容器本身,而非任何 tab/按钮子节点)时才调 `onNewTab`。
  - 这是基于不变量的判定(§5.3):用 DOM target 同一性区分「空白」与「tab/按钮」,不做「上一个事件是什么」的启发式假设。
  - 点 tab → tab 自己的 `onSelectTab` 触发,冒泡到容器但 target≠currentTarget → 不新建。
  - 点 `+` → 按钮自己 `onNewTab` 触发,冒泡到容器同样不命中 → 不重复。
- CSS 给 `.terminal-tabs-scroll` 加 `cursor: pointer`,空白区也有可点提示。
- 空状态文案改为「点击 + 或空白处新建终端」。

## 改了哪些文件
- `frontend/src/components/TerminalPanel.tsx`:`+` 按钮位置 + 滚动容器空白点击。
- `frontend/src/index.css`:`.terminal-tabs-scroll` 加 `cursor: pointer`。

## 验证
- `npx tsc --noEmit` 通过。
- `bun test`:14 pass / 0 fail。

## 下一步
- 手动在 wails3 dev 里点 tab 条空白处验证新建、点 tab 只切换、`+` 仍可用、tab 溢出时 `+` 随滚动。
