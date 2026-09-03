# 步4 F2(ii)：resync 永远全量刷（合流到批量快照）+ selectedProjectIdRef

> 上游：[2026-09-03-runtime-request-storm-final-plan.md](./2026-09-03-runtime-request-storm-final-plan.md)。四步方案收官步；GUI 面为零（桌面 webview 对 /wails/custom.js 404，`remote:resync` 永不到达）。

## 起因

resync 处理器对全项目循环 `refreshSessions(pid, true)`（每次亮屏/重连 = 31 个 ListSessions）；「首连跳过」守卫 `bootListsStartedRef` 是死代码（mount 同步置 true，任何 WS 连接都晚于它）。且评审实证（hy3 R3）：**跨设备新 session 可见性只靠 resync**——`chat:status`/`chat:session-meta` 处理器只修改已存在的 session，不插入新行——所以首连跳过本来就是错误方向。

## 改法

- 删 `bootListsStartedRef`（声明/赋值/守卫/注释四处）。resync 永远全量：`refreshProjects()` + `ListHarnesses()` + **`refreshAllSessions()`（1 次快照替代 31 次循环）** + `probeGit(selectedProjectIdRef.current)`（只重探选中项目，保「中途 git init」可见）+ `syncSessionStatuses()` + 既有 openSession 重载。300ms 尾防抖保留。
- 新增 `selectedProjectIdRef`（仿 selectedSessionIdRef 的 render 期赋值模式）：resync 监听器只注册一次（effect deps 不含 selectedProjectId），闭包读 state 会冻结为 mount 时的 null → probeGit 空转（hy3 R3 必修项）。
- `refreshAllSessions`/`snapshotSettled` 块上移到订阅 effect 之前：effect deps 数组渲染期求值，晚定义会 TDZ 崩渲染。
- 代价（有意，非回归）：每次 resync 多 2 个请求（refreshProjects + ListHarnesses）——换来删掉一条「boot/对账双入口协调」路径与跨设备正确性。

## 改动文件

- `frontend/src/App.tsx`：resync 重写、ref 新增、块上移、死守卫删除、订阅 effect deps 更新。
- `frontend/src/App.boot-budget.mount.test.tsx`：T8、T14、T14b。

## 验证

- **T8**：两次快速 resync（模拟 onopen+visibilitychange 竞态）经 300ms 防抖合并为**一次**全量刷（ListAllSessions/ListProjects 各 +1 而非 +2）；首连不做特判（第一次 resync 照刷）。
- **T14**（跨设备可见性）：boot 后另一「设备」新建 session（bulk 桩 v2 多一条）→ resync → 新 session 行出现在侧栏——「事件不插行、resync 是唯一通道」的行为锚点。
- **T14b**：resync 只重探**选中**项目的 git 上下文（p01 两次、其余 30 项目零探测）。
- 全量 `bun test --isolate`：**557 测试 0 失败**。
- GUI 零面：custom.js 在桌面 webview 404（server.go:10 注释），resync 分支不可达；boot 路径仅被步 1-3 改动覆盖（已有 T1-T7 锚定）。

## 四步收官状态

打开一次页面的 binding 请求数（31 项目/432 session 实测口径）：
- 修复前：198~499（ListSessions 163~464 + HasGitContext 31 + 杂项）。
- 修复后（mount 测试口径）：boot = ListProjects 1 + ListAllSessions 1 + ListHarnesses 1-2 + ListHarnessCapabilities 1 + ListTerminalsBySession 1 + ListPoppedSessions 1 + git 探测 0（选中才探）≈ **6-7 个**；resync（亮屏/重连）≈ **5 个**。
- 真实数据 E2E 计数见收尾条目。
