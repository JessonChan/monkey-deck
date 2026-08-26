# 2026-08-26 Review #24323:#124 SidePanel 移动端右侧抽屉 — APPROVE

Task #24324 / review 对象 commit `955cf72`(feat)+ `f227705`(实现方 worklog)。

## 结论

**APPROVE**。实现完全镜像既有左侧抽屉(M2)机制,桌面零修改由构造保证,全链路
消费经逐路径核实,独立复跑全部验证声明属实。3 条 P3 观察不阻塞(见下)。

## 审查方法(反向追踪,不信叙述)

按「类型补丁」反模式 playbook,从每个新增字段/选择器定义点出发逐个确认运行时消费:

1. **prop 链全通电**:`onOpenSideDrawer`(ChatView Props)→ header 按钮
   `props.onOpenSideDrawer &&` 条件渲染 + onClick(App 传 `openRightDrawer`)→
   `rightDrawerOpen` state → `data-md-side-drawer` attr(App.tsx:2109)→ CSS
   `.app[data-md-side-drawer="true"] #side` transform + `~ .drawer-scrim` display。
   链上每一跳肉眼确认「值真的被读」,非「字段存在」。
2. **CSS 选择器全部有真实 DOM 背书**(防死规则):`.side-tabs`/`.side-tab`
   (SidePanel.tsx:53-64)、`.side-panel .tree-row`(FilePanel)、`.git-file-row`
   (GitPanel)、`--r-sm`(index.css:41)均存在。
3. **scrim 兄弟选择器合法性**:scrim button 确为 `.app`(Group)之后的 DOM 兄弟
   (App.tsx:2349 `</Group>` → 2358 button),`~` 通用兄弟选择器成立。
4. **互斥完整性**:openRightDrawer 关左;左 rail toggle mdViewport 分支
   (App.tsx:2379)+ PWA switch-project(2093)关右;scrim onClick 双关。
   三条开左路径全覆盖,scrim 永远单层。
5. **桌面零修改(构造核实)**:base 仅加 `.side-drawer-btn{display:none}`(新元素,
   桌面不显示);其余新 CSS 全在 ≤768px 块;scrim 从 `{!isPopout && …}` 解包为恒渲染,
   但 base `.drawer-scrim{display:none}`(2823 行)保证 >768px 渲染等价;
   `data-md-side-drawer="false"` 在断点块外无任何选择器;Panel 的 touch handlers
   桌面不发 touch 事件(惰性,#sidebar M2 同款先例)。
6. **刻意不用 `.icon-btn` 的理由核实**:`.chat-header-actions .icon-btn` 确在
   ≤768px `display:none`(3096 行)——若用了该类按钮会被藏掉,规避正确。
   全局 button reset(78 行)兜底无边框/背景。
7. **层级**:drawer 60 > scrim 55 < modal-overlay 65——弹窗盖抽屉,正确。
8. **i18n**:无新 key;`app.expandSidePanel` 在 en.json:28 / zh.json:28 同步存在。
9. **测试断言锚定值**(非字段存在):aria-label 键值、`.chat-header-actions`
   包含关系、click 回调 `toHaveBeenCalledTimes(1)`。

## 独立复跑验证(全部属实)

- 环境重建:worktree 无 node_modules → `bun install`;bindings 不在 git →
  `wails3 generate bindings -ts`(298 packages / 3 services / 132 methods)。
- 新测试 `ChatView.sidedrawer.mount.test.tsx`:单独跑 **2/2 pass**。
- `SidePanel.mount.test.tsx`:单独跑 **3/3 pass**。
- **同批跑确实互踩**(GetSessionMcpServers is not a function)——与 worklog 自述
  完全一致:既有 mock.module 先注册者胜的文件间竞争,非本任务引入,全量套件下
  各自通过。诚实披露,值得肯定。
- 全量 `bun test`:38 files / 324 tests / **23 fail + 1 error**,fail 集 22 条与
  干净基线(`955cf72^` = 6fa704f)逐条 diff **字节级一致**(仅耗时毫秒数不同),
  全部为 stt/voice 环境性预存在——「fail 集完全一致」声明实证。
- `bun run build`(tsc + vite):通过(仅既有 chunk >500kB warning)。

## P3 观察(不阻塞,记录备查)

1. **Esc 不关抽屉**(左右皆无):镜像既有左抽屉行为,§4.2 针对「弹窗」;
   抽屉在 M2 即无 Esc 先例。若后续统一补,左右一起补。
2. **跨断点状态残留**:手机开右抽屉 → 拉宽 >768px → 再缩回,抽屉复现开启。
   与左抽屉(drawerOpen)同款既有行为,非本任务引入。
3. **375px 冒烟 + 真机实测待做**:实现方 worklog 已显式标注(与 M2 本身
   「真机实测待做后才关闭」同口径)。testid(`open-side-drawer`/`drawer-scrim`)
   已备好,后续冒烟可直接锚定。

## 下一步

- 移交冒烟:≤768px 视口实拍抽屉滑入/scrim/swipe-right/tab 切换 + 真机
  (§5.6),结果回写 #124。
- 若 bun mock 同批互踩再困扰,统一两文件 mock 为超集(范围外)。
