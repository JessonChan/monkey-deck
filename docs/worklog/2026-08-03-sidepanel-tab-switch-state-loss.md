# 2026-08-03 SidePanel files/scm 切 tab 状态丢失修复

## 起因

用户报告:右侧面板(files / scm)切换 tab 后,「已打开的状态」全部丢失——展开的目录收回、打开的文件预览关闭、commit 草稿清空、展开的 diff 收起。

## 根因

`SidePanel` 用**三元条件渲染**切换两个面板:

```tsx
{tab === "files" ? <FilePanel .../> : <GitPanel .../>}
```

切到 scm 时 `FilePanel` 被 React **unmount**,切回 files **重新 mount**,组件内 `useState` 全部重建为初值:

- `FilePanel`:`expanded`(展开目录集合)、`preview`(打开的文件预览)、`selected`。
- `GitPanel`:`message`(commit 草稿)、`openStaged`/`openChanges`(折叠组)、`diffKey`/`diffText`(展开的 diff)。

典型的条件渲染 unmount 丢状态。

> 注:切换**顶部会话 tab**(TabBar)时的重置是 `FilePanel` 的 `useEffect([sessionId])`(第 135 行)的**期望行为**——不同 session 的文件树本就该重置,不是本 bug。本 bug 仅指右侧 files↔scm 这两个 tab 互切。

## 改法

两个面板都**常驻 DOM**,tab 切换只切显隐(CSS class `side-hidden` → `display:none`)。VS Code viewlet 式。

- `display:none` 的元素不参与 flex 布局,可见面板照常 `flex:1` 占满 `side-body`。
- 两个面板都是纯展示组件:`FilePanel` 的文件内容由用户点击拉取(无轮询),`GitPanel` 无自动 effect——常驻代价可忽略(虚拟 DOM diff + display:none 下不布局)。
- `FilePanel` 常驻后,它的 `useEffect`(`loadChildren` 在 status idle 时刷新已展开目录)在隐藏期间仍跑——这反而是好事,切回 files 时文件树已是最新。

## 改了哪些文件

- `frontend/src/components/SidePanel.tsx`:`side-body` 块从三元条件渲染改为双面板常驻 + `.side-view` / `.side-hidden` 切显隐(`hasSCM` 为 false 时 GitPanel 仍不渲染,保持原语义)。
- `frontend/src/index.css`:新增 `.side-view { flex:1; min-width:0 }` 与 `.side-view.side-hidden { display:none }`。
- `frontend/src/components/SidePanel.mount.test.tsx`:新增 mount 测试,精确复现 bug(切 tab 后隐藏面板仍在 DOM + 展开目录存活 scm 往返)。bug 版 2 fail,修复版 2 pass。

## 验证

- `tsc --noEmit` 全绿(本地 `wails3 generate bindings` 生成 binding 类型后;worktree 默认无 bindings,是预存环境状态)。
- `SidePanel.mount.test.tsx`:临时把 SidePanel 还原为条件渲染(bug 版)→ 2 fail(`git-panel` 初始为 null;切回 files 后 `a.ts` 消失);改回修复版 → 2 pass。测试有效复现。
- 全前端 `bun test --isolate`:修复版 142 pass / 20 fail;`git stash` 还原 SidePanel/index.css 后 140 pass / 22 fail——差异正好是本测试的 2 个,其余 20 个失败(ChatView 虚拟化 / NewSessionModal / msg-meta duration / McpChip)在两个版本都存在,为预存的 happy-dom 环境问题,与本次改动无关。

## 下一步

无。纯前端渲染层修复,无后端 / 协议影响。
