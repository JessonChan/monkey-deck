# 2026-08-26 #130 收尾2:chip 上补 ✕ 就地重置 + cap 族文案对齐钉死文案(Task #24301)

## 起因
[Issue #130](https://github.com/JessonChan/monkey-deck/issues/130) 累加式定时预设两轮落地(累加式 #24298 + 收尾 #24300)后的第二轮收尾:

1. **chip 上补 ✕ 重置按钮**:#24300 的「chip 补重置」只做了**状态卫生**(关行路径
   `resetStaging`,暂存不从关掉的行里漏出),用户可见的「清空暂存重新来」仍只能
   取消重开(两步)。本轮把重置做成 chip 上的 ✕ ——**就地**清空:行不关闭,
   预设重新从 now 起步。
2. **cap 文案对齐钉死文案**:#24300 把行为从「钳制」改成「拒绝」并钉死了
   `scheduleCap` 文案(「超出 24 小时上限,已忽略」,明确「未生效」而非「已顶格」),
   但 `schedulePendingTip` 仍残留旧钳制语言「上限 24 小时」/"capped at 24h"——
   与钉死口径不一致(读起来像「超限会顶格到 24h」)。本轮把 tip 对齐到拒绝口径。

> 注:GitHub issue 评论在执行环境不可达(API 限流/凭据失效),两项均按任务标题
> + 仓内证据(两轮前作 worklog + 现行代码)做最优解释执行;若用户在 issue 评论里
> 钉死了其它逐字文案,以此为准再校一轮即可(改动面只有 3 个 i18n key)。

## 改法
- **✕ 就地重置**(`resetStagedTime`):`resetStaging()`(清 `pendingAt`+`scheduleCapped`)
  + `setScheduleError(null)` + **ref 回写 input 回默认**(`defaultLocalInput()` = now+1m,
  程序化赋值不触发 onChange,无回环——与既有 onChange 拒绝回写同款)。行保持打开
  (`schedulingId` 不动),预设 base 回落 now,条目自身 `scheduledAt` 不动(组件不持有
  队列真相,等价取消重开的可见结果,但不关行)。
- **渲染**:✕ 按钮渲染在 chip span **内部**(文本之后),`X size={10}`(lucide,本文件
  既有 import);react-tooltip 走 md-tip 实例 + `aria-label`(§4.5,move 按钮同款);
  `data-testid="queue-schedule-pending-reset"`(§4.2)。
- **cap 文案对齐**:`schedulePendingTip` zh「上限 24 小时」→「最多 24 小时,超出不生效」、
  en "capped at 24h" → "at most 24h ahead — beyond that is ignored"——与钉死的
  `scheduleCap`(「超出 24 小时上限,已忽略」/"Exceeds the 24h cap — ignored")同一口径。
  `scheduleCap` 本身不动(它就是钉死基准)。
- **i18n 新增** `queue.scheduleResetTip`(zh/en 成对,`locales.test.ts` 奇偶校验过)。
- **CSS**:`.queue-schedule-pending .queue-schedule-reset` 无边框内联按钮(继承 chip
  琥珀色,3px padding 扩命中区,hover `--hover`/`--text` 变亮);≤768px 断点内补
  `padding: 6px`(触屏命中区;✕ 不是 `.queue-btn`,40px 规则够不着,显式补)。

## 改了哪些文件
- `frontend/src/components/QueuePanel.tsx`:`resetStagedTime` handler + chip 内 ✕ 按钮。
- `frontend/src/index.css`:`.queue-schedule-reset`(桌面)+ ≤768px padding(移动)。
- `frontend/src/i18n/locales/zh.json` / `en.json`:`schedulePendingTip` 改写 + `scheduleResetTip` 新增。
- `frontend/src/components/QueuePanel.schedule.mount.test.tsx`:文件头 pins 补第 5 条;
  新增 3 个测试(见下)。

## 验证
- `bun test src/components/QueuePanel src/i18n`:**31/31 过**(schedule mount 15 个:12 既有 + 3 新)。
  新测试锚定可见结果:①累加 15m 后 ✕ → 零提交、行开、chip 消、input 回
  ~now+1m(锚定区间),再 +5 Save 提交锚定 reset 时刻+5m(泄漏暂存会晚 ~10m);
  ②23h55m seed +30 被拒亮 cap 后 ✕ → chip 与 cap 同消、input 不再是远端 seed;③10m
  seed 上 ✕ → 再 +5 Save 锚定 now+5m(残留 seed 会提交 ~15m)。
- `bunx tsc --noEmit`:过(worktree 缺依赖/bindings,先 `bun install` + `wails3 generate
  bindings` 补齐,同前两轮口径)。
- `bun run build`:过(chunk 体积警告为既有)。
- 全量 `bun test`:268 pass / 6 fail / 1 error——失败与 #24300 基线**完全同集**
  (NewSessionModal.mount 5 个 `mcpServerIDs` 期望 pre-existing + HarnessUpdateAwareness
  react-i18next ESM mock 边缘),pass 数 265→268 即本任务 +3,与本改动无交集。
- Go 门禁 `go build ./...` + `go vet ./...`:退出码 0(ld 的 macOS 版本 warning 为环境
  噪音,同 #24300 记载;本任务零 Go 改动)。
- 三端(§4.7/§5.6):纯前端组件/CSS/i18n 改动,同构 React 树;✕ 只在定时编辑行
  开行且有暂存时随 chip 出现(交互触发),>768px 既有布局规则零改动,新增 CSS 均为
  新元素的专属规则;≤768px 仅断点内补命中区(新元素条件适配,M2 口径);无
  `isRemoteClient()` 分支触及;后端零改动无需重验。react-tooltip 嵌套锚点(chip span
  含 ✕ button)由 react-tooltip v6 的就近锚点解析覆盖——✕ 悬停优先显示自身 tip,
  退一万步也仍显示 chip tip(§4.5 不破)。与前两轮同口径:**未做真机/浏览器手动冒烟**
  (mount 测试 + 构建为实证)。

## 下一步
- 沿 #24299 review OPEN:onChange 手选路径的真浏览器 E2E / 真机冒烟(现又多了 ✕
  就地重置路径,可一并点验)。
- 既有:NewSessionModal.mount 5 个 pre-existing 失败(`mcpServerIDs` 期望)另任务处理;
  QueuePanel 原生 title → react-tooltip 迁移(§4.5)仍是队列级清理任务。
