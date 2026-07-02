# 2026-07-02 长会话渲染优化:content-visibility(浏览器原生虚拟化)

## 起因
长会话(几百~上千条 markdown 消息)渲染慢、滚动卡顿。DOM 节点随消息数线性增长,layout/paint 开销大。

## 探索过程(弯路)
1. **react-virtuoso(失败)**:动态高度虚拟化,但 Virtuoso 的 `atBottomStateChange` 首屏必报 false → `followOutput`/`autoscrollToBottom` 全失效 → 不贴底、FAB 误亮、流式不跟随。反复调 5 轮仍未解决,rollback。
2. **自实现虚拟化(失败)**:保留原生滚动逻辑,只换渲染层。动态高度测量导致 `totalHeight` 跳变 → 滚动条明显跳动。rollback。
3. **content-visibility(成功)**:浏览器原生渲染优化,零 JS 改动。

## 根因反思
虚拟化的复杂度(高度测量、滚动控制、API 竞态)全是代价。content-visibility 把这些交给浏览器引擎——零 JS、零 bug、6 行 CSS。违反了 §5.3「先搜后写」「成熟/原生方案优先」:一开始就该搜"browser native rendering optimization",而不是钻进虚拟化兔子洞。

## 改法
CSS `content-visibility: auto` + `contain-intrinsic-size: auto 120px`:
- `content-visibility: auto`:屏幕外元素自动跳过 layout/paint,到视口附近才渲染(浏览器原生"虚拟化")。
- `contain-intrinsic-size: auto 120px`:`auto` 关键字让浏览器记住元素上次实际高度,跳过渲染时用记忆值占位 → 滚动条不跳。

选择器:`.row / .thought-block / .tool-card / .tool-group`(每条消息的顶级容器)。不再扩展——这些已覆盖 DOM 最重、数量最多、最常在屏幕外的元素;子元素被父级的 contain 包裹无需重复;轻量元素(turn-divider/permission/typing)收益为零。

## 改了哪些文件
- `frontend/src/index.css`(+6 行 CSS,零 JS 改动)

## 验证
- `bun run build`:成功(620KB,纯 CSS 改动)。
- 用户实测:渲染速度明显提升,滚动流畅,所有原有行为(贴底跟随/切 session/loadMore/FAB)零 bug。
- 兼容性:Baseline 2024(Safari 18+/Chrome/Firefox 全支持);Wails3 macOS WebKit + Win WebView2 覆盖。

## 下一步
- content-visibility 不卸载 DOM(内存收益不如虚拟化);若未来用户多 session 切换导致内存累积,再评估非活跃 session 回收。
