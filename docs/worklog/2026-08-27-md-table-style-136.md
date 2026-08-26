# 2026-08-27 — markdown 表格样式修复:th/td 边框+表头强化+横向滚动 wrapper(#136)(Task #24411)

## 起因

聊天里的 markdown 表格(GFM,经 remark-gfm 渲染)基本处于裸奔状态:

- `index.css` 里唯一规则是 `.bubble-agent table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }`——**单元格零边框、表头无任何强化**,表格淹没在正文里;
- **user markdown 气泡完全没有表格样式**:`.bubble-user-markdown` 不带 `.bubble-agent` 祖先类,上面那条根本罩不到;
- 宽表(列多/内容长)直接撑爆气泡与聊天列,没有横向滚动出路。

## 根因

`AgentMarkdown`(`frontend/src/components/ChatView.tsx`)是 agent 气泡与 user markdown **唯一的** markdown 渲染入口(react-markdown v9 + remark-gfm v4),但它从没定制过 `table` 组件;CSS 侧也只有一条 scoped 在 `.bubble-agent` 的 base 规则。两处都缺位。

## 改法

1. **渲染层**(ChatView.tsx):`AgentMarkdown` 的 `components` map 新增 `table: TableWrapper`——模块级稳定组件(compatible with streaming remount 不变量,components 身份节奏不变),把每个 `<table>` 包进 `<div className="md-table-wrap">`。
2. **样式层**(index.css):以 `.md-table-wrap` 为锚收敛成**一套**规则,替换原 `.bubble-agent table` 单行:
   - `.md-table-wrap { overflow-x: auto; margin: 8px 0 }` —— 横向滚动容器;
   - `th/td`:发丝边 `1px solid var(--sep-strong)`、`padding: 4px 10px`、`text-align: left`(纠正 th 浏览器默认居中);
   - 表头强化:`background: var(--elev)` + `font-weight: 600`。
   - 选择器不锚 `.bubble-agent` 而锚 `.md-table-wrap`,agent/user markdown 两个 surface 天然同源;wrapper 只做滚动不带边框圆角,规避 WebKit 下 collapsed border × border-radius 的边线叠加毛刺。
3. **测试**(新增 `ChatView.table.mount.test.tsx`,沿用 virtual mount test 的 stub 套路)压结构契约:
   - agent 气泡:table 必在 wrap 内、无裸 table、2×th / 4×td 骨架;
   - user fenced markdown:同一套 wrapper 生效(证明单套选择器设计成立);
   - 无围栏用户文本不走 markdown 路径 → 无误包(边界)。

改的文件:
- `frontend/src/components/ChatView.tsx`(TableRenderer 注入 + AgentMarkdown 触及注释转英文)
- `frontend/src/index.css`(#136 表格规则块)
- `frontend/src/components/ChatView.table.mount.test.tsx`(新增)

## 验证

- `bun install`(worktree 缺 node_modules)+ `wails3 generate bindings`(bindings 属中间产物不入库,worktree 需手动生成后才能跑前端测试)。
- `bun test --isolate`:**393 pass / 0 fail**(45 文件,含本任务新增 3 条 mount 测试)。
- `bun run build`(tsc + vite production):通过(chunk>500kB 警告为既有状态,非本次引入)。
- 三端说明(§4.7/§5.6,如实记录):本次改动落在共享前端 bundle 的聊天气泡内部,纯 CSS 标准属性(`overflow-x: auto` / `border-collapse`)与既有 design tokens,三端引擎均原生支持,M2 移动端反而是受益方(宽表由撑爆变滚动)。**桌面 webview / 远程浏览器 / PWA 的像素级目视复核未在本机执行**(worktree 内未起 wails3 dev),留待桌面侧冒烟确认。

## 下一步 / OPEN

- 桌面 GUI(Wails3 dev)目视过一眼实际表格观感;若嫌 --sep-strong 网格过弱/过强再调 token。
- 无 OPEN 阻塞。
