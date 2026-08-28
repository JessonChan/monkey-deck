# #28001 修复 tabbar 右键菜单继承 drag 区致微动拖窗(#156 review P2)

## 起因

#28000 对 #156 的前端终审判定 NEEDS CHANGES:P2——TabBar 右键菜单(`.ctx-menu.tabbar-context-menu`)整个落在 `.tabbar` 拖拽区内,菜单项点击被窗口拖拽吞掉:触控板微漂移(≥1px)即变成拖窗口,菜单项点击丢失。本卡落地 review 给出的一行修复 + 顺手项 P4。

## 根因(逐条在本 worktree 实证,非转录)

1. `.tabbar` 声明 `--wails-draggable: drag`;TabBar 把右键菜单渲染为 `.tabbar` 的 **DOM 子节点**(TabBar.tsx L174-201,`position: fixed` 不改变 DOM 祖先链);CSS 自定义属性按规范继承 → 菜单项计算值 `--wails-draggable == "drag"`。
2. `@wailsio/runtime` 3.0.0-alpha.94(本 worktree 实装版本,非 review 引用的 alpha.64,逻辑一致)`dist/drag.js`:window **捕获阶段**挂 `mousedown/mousemove/mouseup`;`primaryDown` 按 `getComputedStyle(target).getPropertyValue("--wails-draggable").trim() === "drag"` 判 `canDrag`;`onMouseMove` 对 `canDrag` **无位移阈值**——任意 mousemove 即 `dragging = true; invoke("wails:drag")` 启动原生拖窗。
3. review 声称的「`suppressEvent` 吞 click」需修正:**纯浏览器里 click 并不会被吞**——`mouseup` 的捕获监听 `update → primaryUp` 先把 `dragging` 置 false,浏览器**之后**才合成派发 click,`suppressEvent` 到场时 `dragging` 已是 false。真实症状链是:`invoke("wails:drag")` 到达 Go 后端 → 原生窗口拖拽接管鼠标(macOS tracking loop)→ 窗口在光标下移动、后续点击落空。也就是说**纯浏览器只复现根因(canDrag=true),不复现症状**;症状只在 webview 存在。

## 复现与验证方法(本卡的关键工程决策)

- **happy-dom 单测不可行(探针实证)**:happy-dom 的 `getComputedStyle` 能解析**元素自身声明**的自定义属性(`.tabbar-tab` → "no-drag" ✅),但**不解析继承值**(菜单项 → "")。即单测在修复前也会得 `"" ≠ "drag"` 而 trivially 通过——测的是模拟器缺陷不是本 bug。故复现走真实浏览器引擎。
- **让不可见的 invoke 可见**:`system.js` 的 `invoke` 在模块加载期选传输通道;macOS WKWebView 通道是 `window.webkit.messageHandlers.external.postMessage`。复现页在该通道上装**录制桩**(classic script 先于 ESM 执行),runtime 绑定的就是桩——捕获到 `"wails:drag"` 消息 = 「webview 里原生拖窗必将启动」的**充分信号**。修掉 invoke 即斩断整条症状链(窗口不动 → 点击必落)。
- vite dev server + 真 `index.css` + 真 `@wailsio/runtime`,CDP `page.mouse` 真实输入事件(trusted events,真实 offsetX),按 TabBar.tsx 原样嵌套(`.tabbar` > `.ctx-menu.tabbar-context-menu` > `.ctx-item`)。

### 复现(修复前,实跑)

- 菜单项计算值 `"drag"` ✅(根因坐实);
- 按下菜单项 + 3px 微移 + 松开 → 捕获到 `["wails:runtime:ready", "wails:drag"]`——**invoke(wails:drag) 已发出**(webview 里即窗口微移);
- 对照:纯浏览器下同手势 click 照常触发(clicks=1),印证根因修正第 3 条。

### 修复后(实跑)

- 菜单项计算值 `"no-drag"`;同手势 **零** `wails:drag`;click 正常落在菜单项(clicks=1)。
- **阴性对照**:按下 `.tabbar` 条带空白区 + 微移 → `wails:drag` 照发——拖拽区本身未被误伤,修复严格限定在菜单。

## 改法

- 全局 `.ctx-menu` 规则加 `--wails-draggable: no-drag;`(一行,带英文注释说明缘由)。全仓唯一挂在 drag 区内的 ctx 菜单就是 tabbar 这个;no-drag 在 drag 区外是惰性属性,Sidebar/ChatView/FilePanel 的既有菜单零影响,并顺带保护未来再挂进 drag 区的菜单。`.ctx-submenu` 是 `.ctx-menu` 子节点,一并覆盖。
- P4 顺手项:`.tabbar-tab.narrow` 两处注释算术改正(dot 7 + gap 6 + close 16 + padding 4 = **33**,由 `min-width: 34` 兜底到 34;原文案写 "= 34px")。

## 改动文件

- `frontend/src/index.css`(`.ctx-menu` 加 no-drag + 两处 narrow 注释算术改正)

## 验证

- 复现/修复后/阴性对照三段浏览器实证(方法见上,vite dev + Chromium + CDP 真实鼠标事件)。
- `bun test --isolate` 全量:**415 pass / 0 fail**(58.77s)。
- `npm run build`(tsc + vite)通过(chunk >500kB 警告系既有)。
- Go 侧零改动,Go 门不适用。

### 三端(§4.7)

| 端 | 结果 |
|---|---|
| 桌面 GUI | 本修复的目标面。验证通道 = 与 GUI 完全一致的 runtime 代码路径 + WKWebView 传输桩(Chromium 引擎);**真原生拖窗本身无法在本环境驱动**(无 GUI 宿主,验证边界如实留档)。根因信号(计算值/`wails:drag` invoke)在两端是同一份代码。 |
| 远程浏览器(>768px) | 同一份 CSS/runtime 代码路径,已在 Chromium 实证;且实证纯浏览器本就不吞 click(根因修正),回归无损。 |
| PWA(≤768px) | `.tabbar { display: none }`(M2 既有)本就不渲染 TabBar 及其菜单,不受影响;其余 ctx 菜单均在 drag 区外,no-drag 惰性。 |

## 下一步 / OPEN

- #28000 留档的 P3 两项(窄窗活动 tab 无 scroll-into-view/溢出指示、tab 键盘可达性)仍 OPEN,不属本卡。
- review 的「浏览器端回归点击即可」验证指引经实证不成立(纯浏览器吞不了 click);后续同类验证以「wails:drag invoke 捕获」为准。
