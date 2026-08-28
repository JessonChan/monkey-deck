# #28002 review #28001 前端面复审——tabbar ctx-menu no-drag 修复:APPROVE

## 起因

对 #28001(dc1234b,「ctx-menu 声明 no-drag」)的前端面复审,即 #28000 review #156 判定的 P2 一行修复的终验。

## 结论:**APPROVE**(静态 + 独立运行时探针全过,无新发现)

## 审查内容与结果

### 静态核验(全过)

1. **修法与处方一致**:`frontend/src/index.css` `.ctx-menu` 规则加 `--wails-draggable: no-drag;`(L419),带英文注释(§3.7 合规)。diff 仅此文件,7+/2-。
2. **无反制声明**:全仓 `--wails-draggable` 声明清单核过——菜单祖先链上唯一 drag 声明就是 `.tabbar`(L2979);无任何规则对 `.ctx-menu`/`.ctx-item`/`.ctx-submenu`/`.tabbar-context-menu` 再声明 drag。`.tabbar-context-menu` 无独立 CSS 规则,全局 `.ctx-menu` 是唯一权威。
3. **继承覆盖完整**:`.ctx-submenu` 是 `.ctx-menu` 的 DOM 子节点(Sidebar.tsx L1060 嵌套在 L1022 菜单 div 内),继承 no-drag;全前端**零 `createPortal`**(grep 证实),所有菜单原位渲染,不存在绕过 `.ctx-menu` 规则的 portal 逃逸。全仓唯一挂在 drag 区内的菜单就是 tabbar 这个;Sidebar/ChatView/FilePanel 菜单在 drag 区外,no-drag 惰性。
4. **P4 注释算术已改正且数值属实**:dot 7px(L386 `.session-dot`)+ gap 6px(L2992 `.tabbar-tab`)+ close 16px(L3017 `.tabbar-tab-close`)+ narrow padding 4px(`0 2px`)= **33**,`min-width: 34` 兜底——两处注释与实测值一致。

### 独立运行时探针(不复用 coder 的复现页,自建全新探针实跑)

方法与 coder 一致但独立实施:临时 probe 页(vite dev + **真 `index.css`** + **真 `@wailsio/runtime` 3.0.0-alpha.94**,classic script 先于 ESM 在 `window.webkit.messageHandlers.external.postMessage` 装录制桩,CDP `page.mouse` trusted 事件,DOM 按 TabBar.tsx 原样嵌套)。探针文件已删除,未入库。

| 步骤 | 结果 |
|---|---|
| 计算值 | `.tabbar` = `drag`,菜单容器 = `no-drag`,菜单项 = `no-drag` ✅ |
| 阴性对照(条带空白按下 + 3px 漂移 + 松开) | 捕获 `["wails:drag"]`——桩活、拖拽区未被误伤 ✅ |
| 修复检查(菜单项按下 + 3px 漂移 + 松开) | **零** `wails:drag`,click 落位(clicks=1)✅ |

阴性对照先行是本探针的方法论关键:它证明「零 invoke」是有意义的信号而非桩失灵。

### 测试 / 构建

- 全量 `bun test --isolate`:**415 pass / 0 fail**,与 #28001 worklog 记载一致。
- `npm run build`(tsc + vite)通过(chunk >500kB 警告系既有)。
- **环境引导坑(非代码缺陷,记档)**:新 worktree 首跑 44→5 fail 全是缺生成物——需 `bun install` + **仓库根目录**跑 `wails3 generate bindings`;在 `frontend/` 子目录跑会错误输出到 `frontend/frontend/bindings` 且报 0 services。

### 三端(§4.7)

| 端 | 结果 |
|---|---|
| 桌面 GUI | 探针走的就是 GUI 同一份 runtime 代码 + WKWebView 传输通道桩(Chromium 引擎);根因信号(计算值/invoke)已实证斩断。真原生拖窗循环无 GUI 宿主驱动不了,边界如实留档(与 coder 记载一致)。 |
| 远程浏览器 | 本探针即在 Chromium 实跑 = 浏览器端引擎条件:计算值正确、点击落位;no-drag 区外惰性,零回归。 |
| PWA | `.tabbar { display: none }`(≤768px,L3300)本就不渲染 TabBar;其余 ctx 菜单均在 drag 区外。 |

### 反模式扫(类型补丁)

本 diff 零新增字段/prop;CSS 属性的「消费端」= Wails runtime `mousedown` 捕获期的 `getComputedStyle` 读取——已由探针端到端实证通电(属性值 → canDrag=false → 零 invoke),非「声明了没人读」。

#28000 留档 P3 两项(窄窗 scroll-into-view、tab 键盘可达性)仍 OPEN,不属本卡,不阻塞。

## 下一步

- #156 可按「P2 已修 + 复审过」收口;P3 两项待专门 a11y/UX 卡。
- 同类 drag 区验证一律以「wails:drag invoke 捕获 + 阴性对照」为准(纯浏览器吞 click 的旧说法已废弃)。
