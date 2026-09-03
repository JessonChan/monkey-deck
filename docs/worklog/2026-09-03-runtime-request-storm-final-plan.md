# /wails/runtime 请求风暴 · 整体修复方案（经 CodeBuddy 四轮评审定稿）

> 2026-09-03 · 本文是 [2026-09-03-pwa-runtime-request-storm-diagnosis.md](./2026-09-03-pwa-runtime-request-storm-diagnosis.md)（定位报告）的方案定稿。**未修改任何代码**——所有代码均为建议形态。
>
> 评审方式：与 CodeBuddy CLI 多轮讨论（session id `c84857dc-66ab-47c9-b4e4-1122561d0ae1`，可 `-r` 续接）。R1/R2/R4 = hy4-preview，R3 = hy3 对抗终审；两模型均实际读码取证（合计 60+ 次工具调用），最终无未决分歧。

## 0. 方案必须同时成立的三端前提

- **桌面 GUI（webview）**：无 custom.js（404）→ 永无 `remote:resync`；boot 风暴（根因 1）**今天就存在于 GUI**，步 1/2/3 直接受益。步 4 对 GUI 面为零。
- **远程浏览器 / PWA**：boot 风暴 + 每次亮屏/重连的 resync 全量刷；且**跨设备新 session 可见性只靠 resync**（事件 handler 只修改已存在的 session，`App.tsx:681-688`/`772-783` 对未知 sid 短路）→ resync 全量刷是必需通道，首连跳过永不恢复。
- **popout 窗口**：`#popout=<sid>` 同 bundle；步 3 的新 binding 完全不碰 popout 路径（`975` 早退不变）。

## 1. 四步实施（顺序固定；1、2 可互换）

### 步 1 · F1(b)：boot 循环在途去重（独立 commit，无 Go 改动）

`App.tsx:972-979` 调用点改造（**不动 `refreshSessions` 本体**，其 4 个调用点 684/815/1023/openSession 全部不经守卫）：

```tsx
const bootSessionsFetchingRef = useRef<Set<string>>(new Set());
useEffect(() => {
  if (isPopout) return;
  for (const p of projects) {
    if (p.id in sessionsByProject) continue;                  // 已加载
    if (bootSessionsFetchingRef.current.has(p.id)) continue;  // 在途（新增）
    bootSessionsFetchingRef.current.add(p.id);
    void (async () => {
      try { await refreshSessions(p.id); }
      catch { /* 静默：后续 effect 重跑会补试 */ }
      finally { bootSessionsFetchingRef.current.delete(p.id); }
    })();
  }
}, [projects, sessionsByProject, refreshSessions, isPopout]);
```

- `try/catch/finally` 必需：`refreshSessions`（353-371）无内部捕获，今天 977 的 `void` 已存在 **unhandled rejection bug**，顺手修复；缺 finally 则失败项目永久卡 Set。
- 失败重试语义（写进 worklog）：多项目下自动补试（其它项目落地会触发 effect 重跑）；仅「最后一个失败项」可能停到下次 resync/手动刷新——**可接受降级，勿加定时器**。
- 验收：T1（先红后绿）、T2、T3、T4（见 §3）。

### 步 2 · F4'：git 探测改「选中时懒探测」（独立 commit，可与步 1 互换）

依据：`gitByProject` 全仓唯一消费点是 `App.tsx:2639`（只喂选中项目的 SidePanel SCM tab）；创建 session 的门控走独立的严格探测 `IsGitProject`（1206）。**GUI 今天 boot 后本就无重探机会**（refreshProjects 仅 boot/CRUD/重排回滚触发）——所以懒探测零产品回归。

删 `refreshProjects` 内 338-350 探测块，新增：

```tsx
const gitProbingRef = useRef<Set<string>>(new Set());
const probeGit = useCallback(async (pid: string | null) => {
  if (!pid || gitByProjectRef.current[pid] === true) return;   // true 永久缓存（沿用 339 语义）
  if (gitProbingRef.current.has(pid)) return;                  // 在途去重
  gitProbingRef.current.add(pid);
  try {
    const v = await ChatService.HasGitContext(pid);
    setGitByProject((prev) => ({ ...prev, [pid]: v }));
  } catch { /* 保持 unset：下次选中重探 */ }
  finally { gitProbingRef.current.delete(pid); }
}, []);

useEffect(() => { void probeGit(selectedProjectId); }, [selectedProjectId, probeGit]);
```

- **本步不创建** `selectedProjectIdRef`（步 4 才需要，避免夹带）。
- SCM tab 冷态抖动（选中 git 项目 → 1 roundtrip 后 tab 出现）：接受为已知 cosmetic，记 OPEN；根治形态（tab 恒渲染 + 非 git 置灰）是产品结构改动，单开 issue。
- 验收：T9-T12。

### 步 3 · F3：`ListAllSessions` + `ListPoppedSessions`（**原子 commit，不可拆**）

> 单独上 `ListAllSessions` 会引爆 P0 地雷：popout 对账（`955-969`）的 `popoutReconciledRef` 在「首批数据到达」即落闸——bulk 填充使首批=全量 432 session → GUI boot 打 432 次 `IsSessionWindowPopped`。两个 binding 必须同 commit。

**Go 侧**（`internal/store/sessions.go` + `internal/chat`）：

```go
// ListAllSessions: 全表同序（pinned DESC, prompted_at DESC, updated_at DESC）
// 按 project_id 分组返回。契约：每个项目必有键；空项目值为 []store.Session{} 而非 nil
// （nil slice 会被序列化成 JSON null，破坏前端「值恒为数组」不变量，777 的 findIndex /
// 961 与 814 的 flat() 会抛错）。须按项目预建键。
func (s *ChatService) ListAllSessions() (map[string][]store.Session, error)

// ListPoppedSessions: 批量判定（复用 window.go:163-169 的 GetByName 查找，零语义漂移）。
func (s *ChatService) ListPoppedSessions(sessionIDs []string) []string
```

改完 **`wails3 gen bindings`**（§0.5）。Go 单测（`t.TempDir()`，§5.2）：跨项目插入，断言分组结果与逐项目 `ListSessions` 逐条相等。

**前端**：

```tsx
const [snapshotSettled, setSnapshotSettled] = useState(false);
const refreshAllSessions = useCallback(async () => {
  try {
    const map = await ChatService.ListAllSessions();
    setSessionsByProject((prev) => ({ ...prev, ...(map ?? {}) }));  // 按 key 合并
  } catch { /* B 循环天然是 fallback，无需 catch 分支 */ }
  finally { setSnapshotSettled(true); }
}, []);

useEffect(() => {                                            // A：mount 快路径
  if (isPopout) { setSnapshotSettled(true); return; }
  void refreshAllSessions();
}, [isPopout, refreshAllSessions]);

useEffect(() => {                                            // B：原循环（步 1 形态）降级为 fallback
  if (isPopout || !snapshotSettled) return;
  /* 步 1 的守卫循环原样保留：只补缺失项/失败项/新增项目 */
}, [projects, sessionsByProject, refreshSessions, isPopout, snapshotSettled]);
```

**popout 对账改造**（`955-969`，修「数据没齐就落闸」的 P0）：

```tsx
const popoutReconciledRef = useRef(false);
useEffect(() => {
  if (isRemoteClient() || isPopout || popoutReconciledRef.current) return;
  const allLoaded =
    projectsRef.current.length > 0 &&
    projectsRef.current.every((p) => p.id in sessionsByProjectRef.current);
  if (!allLoaded) return;                                    // ← gate 用 allLoaded，不用 snapshotSettled
  popoutReconciledRef.current = true;
  const allSids = Object.values(sessionsByProjectRef.current).flat().map((s) => s.id);
  void Promise.resolve(ChatService.ListPoppedSessions(allSids))
    .then((popped) => { if (popped?.length) setPoppedSessionIds(new Set(popped)); })
    .catch(() => {});
}, [isPopout, sessionsByProject, projects]);                 // deps 必须加 projects
```

- **gate 必须是 `allLoaded` 而非 `snapshotSettled`**（hy3 必修项 1）：`snapshotSettled` 在 finally 置 true——快照失败走 B 循环回退时 map 未齐就放行，地雷换路径保留。`allLoaded` 在成功/回退两路径都只在真正齐时为真。
- 验收：T5、T5b、T6、T7、T13。

### 步 4 · F2(ii)：resync 合流（最后做；GUI 面为零）

```tsx
// 新增（仿 273 行 selectedSessionIdRef 写法）——resync 监听器只注册一次（892 deps
// 不含 selectedProjectId），没有 ref 则闭包恒为 mount 时的 null，probeGit 空转：
const selectedProjectIdRef = useRef(selectedProjectId);
selectedProjectIdRef.current = selectedProjectId;

const offResync = Events.On("remote:resync", () => {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    void refreshProjects();
    ChatService.ListHarnesses().then((h) => setHarnesses(h ?? [])).catch(() => {});
    void refreshAllSessions();                        // 1 次快照（原 31 次循环）
    void probeGit(selectedProjectIdRef.current);      // 保「agent 中途 git init」跨 PWA 可见
    void syncSessionStatuses();
    const sid = selectedSessionIdRef.current;
    if (sid && loadedSessionsRef.current.has(sid)) {
      loadedSessionsRef.current.delete(sid);
      void openSessionRef.current(sid);
    }
  }, 300);                                            // 既有尾防抖保留
});
```

- 删 `bootListsStartedRef`（615/619/808/612-614 注释）——**808 守卫恒真，是死代码**（619 在 mount 同步置 true，WS 连接必然晚于 mount）。
- 代价（worklog 说明，非回归）：每次 resync 多 2 请求（refreshProjects + ListHarnesses），换掉的是一整条「boot/对账双入口协调」路径。
- 必须晚于步 3：否则全量刷 = 31 次比今天更糟。
- 验收：T8、T14。

## 2. 评审过程中的关键裁决（备忘）

| 争议 | 裁决 | 依据 |
|---|---|---|
| F1 变体 a/b/c | **(b) 在途 Set + finally**（仅调用点） | (a) 丢失败重试；(c) 「未加载/空」语义混淆；(b) 且顺修既有 unhandled rejection |
| F2 (i) 修首连跳过 vs (ii) 删掉 | **(ii)** | 跨设备新 session 可见性只靠 resync（hub 广播 ≠ 列表插入）→ 首连跳过是错误方向；808 守卫本就是死代码 |
| F4 TTL vs F4' 懒探测 | **F4'** | 唯一消费点是选中项目；GUI 今天 boot 后也无重探机会 → TTL 是「给浪费加缓存」，F4' 是「根本不做」（§5.3 Less is More） |
| `chat:session-meta` 加 `?? []` 防御（hy3 提议） | **驳回** | `Object.keys(next)` 循环内 `next[pid]` 恒为数组（全部写入点只赋数组），死代码；真实风险移到 F3 边界，由 Go 键-值契约 + T5b 解决 |
| F3 是否捆绑 `ListPoppedSessions` | **必须同 commit** | 否则 GUI 从 163 请求风暴变 432 次 IsSessionWindowPopped（R2 发现的 P0） |
| F1(b) 循环在 F3 后是否删除 | **保留为 fallback** | 快照失败/新增项目/失败补试三个既有职责由它兜底；happy path 下 0 请求 |

## 3. 验收测试（`App.boot-budget.mount.test.tsx`，用现成 bun:test + happy-dom + mock.module 基建）

| # | 断言（**上界/双向，非精确场景值**） |
|---|---|
| T1 复现（先红） | deferred 逐个 resolve + 每次 `await flush(1)`（防 React 18 同 macrotask 批处理吞掉 commit）；pre-fix `>31` / post-fix `===31` 且每项目恰 1 次 |
| T2 完整性 | boot 后 map 键集合 == 31 项目（含 0 session 项） |
| T3 强刷不被挡 | p1 的 ListSessions 永不 resolve 时，`chat:status=prompting` 仍触发 → p1 计数 ≥2 |
| T4 失败不泄漏 | p2 reject → 无 unhandled rejection；后续 effect 重跑补试 ≥2 |
| T5 F3 等价（金标准） | 逐项目桩 vs 全量桩：每 pid 数组深度相等（顺序+pinned 位置） |
| T5b 键-值契约 | 快照键集合 == 项目集合；空项目值 === `[]`（非 null） |
| T6 防 432 地雷 | `IsSessionWindowPopped` === 0 且 `ListPoppedSessions` ≤1 |
| T7 F1(b) fallback | `ListAllSessions` reject → 31 项目仍全部由 B 循环补满 |
| T8 resync 防抖 | 连发两次 resync → `ListAllSessions` ===1（非 2）；首连不做特判 |
| T9-T12 F4' | 选中 git → SCM tab 出现且 HasGitContext===1；非 git → 不出现；反复切换计数==切换次数；1206 严格门控不受影响 |
| T13 popout 回归 | 开 popout → 重启主窗口 → poppedSessionIds 正确、权限不双弹 |
| T14 跨设备 | PWA 息屏期间桌面端建 session → 亮屏后可见（resync 唯一通道） |

## 4. 三端验证矩阵（§4.7/§5.6，每步 worklog 写明三端结果）

| 端 | 步 1 | 步 2 | 步 3 | 步 4 |
|---|---|---|---|---|
| 桌面 GUI | boot 冒烟、多项目展开无缺 | SCM tab 显隐、切换计数 | **必测**：popout 0/1、不双弹、逐项目数据比对 | **零变更**，仅确认 boot 路径未被误改 |
| 远程浏览器 | DevTools 计数上界 | 同左 | 同左 + payload 字节数记录 | resync 计数、`__mdRemote` 守卫仍在 |
| PWA | 冷开计数上界 | 冷项目切换 SCM tab（已知 cosmetic） | 同左 | **亮屏计数===1**、T14 |

## 5. OPEN / 显式推迟

1. **`__mdRemote` 时序依赖**（custom.js 异步设置 vs popout 对账判读）：步 3 后最坏代价 = 1 次无害 `ListPoppedSessions`（GUI 后端必返空），不值得加机制；若将来出现更多依赖 `isRemoteClient()` 的 boot 分支，统一改同步判据后一并处理。
2. **SCM tab 冷态抖动**（F4' 引入，亚百毫秒、次要面板）：接受；根治=「tab 恒渲染 + 非 git 置灰」，产品结构改动单开 issue。
3. **排序并列 tiebreaker**：全表 ORDER BY 在 pinned/prompted_at/updated_at 三者全等时行序可能与逐项目查询不同——仅影响视觉相同的两行，概率极低，**不加 tiebreaker**（加 id 反而改变现有语义）。

## 6. 预期收益（31 项目 / 432 session 现状）

| 场景 | 现状 | 全部落地后 |
|---|---|---|
| 打开一次页面（三端） | ~198-499 请求 | **~7 个**（ListProjects、ListAllSessions、ListPoppedSessions、ListHarnesses×2、ListHarnessCapabilities、ListTerminalsBySession）+ boot git 探测 31→0 |
| 手机亮屏（resync） | +35~70（31 ListSessions + git 重探 + 杂项） | **+5 左右**（快照 1 + projects 1 + harnesses 1 + statuses 1 + git 1） |
| GUI boot 的 git exec | 31 次 | **0**（选中时才探，1 次） |
