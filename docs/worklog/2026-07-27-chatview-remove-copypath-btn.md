# 2026-07-27 删 ChatView 头部 copy-path-btn(右键菜单已覆盖)

**类型**:refactor(chat)

> Task #23435 / 修正 #71 第三项。Task #23430(ce348e9)已落地对话区右键菜单 + copyPath worktree 优先,但当时保留头部 copy 按钮「双入口」。本条把头部按钮删掉,收敛为「右键菜单唯一入口」,与 #71 原始诉求(删 copy-path-btn + 落地 onContextMenu)对齐。

## 起因

#71 原始诉求三件套:① 删 ChatView `copy-path-btn`;② 落地 `onContextMenu` 右键菜单(复用 Sidebar ctx-menu 范式);③ copyPath worktree 优先。

Task #23430 做了 ②③,但 ① 没做——头部仍保留一个 copy 按钮,与右键菜单「复制工作目录」功能重复(且头部按钮 tooltip 文案 `chat.copyPathTip` = 「复制项目路径」在 worktree session 下语义不准,右键菜单用的 `sidebar.copyWorkdir` = 「复制工作目录」才准)。

收敛为右键菜单唯一入口:
- 去重(§5.3 Less is More:同一功能一个入口足够)。
- 文案语义自洽(右键菜单的「复制工作目录」worktree session 下也对)。
- 与 Sidebar 的项目 / session 行一致(它们也只走右键菜单,无独立 copy 按钮)。

## 改法

### 1. 删 `copy-path-btn` 按钮 + 关联死代码

- 删 `chat-header-actions` 里的 `copy-path-btn` `<button>`(原 ChatView.tsx:520-529)。
- 删 `copiedPath` state:按钮没了,check-icon 反馈无处展示 → 死代码,删(§5.3「删掉后功能不变的代码就该删」)。
- 简化 `copyPath`:去掉 `setCopiedPath(true)` + `setTimeout` 回落(右键菜单点击即关闭 `setCtxMenu(null)`,反馈不可见;与 Sidebar 项目菜单 `void navigator.clipboard?.writeText(...); closeCtx();` 一致,无反馈)。
- `activePath`、`copyPath`、`openCtxMenu`、ctx-menu JSX 全部保留(右键菜单仍在用)。

### 2. 删未用的 i18n key

`chat.copyPathTip` / `chat.pathCopiedTip`(en + zh)随按钮一起删——grep 全仓只有 `copy-path-btn` 那一处引用,按钮删后零引用。右键菜单复用既有的 `sidebar.copyWorkdir` / `sidebar.revealInFinder`,不新增 key。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - 删 `copiedPath` state(原 :142-143)。
  - 简化 `copyPath`(原 :174-177,去反馈)。
  - 删 `copy-path-btn` 按钮 JSX(原 :520-529)。
- `frontend/src/i18n/locales/en.json`、`zh.json`:删 `chat.copyPathTip` / `chat.pathCopiedTip`。

## 验证

- `npm run build`(frontend = `tsc && vite build`,先 `wails3 generate bindings` 生成未入库 bindings):零 TS / 编译错误。
- `go build ./...` + `go vet ./...`:clean(仅有 macOS 版本号链接告警,与本改动无关)。
- grep 全仓:`copiedPath` / `copy-path-btn` / `copyPathTip` / `pathCopiedTip` 零残留;`Check` / `Copy` import 仍被 MessageActions 等使用,保留。

## 下一步

- 桌面实测:头部只剩 toggleTerminal 按钮;右键对话区 → 复制 / Reveal worktree 路径仍正常。
- #71 三件套至此全部完成(②③ 由 ce348e9 完成,① 由本条完成),可关 issue。
