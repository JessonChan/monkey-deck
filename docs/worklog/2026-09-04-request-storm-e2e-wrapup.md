# 请求风暴修复收官：真数据 E2E 实测（四步方案全落地）

> 上游四步：[步1 boot 去重](./2026-09-04-boot-fanout-dedup-step1.md) · [步2 git 懒探测](./2026-09-04-lazy-git-probe-step2.md) · [步3 批量快照](./2026-09-04-bulk-snapshot-boot-step3.md) · [步4 resync 合流](./2026-09-04-resync-merge-step4.md)。方案定稿：[2026-09-03-runtime-request-storm-final-plan.md](./2026-09-03-runtime-request-storm-final-plan.md)。

## E2E 方法与结果

构建 `-tags server` 二进制（内嵌新前端产物，vcs.revision=5ee43a7）+ 本地日志反代逐条抓 binding body，浏览器打开一次页面，**真实用户数据（31 项目 / 432 session / 122,938 消息）**：

| 指标 | 修复前（同数据实测） | 修复后 |
|---|---|---|
| 打开一次的 `/wails/runtime` 总数 | **198 ~ 499**（三次测量，竞态波动） | **6** |
| ListSessions | 163 ~ 464（7 轮重叠补发） | **0** |
| HasGitContext（每次 = 1 git exec） | 31 | **0**（选中项目才探，1 次/选中） |
| IsSessionWindowPopped | —（潜在 432 地雷） | **0**（1 次 ListPoppedSessions） |
| 页面渲染 | — | 侧栏 31 项目全部正常渲染 |

修复后 6 个请求的构成（FNV 反查实证）：ListProjects ×1、**ListAllSessions ×1**、ListHarnesses ×1、ListHarnessCapabilities ×1、ListTerminalsBySession ×1、**ListPoppedSessions ×1**。

`ListAllSessions` 真数据 payload：**2,275,263 字节（~2.27MB，未压缩）**，31 键 / 432 session / 空项目 `[]`——Go 契约（键全集 + 值恒非 nil）在真实数据上成立。

## 测试总账

- 前端：`bun test --isolate` 全量 **557 测试 0 失败**（含本系列 15 个 boot-budget 测试 T1-T14b；⚠ mount 测试必须带 `--isolate`，与 package.json 一致）。
- Go：`go test ./...` 0 FAIL（含 `internal/store` ListAllSessions 契约测试）。
- 构建：`go build` 默认 + `-tags server` 双过；`bun run build`（tsc+Vite）过。
- 红→绿轨迹：T1 修复前 **496**（=31+30+…+1 理论上限，与线上 499 总量相互印证）→ 修复后 **31**；T4 修复前 unhandled rejection 直接炸测试。

## 三端验证矩阵（§4.7/§5.6）

- **远程浏览器（本条 E2E）**：日志反代 + 新 server 二进制，boot 6 请求、渲染正常 ✅。
- **PWA**：与远程浏览器同一服务/同一前端；resync 路径由 T8/T14/T14b 锚定（亮屏合并为一次 5 请求全量刷、跨设备新 session 可见、只重探选中项目）。**真机（息屏→亮屏计数、SCM tab 冷态抖动观感）待用户真机确认**，方法：DevTools Network 过滤 `/wails/runtime`。
- **桌面 GUI**：与远程共享 boot 路径（T1-T7 锚定）；桌面无 custom.js/resync（面为零）。**真 webview 冒烟待用户下次 `wails3 dev`/发版时确认**（本机用户桌面实例运行中，不双开）。注意事项：新 binding 上线需与前端同构建发布（bindings 不入库，`wails3 generate bindings` 再生成）。

## OPEN / 后续

1. ~~**ListAllSessions payload 2.27MB**~~ **已解决（2026-09-04，见 [OPEN 清算条目](./2026-09-04-open-cleanup-cli-pin-and-slim-list.md)）**：列表投影剔除两个按需加载的缓存列，payload 2.27MB → 262KB（8.7×），boot 仍 6 请求。
2. ~~wails3 CLI 双线并存~~ **已解决（2026-09-04，commit `80d908f`，见 [OPEN 清算条目](./2026-09-04-open-cleanup-cli-pin-and-slim-list.md)）**：bindings 生成两入口统一动态钉版到 go.mod 版本（`wails3 task bindings`），AGENTS §0.5 已补硬约束注记。**历史记录（2026-09-04 实测咬人）**：`wails3 task package` 用 PATH 的 beta.16 再生成 bindings，两条 CLI 线对 `ListAllSessions` 返回 map 的类型标注不同（alpha2: `Session[]|null`；beta: 不透明 `{}`），边界处直接写 `...map` 或 `list ?? []` 都会在另一条线下 tsc 报错。已修：`refreshAllSessions` 在唯一摄入边界显式 `as Record<string, Session[] | null> | null` 契约断言 + nullish 归一 `?? []`，两条生成线下均编译（557 测试 + 生产构建双验）。
3. SCM tab 冷态抖动（选中后 1 roundtrip 出现）：已知 cosmetic，单开 issue 再议（tab 恒渲染+置灰）。
4. `__mdRemote` 异步时序依赖：步 3 后最坏代价 = 1 次无害 ListPoppedSessions，未加固（定稿方案 §5）。

## 结论

四步方案按定稿顺序全部落地，每步原子 commit + worklog + 确定性测试。用户原始抱怨（PW/浏览器模式打开时 runtime 请求爆炸）在同数据集上从 **198~499 → 6**，桌面 GUI 的隐性同款风暴一并消除。
