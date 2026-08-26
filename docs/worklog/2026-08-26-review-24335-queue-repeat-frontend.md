# 2026-08-26 Review #24333 队列循环发送前端:自定义档可达性 / binding 对齐 / i18n / 触控 CSS

## 起因

Task #24335:frontend review #24333 的前端提交 `63b02d4`(QueuePanel 循环档 select + 循环徽标 +
一键取消 + i18n;后端两提交已由 Task #24334 review APPROVE)。审五件事:循环档交互正确性(尤其
「自定义」路径)、binding/wire 全链路对齐(类型补丁反模式)、i18n zh+en 同步、≤768px 触控 CSS、
测试锚定质量。审查方法:反向追踪消费链 + **实证复现**(happy-dom 探针),不顺着 commit 叙事走。

## 核查结论(逐项)

### 1. 「自定义」档不可达(P1,阻塞)—— 实证复现

`applyRepeatTier("custom")` 提前 return(QueuePanel.tsx:216),**不设任何本地 state、不提交**;
而分钟输入框的渲染条件是 `repeatTierOf(item.repeatEveryMs) === "custom"`(:438)——读的是**服务端
镜像状态**。select 是受控组件(`value={repeatTierOf(...)}`,:426)。于是普通项(生产中绝大多数,
repeatEveryMs=0)选「自定义」:

- 无 setState → 无重渲染 → 输入框**永不出现**;任何旁路重渲染(如 pending 项的 1s ticker、任意
  `chat:queue` 快照)还会把 select 弹回「不重复」。
- **环死锁**:奇数间隔只能靠这个自定义输入设置,而输入框只在已有奇数间隔时显示——生产环境
  **没有任何路径**能产生奇数间隔。自定义分支、1~1440 前端门、Apply 按钮、5 个相关测试在产品里
  全是不可达死代码。
- 探针复现:mount 普通项 → 选 custom → flush → `queue-repeat-custom` 为 null(断言失败,确认)。
- **测试为什么是绿的**:「custom seeding」用例直接在 props 里注入 `repeatEveryMs: 7*60_000`——
  一个生产不可达的状态。正是「测试制造了不可达状态 → 绿但功能死」的漏报形态(反模式清单:
  断言锚定值之外还要锚定**可达性**)。

修法方向(留修复任务):本地 reveal state(如 `customTierOpen`),`applyRepeatTier("custom")` 置位、
`startSchedule`/`resetStaging` 复位;渲染条件与 select 显示值都consult它;补「普通项 → 选自定义 →
输入框出现 → Apply 提交奇数分钟」的 mount 用例。

### 2. binding / wire 全链路对齐 —— PASS

- 生成 binding(`wails3 generate bindings` 后核验):`SetQueueItemRepeat(sessionID, itemID,
  repeatEveryMs, maxSends)`;App.tsx:1325 调 `(sid, id, repeatEveryMs, 0)` 四参对齐,maxSends=0
  (无限)无 UI 档、有注释说明。错误经 `extractErrMsg → setError` 面世(与 scheduleQueueItem 同形)。
- wire 消费链反向追踪闭合:Go `repeatEveryMs`/`sentCount` json 标签 → `wireQueueItems`(queue.go:112)
  透出 → App `queueBySession` → ChatView 透传 → QueuePanel 真实读取(档位 select 值 :426、
  自定义种子 :447、徽标 :512/:519、里程 :520-522)。无「字段加了没人消费」的类型补丁。
- TS `QueueItem` 两个可选字段与 wire(恒序列化,无 omitempty)兼容,缺省语义(0/absent=普通项)
  与后端一致。

### 3. 徽标 / 取消 / 与 #97 共存 —— PASS

- 徽标渲染条件 `(repeatEveryMs ?? 0) > 0`,与定时倒计时徽标互不排斥(测试钉住共存);里程仅在
  sentCount>0 显示(测试钉住)。
- 徽标 ✕ = `cancelRepeat(id, 0)`,不依赖开 schedule 行(测试钉住「schedule row 未开过」)。
- 预设档选中即提交(毫秒锚定值 300000/1800000/3600000,测试断言精确 ms);「不重复」提交 0。
- IME 三重保险(composingRef + isComposing + keyCode 229)在自定义输入 Enter 上与文件既有模式一致。
- `repeatTierOf` 整分换算对预设 ms 集合精确命中,无浮点边角。

### 4. i18n —— PASS(附带 2 个不阻塞小记)

- zh/en 键集合**程序化比对完全一致**(各 13 个 repeat* 键)。commit message 写「11 键」实为 13,
  纯文案勘误。
- `repeatSent` 用 `count` 插值会触发 i18next 复数查找(`_one`/`_other`),当前仅基键、走 fallback
  渲染 `sent 3×`/`已发3次` 正常;若未来 en 需要 "once" 措辞再补 `_one`。FYI。

### 5. CSS / 触控 —— PASS(1 个 P3 备查)

- ≤768px:`.queue-repeat-tier` 全宽 wrap + select/input `min-height: 40px`;Apply 按钮类名含
  `queue-btn`,被该断点下的通用 `.queue-btn { min-height: 40px }`(index.css:3110)覆盖——#126B
  40px 触控达标。徽标 ✕ 触控区 `padding: 6px` 与 #130 staged-chip ✕ 同形。
- 徽标 `white-space: nowrap; flex-shrink: 0` + 文本列 flex: 1 ellipsis——读态行无溢出风险。
- **P3**:桌面(>768px)schedule 行不 wrap,自定义模式下(datetime + 3 preset + save/cancel +
  select + 64px input + Apply)在窄桌面窗口可能横向溢出(`.queue-panel` 无 overflow 处理)。当前因
  P1 不可达而未显形;修 P1 时顺手让 tier 行桌面也允许 wrap 或收窄。

### 6. §4.5 tooltip 硬约束 —— 违规(P2,阻塞)

新增 Apply 按钮用**原生 `title`**(QueuePanel.tsx:461),而同一 commit 的新元素(档位 span、徽标 ✕)
都正确用了 `data-tooltip-id="md-tip"`。AGENTS §4.5 禁用原生 title(新代码)。本文件既有大量原生
title 为历史欠账、不属本 diff;但本次**新增**了一个实例,且该按钮同时缺 aria-label。修法:换
`data-tooltip-id` + `data-tooltip-content` + `aria-label`(照抄同 commit 徽标 ✕ 的三件套)。

## 验证

- `wails3 generate bindings` 重新生成(本 worktree 缺 gitignore 中间产物),核验 SetQueueItemRepeat 签名;
  `bun install` + `bunx tsc --noEmit` 干净(tsconfig exclude 测试文件为既有约定)。
- `bun test src/components/QueuePanel*`:37/37 全绿(含新 7 例)。
- 全量 `bun test`:314 pass / 35 fail——失败集中在 sttClient/mermaidExport/ModelSelect 等**本 PR 未触碰**
  的文件;基线提交 `2bde4ac` 全量跑为 203 pass / **68 fail**/18 error(更差),且这些文件单跑即过
  → 全量失败为既有的跨测试污染/ESM 环境问题,非本次回归。
- P1 探针(happy-dom mount + 原型 setter 派 change):普通项选 custom 后 `queue-repeat-custom`
  断言为 null——失败即复现,探针已删未入库。
- 三端矩阵(§4.7/§5.6):本次改动纯前端组件层,无 `isRemoteClient()` 分支、无 WS/事件面改动、
  无 PWA 专属逻辑;`chat:queue` 快照消费路径三端同构(浏览器/PWA 走同一 WS 面)。徽标/档位为纯
  CSS+DOM,≤768px 断点行为已核;桌面零改动面(无 >768px 布局变更)。P1 修复后需按矩阵回归。

## 结论

**REQUEST_CHANGES**——两个阻塞项:

1. **P1 自定义档不可达**(功能死路径,headline 特性不工作;测试以不可达状态注入掩盖);
2. **P2 Apply 按钮原生 title**(§4.5 硬约束,新代码违规)。

其余门槛(binding/wire 对齐、徽标/取消交互、i18n 同步、触控 CSS、测试锚定质量)核实通过;
1 个 P3(桌面自定义行宽)与 2 个 FYI(i18n 复数、commit 键数勘误)记录在案。

## 下一步

- 修复任务:QueuePanel 本地 `customTierOpen` state 接通自定义档 reveal + select 显示值;Apply 按钮
  tooltip 三件套;补「普通项 → 自定义 → 输入框出现 → Apply 提交」mount 用例;顺手评估桌面 tier 行
  wrap(P3)。修完按三端矩阵回归 + 本 review 复验。
