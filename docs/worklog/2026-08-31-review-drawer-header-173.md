# review #28924 — #173 抽屉遮 header 前端面(1 个 P1,已顺带修复,APPROVE)

## 范围

审 `7cc8fa4`(代码)+ `aa1691c`(worklog),基于 main 最新。按「类型补丁」反模式从 CSS 定义点反向追消费端。

## 结论:APPROVE(带 1 个 P1 修复)

### ① 几何 ✓(修复后)

- `#sidebar`(3212)/`#side`(3237)/`.drawer-scrim`(3262):`top: calc(env(safe-area-inset-top) + 52px)` 恰 3 处(`grep -cF` 实测);52 来自 `.chat-header { height: 52px }`(index.css:527)。`.app` 的 `padding-top: env(safe-area-inset-top)`(3168)与 fixed 元素的视口坐标系对齐,top 含 env 无双重偏移。
- 抽屉 `padding-top: env(...)` 已删,≤768 块内计数 0;`padding-bottom`/`padding-left`(左)/`padding-right`(右)保留。其余三边 `inset: 0` 残留(501/858/2442)全在媒体块外,桌面规则未触碰。
- **P1(已修)**:`.drawer-scrim` 的 hunk 把 `position: fixed; inset: 0;` 整行替换成四个 offset,**`position: fixed` 被连带删掉**——scrim 是 `.app`(100dvh)的流内兄弟 button(App.tsx 2659),变 static 后:offset 失效、跌到视口下方不可见、`z-index: 55` 失效(static 且根容器非 flex)→ scrim 全灭 + 点按关闭失效。mount 测试(jsdom 无布局)与 tsc 都测不出 CSS 属性丢失,正是「类型补丁」在 CSS 上的形态。修法:index.css:3261 补回 `position: fixed;`。
- worklog aa1691c 第 16 行只记了「`inset: 0` → top/right/bottom/left」,漏记了 position: fixed 被删——根因即此叙述与 diff 脱节。

### ② toggle 语义 ✓

- App.tsx:2263 `toggleRightDrawer`(开→close/关→open),2514-2515 传 `rightDrawerOpen` + `onToggleSideDrawer` 给 ChatView,消费端齐全;`onOpenSideDrawer` 无残留引用。
- ChatView.tsx:767-779:按钮以 `onToggleSideDrawer` 存在性渲染,aria/tooltip 双态(开 `sidebar.collapse` / 关 `app.expandSidePanel`,两键 zh/en 都在:「收起侧栏」↔「展开右侧面板」),图标 `PanelRightClose`/`PanelRightOpen` 已 import。互斥语义保留(openRightDrawer 仍 setDrawerOpen(false))。
- mount 测试双态断言(关态 expand 键 + 点击触发回调;开态 collapse 键 + 点击仍触发;无 prop 不渲染),锚定在键名上,t 为 identity——键值同步由 locales.test.ts 兜底,可接受。

### ③ 回归面 ✓

- z 阶梯全未动:抽屉 60(3215/3240)、scrim 55(3263)、modal 65(3176)、panel-toggle 60(2045)、install-banner 50(3274);modal(65)> scrim(55)仍盖住。panel-toggle.left(≤768 top:13px)在 header 行内、scrim 起点之上,不受影响。
- diff 的 index.css hunk 全落在媒体块内(3160–3537),基础规则未动,`.side-drawer-btn` 桌面仍 display:none → >768 零变化;行高(52px)/横向布局未触及。

## 验证(reviewer 侧)

- `bun install` + `wails3 generate bindings`(新 worktree 补 gitignore 产物,非本改动引入)。
- 修复后:`bunx tsc` 干净;`bun test --isolate` **527 pass / 0 fail**(72 文件,与 coder 基线一致);`bun run build` 通过(chunk 体积警告为既有)。
- CSS 断言:`top: calc(env(safe-area-inset-top) + 52px)` 恰 3;≤768 块内 `padding-top: env(...)` 0;`.drawer-scrim` 内 `position: fixed` 恰 1。
- 三端(§4.7):本次为 ≤768 定向改动;桌面端 CSS hunk 局部性 + 基础规则未动保证 >768 不变。远程浏览器/PWA 的像素几何(scrim 覆盖 header 以下、点按可关)与 #173 原条目同批待真机/390 视口人工复核——本条不重复展开。

## 下一步

- 与 #173 原条目合并做一次真机(iOS Safari / Android Chrome)或 390 视口复核:抽屉顶=header 底、scrim 不盖 header 且点按可关、右上按钮开合双态。
