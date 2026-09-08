# 2026-09-08 #208 busy session 切回跳过重拉 review(APPROVE)

## 背景 / 起因

审 #29047 实现(已合 main:3a1df6b fix(chat) 3 文件 +316/-3 + 310e250 worklog)。
反相核实,不采信 commit 叙事:门控正确性、镜像消费链、全量 clobber 路径、
未修树反向证明全部本机复推;顺手清一条测试遗留 debug log。

## 结论:**APPROVE**(①–⑤ 全过;2 条非阻塞观察记录在案)

### ① 门控只挡真正的整表替换点,无旁路 clobber ✓

`setItemsBySession` 全部 9 个调用点逐一核(App.tsx):

| 行 | 性质 | #208 影响 |
|---|---|---|
| 437 / 756 / 775 | chat:event / status 收尾,按事件 sessionId 归并 | 无(事件路径正是尾巴的写入方) |
| 961 | popout boot 快照 | 无(每窗口独立内存,boot 时空缓存) |
| 1135 | 切走丢弃(delete) | 无(受 shouldDropOnSwitch 保护谓词) |
| **1231** | **LoadMessagesPage 结果整表替换** | **唯一裸替换点,已被 targetBusy 门控(1195-1199)** |
| 1276 | loadMoreMessages 前插 | 无,且有双保险:`hasMoreBySession` 在切走时随缓存删除(1141-1146)→ skip 路径回看时 guard(1268)直接 return,`beforeSeq=0` 前插重复段的风险路径不可达 |
| 1374 / 1413 | 新建 session 种子 `[]` | 无 |
| 1917 | evictSessionCache | 用户显式关 tab/删 session,非本卡范围 |

`loadMore` 的 prepend 合并形态(`[...page, ...prev]`)本身不替换,排除。

### ② 反「类型补丁」核验:statusBySessionRef 全链路通电 ✓

- **定义** App.tsx:455-456(effect 提交,与既有 `statusRef` 同款时序);
- **写入源** ①chat:status 处理器 :712 按**事件 sessionId** 写(与选中无关,
  后台 session 的 prompting 确实进镜像);②mergeStatusSnapshot 快照合并(:619);
- **读取点** :1195 openSession 门控读**目标** session(不是 statusRef 追踪的
  选中者)——这正是加它的理由,无空壳。
- `BUSY_STATUS` 两个消费方都改常量(shouldDropOnSwitch + :1195);其余
  `"prompting"` 字面量(CloseTab 守卫 :2004、sendMessage :1447、Sidebar :851)
  语义各别(关闭确认/发送闸/状态点渲染),不属丢弃/重拉不变量,不强收。

### ③ 故意不标 loadedSessionsRef 的自愈闭环 ✓

:1199 `if (pullMessages) add(...)`——skip 时不标。回合结束后下一次
「切走(idle→丢)+ 切回」走既有重拉分支全量自愈,场景 3(空闲切回 2 次拉取
+ db-history 可见)即该路径的回归守卫。不新增状态,符合 §5.3。

### ④ 实证:4/4 绿(修后)+ 2 fail(未修树)反向证明 ✓

- 修后:`bun test src/App.busy-switch-back.mount.test.tsx` **4 pass / 0 fail**。
- 反向:`git checkout 3a1df6b~1 -- App.tsx sessionDrop.ts` 后重跑
  **2 pass / 2 fail**——漂移场景 fail 于 `loadCount("s1")` 期望 1 实得 2
  (重拉真实发生,clobber 复现),两个行为守卫场景保持 pass,与 worklog
  宣称的覆盖划分一致。核后已还原(diff 对 3a1df6b 为空)。
- `bunx tsc --noEmit` 0 错。
- 测试断言全部锚定值:拉取次数 + 尾巴文本存在 + **负断言**
  (`db-history` 不得出现,出现即 clobber 显形),无字段存在性断言。
- 环境重建(worklog 记录的一次性步骤):`bun install` + `wails3 task bindings`,
  产物 gitignore 未混入。

### ⑤ worklog 与 diff 一致,三端/边界如实 ✓

310e250 与实际改动逐项对得上;纯逻辑改动零 UI 面(i18n/testid/响应式
N/A);「未做实机 GUI 走查」如实标注,行为由 mount 测试(真 App 链路)
锁死,桌面视觉走查留用户 `wails3 dev`,记录诚实。

## 本 review 附带修改

- `frontend/src/App.busy-switch-back.mount.test.tsx`:删测试 4 遗留的
  `console.log("DBG s2 after bg chunk:", …)`(调试噪音混入正式测试);
  删后重跑 4/4 绿。

## 非阻塞观察(记录,不要求本卡改)

1. **remote:resync 对 skip 路径 session 不再兜底**:resync 强拉 guard 是
   `loadedSessionsRef.has(sid)`(:879),而 skip 路径故意不标 → 选中该
   session 且回合已结束(已 idle)时,WS 断连窗口内已落库段缺失不再被
   resync 强拉补回,直到一次切走/切回周期。仅 remote 端(custom.js 桌面
   404),且未修时该状态的行为本身就是 clobber bug,净改善;未来若做
   resync 精化,可把「强拉与否」下放给 openSession 的 busy 门控而非
   has(sid) 判断。
2. **门控与 :1165 `void syncSessionStatuses()` 的同调用内时序**:快照合并
   异步落 state→effect 才进镜像,同一次 openSession 里门控(1195,同步读)
   读不到它——若 prompting 推送真丢且快照尚未合并过,该次切回仍会拉一次
   (clobber 一次)。实际 WS 丢失场景由 resync 先行 syncSessionStatuses
   兜住,窗口极窄;回合结束 + 切换周期自愈。记录备查。

## 下一步 / 留人

- 桌面端视觉走查(切走正忙 session 再切回,尾巴不闪不丢)留用户
  `wails3 dev` 实测(worklog 已标)。
- 不 push、不关 issue。上层复核本 APPROVE 后按 completed-ready 流转。
