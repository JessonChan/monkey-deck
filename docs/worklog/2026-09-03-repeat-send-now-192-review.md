# 2026-09-03 Review #28978:#192 repeat 免过期误拦(QueuePanel repeat 分流)前端审查

日期:2026-09-03
状态:**APPROVE**(前端范围;三条非阻塞备注,无遗留修改请求)
任务:Task #28978,审 Task #28977 产物——两 commit:`73f1d96`(fix(queue) QueuePanel + 新 mount 测试)/ `3eca1f9`(worklog)。
方法:反相追踪,不信 commit 叙事。逐行读 `QueuePanel.tsx` 全量(855 行)+ 新测试全文 + diff 对照规格四点;**类型补丁反模式逐字段追消费端**;RED/GREEN 双态独立复跑。

## ① 规格四点逐条对源 —— PASS

1. **repeat 分流(规格①)**:`saveSchedule` 头部、**先于**过期复验的分支(`repeatPickedMs > 0 && !datetimeDirty`)→ `onSetRepeat?.(id, repeatPickedMs)` 重申(幂等,兜选择丢包)+ `onSchedule(id, Date.now())`(首发立即;循环自发送起算——后端 `rescheduleRepeat` 的 `nextAt = send + interval` 零改动,前端只负责锚到提交时刻)+ staging 全清 + 关行。`clearSchedule` due-now 先例同款。✓
2. **dirty 语义(规格②)**:`datetimeDirty` 唯一置位点 = datetime 控件的 `onInput`(QueuePanel.tsx:458);四处程序化写入(种子默认、preset 叠加 :318、Reset 回弹 :241、cap 回弹 :470)均不走 input 事件 → 永不置 dirty,与注释声明一致。组合态走完整复验,且**守卫次序保留**(过期先于 24h cap,:270→:277)。✓
3. **UX(规格③)**:`disabled={repeatOnly}` + `min={repeatOnly ? undefined : ...}`(:442/:451);组合态保持可用(测试③断言 disabled=false + min 在)。禁用态下 onInput 不可触发 → dirty 恒 false,状态自洽。✓
4. **纯定时零改动(规格④)**:过期复验 + 24h cap 表达式、次序、错误提示一字未动;选「不重复」(repeatPickedMs=0)正确回落纯定时路径(repeatOnly 要求 >0)。✓

## ② 类型补丁反模式追查(全链路消费端逐一确认)—— 无死字段

- `datetimeDirty`:置位 onInput → 消费 `repeatOnly`(:133)+ saveSchedule 分支(:255)→ 重置 `startSchedule`/`resetStaging`(开行 + 全部五种关行路径覆盖:cancel/save/clear/徽标✕/Reset)。**活**。
- `repeatPickedMs`:置位 applyRepeatTier(:338,含 0=不重复)+ applyRepeatCustom(:350)→ 消费同上 → 重置同上,不泄漏出已关行。**活**。
- `repeatOnly`:消费 min(:442)+ disabled(:451)。**活**。
- Props 签名零变化 → 无 binding 重生成、无 App.tsx 接线需求;`onSetRepeat` undefined 时(可选 prop)两置位入口 early-return → repeatPickedMs 恒 null → 分支不触发,优雅回落旧行为。✓

## ③ 测试质量 —— PASS(断言锚定值,非字段存在)

- 场景矩阵 = 规格要求「三场景+对照」:repeat-only 直发 / 纯定时键入过去(拦)/ 组合键入过去+选档(拦 + 控件保持可用)/ 超 24h(cap 提示,非过期错)。
- **锚定值实证**:`scheduleCalls` **toEqual `[{id:"q1", at: T0+3000}]`**(冻结时钟下精确到 ms,非「被调用过」);非提交路径一律 `toHaveLength(0)`;repeatCalls 校验档位精确值 + 提交时重申;行关闭/留开均有断言。
- 复现 rig 严谨:T0 = 分钟边界前 1s → 种子默认值(分钟截断)恰领先 1s,推进 3s 即稳定复现「停留数秒 → 过期」,命中 #192 根因形状。
- **RED 独立复跑(本审)**:换入 `73f1d96^` 的 QueuePanel.tsx → 恰好 repeat-only 1/4 红、三对照保持绿(与 worklog 声明一致);还原后 4/4 绿。`git status` 净。

## ④ 环境发现核实(onInput 载体)—— 成立

React onChange 合成在 happy-dom + datetime-local 下不可达、onInput 可触发且生产环境两者同源(同一原生 input 事件)——dirty 挂 onInput 是「生产语义不变 + 测试可驱动」的正确载体选择;置脏为布尔幂等,set 多次无害。生产面(WebKit/WebView2)显式编辑必发 input 事件,无死区。

## ⑤ 本审独立验证

- `bun test src/components/QueuePanel.repeat-send-now.mount.test.tsx`:**4/4 绿**;
- `bun test src/components/QueuePanel`(全 QueuePanel 套件,11 文件):**56/56 绿**(存量 schedule/repeat/staged 测试无回归);
- `bunx tsc --noEmit`:50 个 TS2307 全部为 `frontend/bindings/` 生成物缺失噪音(wails3 生成物不入库,本 worktree 未生成),**0 个错误触及 QueuePanel/本次改动文件,0 个非 TS2307 错误**;
- i18n:零新增 key(复用 `queue.scheduleExpired`/`queue.scheduleCap` 等),zh/en 无需同步;
- a11y:data-testid 全保留,`disabled` 原生可感知,无新交互元素;#182 staged 常驻占位 DOM 结构未动。

## 非阻塞备注(不要求本期处理)

1. **preset × repeat-only 的 chip 语义**:先 preset 叠加(或选档后)再选循环档 → repeat-only 态下 staged chip 仍显示「+N分钟 → HH:mm」,但 Save 走直发分支丢弃该 staging(chip 只剩信息性)。与冻结规格一致(dirty 仅认显式输入编辑;首发立即),但 chip 在该态有误导可能——后续打磨候选:进入 repeat-only 时清空/隐藏 staged chip。
2. `saveSchedule` :255 内联重复了 `repeatOnly` 谓词(与 :133 同式),可引用派生常量;纯 DRY nit。
3. 已带循环的条目重开行、**不重选档**直接 Save:repeatPickedMs=null → 纯定时路径,过期默认值仍可拦。属规格④冻结面(纯模式行为不变)且仅见于「循环项异常到期」的罕见态,如实保留,不算 #192 回归。

## 下一步

- 前端范围 **APPROVE**,停 completed-ready:**不 push、不关 issue、不派卡**(流程约定);
- 真机 repeat 提交手感(选档 → Save 立即首发、循环自提交时刻起算、组合态过期仍拦)留人,与 coder worklog 的「下一步」一致;
- happy-dom onChange 死区 / onInput 可用的实测结论是否回填 AGENTS §5.4 坑表,交 orchestrator 裁决。
