# 2026-08-27 侧栏批量选择:⌘/Ctrl 点选 + Shift 连选 + checkbox + 批量删除/复制目录(#94,Task #24356)

Task #24356。给 Sidebar 的 session 列表加批量选择与批量操作(issue #94)。

## 起因

侧栏只能逐个右键删除/复制目录,session 多时重复操作繁琐。#94 要求:
**Cmd+点 / Shift 连选 + checkbox + 批量删除/复制目录 + mount 测试**。

## 设计

- **选择状态全在 Sidebar 本地**(`selMode` + `sel: Set<string>` + `selAnchorRef`):
  纯 UI 关注点,不加 Props、不动 App.tsx / 后端(§1.7 判断:无数据编排,属 UI 呈现层)。
- **三种选择入口**:
  1. **⌘/Ctrl+点行** → toggle 该行进/出选择集,不激活 session(自动进入 select mode);
  2. **Shift+点行** → 从 anchor(最近一次单选的行)到所点行整段加入,跨段方向均可;
     anchor 不在当前项目渲染列表内时降级为单选 toggle(§5.3:按稳定 id 找不变量,不假设顺序);
  3. **checkbox** → 侧栏头部新 ListChecks 按钮(`batch-select-mode`)进入 select mode 后
     每行行首出现 checkbox(15px 方框,checked = accent 实底 + 白勾);select mode 下
     行 plain-click 也是 toggle(模态式选择,Esc / X 退出)。
- **批量操作条**(`batch-bar`,选择非空时钉在侧栏底部):计数 + 复制目录 + 删除所选 + 退出。
  - **复制目录**:按侧栏渲染顺序(项目序→session 序,与点击顺序无关)取
    `worktreePath || project.path`(与单行右键「复制工作目录」同一解析),`\n` 连接,
    走 `useCopyFeedback`(成功 Check/失败红字反馈,issue #129 的教训不重蹈)。
  - **删除所选**:确认弹窗(标题带数量、前 3 个标题预览 + 「等 N 个」、不可恢复提示、
    内联错误复用 `modal-del-err`);确认后**顺序**逐个 `await onRemoveSession(id)`
    (复用 App 既有单删流程,owner-with-guests 仍由 DeleteWorktreeDialog 兜底);成功后
    清选择 + 退 select mode,失败停住显示错误(剩余保持选中可重试)。
- **健壮性**:
  - `allSessionIds` memo + effect:**选择集按现存 session id 剪枝**(外部/右键删除后
    计数不说谎),返回 `prev` 引用避免无变化重渲染(Object.is bailout)。
  - Esc 退出 select mode:独立 window 监听,输入框(搜索/重命名)与 ctx/confirm 弹层
    打开时让路(它们自己的 Esc 先处理)。
  - Shift 连选基于 `projectList(pId)`——渲染循环 / kbd 导航 / 连选三方共用同一
    「用户可见列表」计算(分页切片 or 搜索过滤),消除三处各算一份的漂移风险(顺手把
    原渲染循环与 kbdList 的重复计算收敛到该 helper,净减重复)。
- **i18n**:zh/en 同步新增 13 个 key(`sidebar.batch*` 家族);所有新交互元素带
  react-tooltip(§4.5)+ data-testid(§4.2);弹窗 Esc/外点关闭复用既有机制(§4.2)。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx`:选择状态/入口/批量操作/确认弹窗 + `projectList` 收敛。
- `frontend/src/index.css`:`.session-item-row.selected`、`.session-check`、`.batch-bar/.batch-btn`、
  `.icon-btn.batch-on`、`.modal-del-hint`(均浅 CSS,无重绘型效果,§4.6)。
- `frontend/src/i18n/locales/{en,zh}.json`:13 个 batch key。
- `frontend/src/components/Sidebar.batch.mount.test.tsx`(新增,6 用例)。

## 验证

- `bun test src/components/Sidebar.batch.mount.test.tsx`:6 pass / 30 expect——覆盖
  头部按钮进退 select mode + Esc、⌘/Ctrl 点选不激活、Shift 连选(anchor 语义)、
  checkbox toggle + bar 计数显隐、复制目录(跨项目渲染顺序 + worktreePath||path 换行连拼,
  clipboard mock 断言精确 payload)、批量删除(确认前零删除→确认后按序逐删→清选择退模式)。
- 全量 `bun test --isolate`:**390 pass / 0 fail**(含 locales key 对齐测试)。
- `bun run build:dev`(tsc + vite):绿。无 lint script(frontend/package.json 无 lint,与
  verify cmd 口径一致)。无 Go 改动,`go build/vet` 不适用。
- 三端(§4.7):改动纯前端且不触 `isRemoteClient()`/WS/断点;GUI(webview)与远程浏览器
  同一 React 树,行为一致;复制走 lib/clipboard 三通道(桌面 native / 浏览器 async /
  PWA execCommand),远程端不会误写桌面剪贴板(#129 语义保持)。PWA ≤768px:batch-bar
  `flex-wrap: wrap` 防窄侧栏溢出,checkbox 为普通 button(全局 touch-action 规则覆盖),
  Esc 退出在无键盘触屏端有 X 按钮等价物;桌面 >768px 布局仅新增头部一个 icon 按钮 + 行首
  条件渲染的 checkbox,无既有布局改动。真 webview 冒烟待用户侧(本环境无 GUI)。

## 已知边界(记录不展开)

- 批量删除遇到 owner-with-guests session:App 的 `removeSession` 弹 3 选项弹窗并立即返回,
  批量循环继续删其余项,该 session 由弹窗兜底——语义正确但体验一般,后续可考虑批量场景
  跳过或预检。
- select mode 下 plain-click 是 toggle(不能直接打开会话)——模态选择的有意取舍,Esc/X 退出。

## 下一步

- 可选:批量场景对 owner-with-guests 的预检/跳过策略;「全选本项目」快捷键。
