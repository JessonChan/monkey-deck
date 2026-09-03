# PW/浏览器模式打开时 /wails/runtime 请求风暴定位报告

> 2026-09-03 · 纯定位，未改任何代码 · 观测环境：桌面 app 内嵌远程服务（:9250）+ 真实用户数据（31 项目 / 432 session / 122,938 消息）

## TL;DR

**不是轮询，是启动瞬间的请求风暴。** 干净打开一次页面（含 WS 正常连接）实测 **198~499 个** `/wails/runtime` 请求，全部落在导航开始后 ~1.2 秒内；静置 20 秒新增为 0。

最大头是 `ListSessions` 被打了 **7 轮重叠补发**（31 个项目 × 最多 7 次 ≈ 163 请求 / 60ms 内）。根因是前端 boot effect 的 **TOCTOU 竞态：没有 in-flight 去重**——每个 `ListSessions` 响应到达 → `setSessionsByProject` → effect 重跑 → 对「响应还没回来」的项目**再发一轮**。请求数随项目数**近似二次方增长**（31 项目最坏 31²/2≈496，实测 499 命中）。

**注意：这不是远程端专属问题——桌面 webview 走同一段代码，boot 同样风暴**，只是 DevTools 看不到所以没被发现。

## 一、测量数据

| 场景 | 总请求数 | 备注 |
|---|---|---|
| 经日志反代打开（WS 断） | **198** | 方法级归因完整（见下） |
| 直连 :9250 reload #1 | **332** | 首秒内全部完成 |
| 直连 :9250 reload #2 | **499** | 200ms 分桶：66/268/153/12 |

逐次波动（198→332→499）本身就是竞态特征：响应到达越分散（手机 WiFi 更慢），补发轮数越多，越接近 O(P²) 上限。

方法级归因（日志反代实测，198 个请求）：

| binding 方法 | 次数 | 占比 | 说明 |
|---|---|---|---|
| `ChatService.ListSessions` | **163** | 82% | 7 轮重叠补发（31/30/25/23/22/19/13），全在 60ms 内 |
| `ChatService.HasGitContext` | **31** | 16% | 恰好每项目 1 次；服务端每次 = 1 git exec + fs walk |
| `ListProjects` / `ListHarnesses` / `ListHarnessCapabilities` / `ListTerminalsBySession` | 各 1 | — | 正常固定开销 |

排除项：`IsSessionWindowPopped` 出现 **0 次**——6bfd39a 的远程端跳过修复确实生效；无稳态轮询（静置 20s 增 0）。

## 二、根因（按贡献排序）

### 根因 1（主因）：boot mount effect 的 TOCTOU 竞态，O(P²) 补发

`frontend/src/App.tsx:972-979`：

```tsx
useEffect(() => {
  if (isPopout) return;
  for (const p of projects) {
    if (!(p.id in sessionsByProject)) void refreshSessions(p.id);   // ← 无 in-flight 去重
  }
}, [projects, sessionsByProject, refreshSessions, isPopout]);
```

时序（日志实测的 7 轮）：

1. projects 列表到达 → effect 首跑 → map 为空 → **并发发出 31 个 ListSessions**（6433ms）。
2. 第一个响应（47b0f85c）落库 → `setSessionsByProject` 新对象 → effect **重跑** → 其余 30 个项目响应未到、不在 map 里 → **再发 30 个**（6452ms）。
3. 每次响应到达都触发新一轮，直到响应追上补发。实测 7 轮：31+30+25+23+22+19+13 = **163**，全部在 6433–6493ms（60ms）内。

守卫 `!(p.id in sessionsByProject)` 只判断「已完成」，不判断「在途」——响应回来前 key 不存在，每次 effect 重跑都对在途项目重复下单。`sessionsByProject` 在依赖数组里保证了每次响应都会重跑 effect。项目越多、网络越慢（手机），轮数越多，最坏 P(P+1)/2。

### 根因 2：`remote:resync` 首连不去重 + 每次重连全量重刷

`frontend/src/App.tsx:805-835`（resync 处理器，300ms trailing debounce）：

- `refreshProjects()` + `ListHarnesses()` 受「首连跳过」保护（`bootListsStartedRef`），**但 `for (pid…) refreshSessions(pid, true)` 的全项目循环没有任何首连守卫**——注释声称「first WS connect rides along the mount-effect boot pulls」，实际 sessions 循环每次 resync 都执行，首连再 +31。
- 且 `bootListsStartedRef` 在 mount effect 里**同步置 true**（App.tsx:619），WS 首连必然晚于它 → 该守卫**从未跳过过任何东西**（逻辑失效，首连照样重复拉 projects/harnesses）。
- 触发频率不只是重连：custom.js 在 `visibilitychange`（可见且 WS OPEN）也派发 resync——**手机每次亮屏 = +31 ListSessions + 非真项目的 HasGitContext 重探 + SessionStatuses + 可能的 openSession 全量重载**。

### 根因 3（放大器）：HasGitContext 对 false 不缓存

`frontend/src/App.tsx:338-350`：探测结果只有 `true` 进缓存（进程生命周期）；`false` 的项目**每次 refreshProjects 都重探**（每次 = 服务端 1 git exec + FindSubRepo fs walk）。boot 必然 31 次；此后每次 resync，所有非 git 项目再各来一次。

## 三、修改建议（按性价比排序，均未实施）

> **2026-09-03 更新**：本节为初版建议。经与 CodeBuddy（hy4-preview/hy3）四轮评审后定稿的最终方案见 [2026-09-03-runtime-request-storm-final-plan.md](./2026-09-03-runtime-request-storm-final-plan.md)——相对本节有三处重要修正：F3 必须与批量 popout 查询同 commit（否则引爆 432 请求地雷）、F1(b) 循环在 F3 后保留为 fallback、F4 升级为「选中时懒探测」。

1. **in-flight 去重（止血，改动最小）**：`refreshSessions` 发起前把 pid 记入 `fetchingRef: Set`，finally 删除；mount effect 守卫改为 `if (map 有 || fetching 有) skip`。一个不变量消灭全部 7 轮补发：boot 的 ListSessions 从 163 → **31**，与项目数线性。§5.3「找不变量，不堆 if」的正解。
2. **修 resync 首连语义**：把「首连跳过」落到 sessions 循环（如 `firstResyncDoneRef`，首次 resync 只跑 `syncSessionStatuses`），并把 `bootListsStartedRef` 改为「boot 拉取完成后置位」——消除首连的全套重复拉取（-31~-35）。
3. **boot 路径合并为单请求（架构收敛，§1.7 胖后端）**：新增 `ListAllSessions()`（或 `BootSnapshot()` 一次返回 projects+sessions），「多项目同时展开」本来就是当前形态的常态。boot 的 ListSessions 从 31 → **1**，且天然免疫未来的同类竞态。建议在 1、2 之后做，做完 1+3 后 boot 总请求 ≈ **6~8 个**。
4. **HasGitContext false 加 TTL**（如 5 分钟内不重探）或随建议 3 合并进 boot snapshot；消除每次亮屏/重连的 git exec 风暴。

预期收益（31 项目现状）：打开一次的 runtime 请求 **~200-500 → 6~40**（取决于做几层）；手机亮屏场景从每次 +35~70 → +2~3。

## 四、验证方法备忘

- 页内 `PerformanceObserver({type:'resource', buffered:true})` 过滤 `/wails/runtime`：精确计数 + 时间分桶（跨世界可读：结果镜像进 DOM 节点）。
- 方法级归因：本地 9251 日志反代 → 9250（cookie 按主机共享，配对会话直接可用），POST body 内层 `args.methodID` 经 FNV-1a 反查（格式 `github.com/jessonchan/monkey-deck/internal/chat.ChatService.<Method>`，用已知 ListProjects=3527400214 校准）。
- 轮次边界：按「pid 重复出现 = 新一轮」切分日志序列。

## 五、下一步

按建议 1 → 2 → 4 → 3 顺序实施；每步配「能复现风暴的测试」（如：mock 慢速 ListSessions 响应 + 断言调用次数 = 项目数）再动手。
