# 步2 F4'：git 探测改「选中时懒探测」（请求风暴修复第二刀）

> 上游：[2026-09-03-runtime-request-storm-final-plan.md](./2026-09-03-runtime-request-storm-final-plan.md)。四步方案第 2 步，与步 1（[2026-09-04-boot-fanout-dedup-step1.md](./2026-09-04-boot-fanout-dedup-step1.md)）互相独立。

## 起因

boot 时 `refreshProjects` 对**全部项目**各发一次 `HasGitContext`（31 次 = 31 个服务端 `git exec + FindSubRepo fs walk`），非真项目（false 不缓存）在每次 refreshProjects 后重探；远程端每次 resync（含手机每次亮屏）再全量来一轮。但 `gitByProject` 全仓唯一消费点是**选中项目**的 SidePanel SCM tab（`App.tsx` isGitProject prop）——31 次全项目探测从头就是浪费。

## 改法

- 删 `refreshProjects` 内的增量探测块（原 338-350），`refreshProjects` 收敛为纯「拉项目列表」。
- 新增 `probeGit(pid)`：true 永久缓存（沿用 R4 语义）+ `gitProbingRef` 在途去重 + 失败释放槽位（下次选中重试）；`useEffect([selectedProjectId])` 选中即探。
- `createSession` 的 STRICT `IsGitProject` worktree 门控是独立按需调用，零改动。
- 已知 cosmetic（接受，记 OPEN）：选中冷 git 项目时 SCM tab 在 1 个 roundtrip 后出现（亚百毫秒、次要面板）；根治形态（tab 恒渲染+置灰）是产品结构改动，单开 issue。
- 步 4 将在 resync 里补 `probeGit(selectedProjectIdRef.current)`（需新 ref，届时一并做，避免本步夹带）。

## 改动文件

- `frontend/src/App.tsx`：删探测块、加 `probeGit` + 选中 effect；触及的中文注释转英文（§3.7）。
- `frontend/src/App.boot-budget.mount.test.tsx`：新增 T9-T12。

## 验证

- **T9**：boot `HasGitContext` 调用数 **=== 0**（旧代码此处为 31）；选中 git 项目恰 1 次探测；重复选中 true 缓存跳过。
- **T10**：非 git 项目每次选中重探（false 不缓存，保住「agent 中途 git init 可见」），它项目互不影响。
- **T11**：在途去重——探测未返回时重复选中只发 1 个请求；resolve 为 true 后再选中仍 1。
- **T12**：boot + 反复选中全程 `IsGitProject` 调用 === 0（STRICT 门控不被触碰）。
- 全量 `bun test`：失败集合与步 1 后完全一致（16 个存量失败，零新增）。
- 三端：纯前端共享路径，三端同跑同一逻辑；PWA 冷项目切换的 SCM tab 抖动列为后续真机观察项。

## 下一步

步 3（F3：`ListAllSessions` + `ListPoppedSessions` 原子 commit，防 432 地雷）→ 步 4（F2(ii)）。
