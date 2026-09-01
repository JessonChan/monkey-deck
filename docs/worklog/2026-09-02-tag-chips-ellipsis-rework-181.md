# #181 标签 chip ellipsis 硬切返工(inline-flex 上 text-overflow 不生效)

日期:2026-09-02
状态:完成(代码 + 测试 + 渲染探针实证)
评审来源:`docs/worklog/2026-09-02-tag-chips-review-181.md`(#28953,REJECT,blocking 1 项)

## 起因

#181 首版(`eadffd2`)把 #150 原版 chip CSS 原样复活,但原版自带潜伏缺陷:`.session-tag-chip` 同时声明 `display: inline-flex` 与 `text-overflow: ellipsis`。`text-overflow` 按 css-overflow-3 **只适用于 block container**;inline-flex 让 chip 自己成为 flex container,内部文本是 anonymous flex item,省略号被忽略——长标签名只剩 `overflow: hidden` 硬切,无「…」截断信号。评审以 headless Chrome 像素级探针实证(A=inline-flex 现行版硬切无「…」,C=inline-block 对照「…」正常),判定 D1/D6 部分不达标,打回返工。

## 改法(2 行 CSS + 门禁锚定,零 markup 改动)

`frontend/src/index.css`:

- `.session-tag-chip`:去 `display: inline-flex; align-items: center`,改 **`display: block`**;`line-height: 12px` → **`14px`**。父容器 `.session-item-main` 本就是 `flex + align-items: center`(index.css:281),chip 作为 flex item 被垂直居中,块内 `line-height: 14px` 让 10px 字形在 14px border-box 内居中——行高纪律(盒高 14px 不破)不变量保持。省略号机制与既有 `.session-label`(span flex item,blockify 成 block container,ellipsis 正常)同构。
- `.session-tag-more`:同改 `display: block` + `line-height: 14px` 保持家族一致(内容恒为「+N」无截断风险,纯一致性;1px 边框 border-box 下内容盒 12px,14px 行盒字形仍落在内容盒内,无渗色)。
- 注释改写:记下「text-overflow 只适用于 block container(css-overflow-3),inline-flex chip 会硬切无字形」的根因,防回退。

`frontend/src/components/Sidebar.tags.mount.test.tsx`:

- test 1 CSS 门禁补锚定断言(评审点名的漏检位:原门禁只断言规则在场/离场,没钉 display——「tsc 绿≠行为通电」):提取 `.session-tag-chip`/`.session-tag-more` 规则体,断言含 `display: block`、不含 `inline-flex`,chip 规则另钉 `text-overflow: ellipsis` 在场。防将来有人把 display 改回 inline-flex 而静默回归硬切。

markup(Sidebar.tsx)零改动;D2-D5(cap 3 +「+N」/槽位/色点删除/纯展示)评审已判通过,不触碰。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/index.css` | `.session-tag-chip`/`.session-tag-more` 改 `display: block` + `line-height: 14px`;注释记根因 |
| `frontend/src/components/Sidebar.tags.mount.test.tsx` | test 1 CSS 门禁补 display/ellipsis 锚定断言(5 条 expect) |

## 验证

- **渲染探针(像素级,headless Chrome `--screenshot`,3x scale)**:复刻 app 上下文(全局 `* { box-sizing: border-box }` + `.session-item-main` flex 父容器),新 CSS 长 EN 标签渲染 `a-very-lon…`、长中文标签渲染 `这是一个特…`——**「…」字形在场**;同页对照 inline-flex 旧 CSS 仍硬切无字形(复现被拒行为);`+2` more chip 正常。DOM 量化:新 chip `display: block` / 72×14px / `scrollWidth > clientWidth`(截断生效);旧 chip computed display 为 `flex`。探针产物在 /tmp,不入库。
- 定向:`bun test src/components/Sidebar.tags.mount.test.tsx` → **9 pass / 0 fail**(85 expect,门禁断言 +5)。
- 全量:`bun test --isolate` → **542 pass / 0 fail**(76 文件,7903 expect,较评审基线 +5 = 新门禁断言);`bunx tsc` → 0 错误。
- 无障碍/tooltip 不变:chip tooltip = 标签名(省略后露全名的通道),more chip tooltip = 全量列表,react-tooltip 全族(§4.5)。

三端说明(§4.7):纯 CSS 展示片段,无 `isRemoteClient()` 守卫/事件通道/断点触碰,三张脸同一渲染分支;省略号行为为规范级跨引擎结论(css-overflow-3 适用范围,WebKit 同 Chromium),桌面 GUI/远程浏览器/PWA 的长标签名均从硬切变为「…」+tooltip,属同一预期修复,无定向改动。桌面 webview(macOS WebKit)像素手感留人实测。

## 下一步

- 重新提审(fe-reviewer):核对 D1/D6 + 门禁断言。
- 不 push、不关 issue;由 orchestrator 处置。
