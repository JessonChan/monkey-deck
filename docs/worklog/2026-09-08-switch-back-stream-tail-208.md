# 2026-09-08 fix: busy session 切回跳过重拉,保流式尾巴(#208)

## 起因

Task #29047(issue #208):busy(流式回合进行中)session 切走再切回时,前端会从 DB 重拉消息,
把仍在内存里累积的流式尾巴冲掉。规格为冻结描述:「切回跳过重拉,保流式尾巴」。

## 根因(纯前端,`frontend/src/App.tsx` openSession)

两层机制叠加出一个漏洞窗口:

1. **切走丢弃**(2026-07-18 内存优化):`shouldDropOnSwitch(old, new, statusRef.current)` 在
   旧 session 状态非 `prompting` 时丢弃其 `itemsBySession` 缓存与 `loadedSessionsRef` 标记。
2. **切回重拉**:`pullMessages = !loadedSessionsRef.has(target)` 决定是否 `LoadMessagesPage`,
   拉回结果**整表替换** `itemsBySession[target]`。

正常路径下「切走时正忙 → 保护不丢 → 切回 `loadedSessionsRef` 命中 → 不重拉」自洽。但
`chat:status` 的 `prompting` 推送存在**晚到窗口**(发送后立刻切走、推送未处理;或 WS 断连
丢推送):切走瞬间状态仍读作 `empty` → 缓存被丢;而 `chat:event` 处理器按**事件所属
sessionId** 写缓存(与选中无关),后台 chunk 持续重建出一个只含尾巴的新缓存。此时切回,
`loadedSessionsRef` 无记录 → 触发重拉 → 整表替换把未落库的流式尾巴(含进行中气泡)清掉,
后续 chunk 归并不到原条目 → 内容丢失 + 段重复。

## 改法

- `sessionDrop.ts` 新增 `BUSY_STATUS = "prompting"` 常量,收拢「回合进行中」这一状态字面量
  (切走丢弃谓词与切回门控两个消费方共用,§5.3 找不变量)。
- `App.tsx`:
  - 新增 `statusBySessionRef`(全量 per-session 状态镜像,与既有 `statusRef` 同款
    effect 提交时序;openSession 是稳定 callback,需要 ref 读**目标** session 的状态——
    它不是 `statusRef` 追踪的选中者)。
  - `openSession` 重拉门控加忙态条件:`!loadedSessionsRef.has(id) && !targetBusy` 才拉。
    **故意不**在跳过时标记 `loadedSessionsRef`:回合结束后下一次「切走(空→丢)+ 切回」
    仍走既有 DB 重拉分支,全量历史自愈,不新增状态。

### 已知副作用(接受并记录)

`remote:resync` 对选中 session 的强制重载走同一条 `openSession` 路径:选中 session 忙时,
resync 不再强制重拉。这是**改善**而非回归——重拉返回的 DB 页同样不含未落库的进行中尾巴,
替换反而造成半截段重复;重连后事件流继续灌尾巴才是正确对账。

## 改了哪些文件

- `frontend/src/lib/sessionDrop.ts`:`BUSY_STATUS` 常量 + 谓词改用常量(行为不变)。
- `frontend/src/App.tsx`:`statusBySessionRef` 镜像 + `openSession` 忙态重拉门控。
- `frontend/src/App.busy-switch-back.mount.test.tsx`:新增,4 个 mount 测试(真 App →
  Sidebar → openSession 链路,binding 全 mock)。

## 验证

1. **新增 4 场景全绿**(`bun test App.busy-switch-back.mount.test.tsx`):
   - 忙态目标首开:0 次 `LoadMessagesPage`,事件构建的尾巴正常渲染;
   - 漂移场景(切走时状态未到 → 缓存被丢;prompting 推送晚到 + 后台 chunk 重建尾巴):
     切回 0 次重拉,尾巴完整,DB 页内容不可见(可见即说明被 clobber);
   - 空闲切回仍重拉(2026-07-18 行为回归守卫):2 次拉取,DB 页渲染;
   - 受保护忙态切回(缓存未丢):1 次拉取,DB 种子 + 尾巴共存。
2. **回归价值实证**:`git stash` 掉 App.tsx 修复后重跑——两个忙态场景转 fail,两个行为
   守卫场景保持 pass,与预期覆盖划分完全一致。
3. `bunx tsc --noEmit` 0 错;`bun run build` 通过。
4. **全量套件对账**:`bun test` 我的树 vs 干净树(`git stash`)失败集合**逐条 diff 相同**
   (各 21 条既有失败;干净树额外多出的 2 条正是本修复的两个忙态场景,即未修必 fail 的
   反向证明)。既有失败均为环境性(见下),与本改动无关。

## 注意 / 已知(后续任务素材,非本卡范围)

- **本 worktree 环境下存在 21 条既有前端测试失败**(clipboard 系 / KaTeX quirks-mode /
  面板布局持久化 / worktree-guard 等)。根因之一:`test/chatservice-mock.ts` 被**静态
  import**(为取 binding 全量方法名),导致真实 binding + `@wailsio/runtime` 在 mock 注册前
  已求值;当前 bun(1.3.14)的 `mock.module` 不会重链已求值模块 → 依赖该 helper 的 mount
  测试(worktree-guard 4 条)在干净 main 上同样全红。新测试因此改用**内联全量 surface**
  (方法名从生成的 binding 源码文本解析,不 import 模块,新增方法缺 mock 会显式报错)。
  修复 chatservice-mock(惰性化)应另开任务。
- 本 worktree 环境重建步骤(一次性,gitignored 不入库):`bun install` + `wails3 task bindings`。
- 未做实机 GUI 走查:行为逻辑由 mount 测试锁死(真实 App 组件 + 事件注入),桌面端
  视觉验证(切走正忙 session 再切回,尾巴不闪不丢)留给用户 `wails3 dev` 实测。

## 分支 / 提交

- 基于 main 最新 `ab827bb`,worktree 分支 `agent/coder/a64e7be9`。
- commit 1:fix + 新增测试(原子);commit 2:本 worklog。
- 按任务要求:不 push、不派 review、不关 issue,完成后停止。
