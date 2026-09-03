# 步1 F1(b)：boot 会话列表 fan-out 在途去重（请求风暴修复第一刀）

> 上游：[2026-09-03-pwa-runtime-request-storm-diagnosis.md](./2026-09-03-pwa-runtime-request-storm-diagnosis.md)（定位）· [2026-09-03-runtime-request-storm-final-plan.md](./2026-09-03-runtime-request-storm-final-plan.md)（定稿方案）。本条是四步方案的第 1 步。

## 起因

浏览器模式（PWA/远程）每次打开页面产生 198~499 个 `/wails/runtime` 请求，82% 是 `ListSessions` 的 7 轮重叠补发（31 项目实测 163 次，O(P²) 最坏 496）。根因：boot mount effect 对每个项目发 `ListSessions`，每个响应落地 → `setSessionsByProject` → effect 重跑 → 对「响应未落地」的项目**再发一轮**。守卫只看「已落库」不看「在途」。**桌面 webview 同一段代码，同样风暴**。

## 改法

`App.tsx` boot 循环（原 972-979）调用点加 `bootSessionsFetchingRef: Set<string>` 在途去重；**不动 `refreshSessions` 本体**——事件驱动（chat:status prompting）、resync、selectProject、openSession 四类调用点全部不经守卫、永远直发。

实施中发现定稿方案代码的一个落地级缺陷并修正：**成功路径不能在 finally 里删 Set 项**。React 18 的 passive effect 是异步调度的：某项目的 `finally`（删 Set）可能跑在「它自己的 setState 提交」与「下一次 effect 补跑」之间——此刻该项目既不在 map 也不在 Set → 整轮补发复现（实测 61 次）。修正为**成功保留 Set 项作 boot-once 墓碑，仅失败（catch）时删除以允许后续 effect 重跑补试**：成功路径对 Set 零 mutation，竞态窗口不存在。T1 测试日志实证：finally 版 set=29/map=1 时触发 30 连补发；墓碑版 31 恰好。

失败重试语义（有意为之，非遗漏）：多项目场景下失败项由「其它项目落地触发的 effect 重跑」自动补试；仅「最后一个失败项」可能停留到下次 resync/手动刷新。不加定时器。

## 改动文件

- `frontend/src/App.tsx`：boot 循环加在途去重（含 try/catch 顺修现存 unhandled rejection——原 `void refreshSessions(...)` 对 reject 无捕获）；触及的中文注释转英文（§3.7）。
- `frontend/src/App.boot-budget.mount.test.tsx`（新增）：T1-T4。

## 验证

- **T1（先红后绿）**：deferred 逐个 resolve + 每次 `await flush(1)` 强制「每响应一次 commit」——修复前 **496 次**（=31+30+…+1，理论 O(P²) 上限，与线上实测吻合），修复后 **31 次恰等**、31 项目各恰 1 次。
- **T2**：happy path 31 项目全加载，含 0-session 项目（p10/p20/p30 不被跳过）。
- **T3**：boot 完成后 `chat:status=prompting` 仍能强制刷新（该 pid ≥2 次）——事件路径不受守卫影响。
- **T4**：某项目首次 reject → 无 unhandled rejection（修复前 bun test 直接报裸错）→ 后续 effect 重跑自动补试 ≥2 次。
- 全量 `bun test`：546 测试，修复前后失败集合对比**零新增**（存量 16 个失败在干净 HEAD 同样失败：clipboard/copyText/ErrorCard/GenericToolCard/AgentMarkdown/FilePanel/panel-layout/cmd-digit-tabs，与本次改动无关，不夹带修）。
- 三端（§4.7）：本步为纯前端共享路径，三端同跑同一逻辑；自动化以 mount 测试覆盖（真实 App 组件 + 桩 binding），真机冒烟并入后续 E2E 条目。

## 下一步

步 2（F4' git 懒探测）→ 步 3（F3 ListAllSessions+ListPoppedSessions 原子）→ 步 4（F2(ii) resync 合流）。
