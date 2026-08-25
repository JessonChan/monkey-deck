# 2026-08-26 #130 收尾:超限改拒绝 + chip 补重置 + 手输 24h 拦截(Task #24300)

## 起因
[Issue #130](https://github.com/JessonChan/monkey-deck/issues/130) 累加式定时预设落地后,review
(`2026-08-26-review-24299-queue-preset-accumulate-frontend.md`)留下几条收尾项,本任务拍板执行:

1. **超限改拒绝**:预设叠加超 24h 时原来是**钳制**(`at = cap`)。钳制有两个问题(review 观察 #2):
   一是把「丢了多少」藏起来了(点 +30 实际可能只加了 5 分钟);二是 base 本身已超 cap 时
   (遗留数据 seed 的 >24h 定时),钳制会让「加」按钮把暂存时刻**向后跳 ~48h**。
2. **chip 补重置**:暂存态(`pendingAt`/`scheduleCapped`)只在 `startSchedule` 重置;
   `cancelSchedule`/`saveSchedule`/`clearSchedule` 关行时不清,状态会从关掉的行里漏出去
   (虽然 chip 只在开行分支渲染、ticker 也被 `schedulingId` 门控,但属状态卫生缺口)。
3. **手输 24h 拦截**:原设计「手改 datetime = 覆盖暂存并清 cap」是自由逃生口,手选 3 天后
   也能直接保存。收尾改为手输同样受 24h 上限约束。

## 改法
- **预设拒绝语义**(`presetSchedule`):`base + mins > now+24h` 时**不写 pendingAt、不动 input**,
  只亮 cap 提示。统一覆盖「新鲜起步连点超限」「seed 叠加超限」「遗留超限 seed 再点 +」三条子路径
  ——拒绝永不写值,时刻绝不回退(修掉 review 观察 #2 的向后跳)。
- **手输三层拦截**:
  1. 原生 `max` 属性(`toLocalInput(now+24h)`,镜像既有 `min` 的做法)——picker 层直接禁选;
  2. `onChange` 拒绝:超限 pick 不进 pendingAt,input 用 ref **回写暂存值**(无暂存回默认 now+1m)
     保持 input↔pendingAt 双向联动的一致性(程序化赋值不触发 onChange,无回环),亮 cap 提示;
  3. `saveSchedule` 终门:提交复验 `ts > now+24h` → 拦截亮 cap 提示不提交(与过期复验同款,
     兜 onChange 不通电的引擎/happy-dom 边缘)。
- **关行全量清暂存**:新增 `resetStaging()`(清 `pendingAt`+`scheduleCapped`),cancel/save/clear
  三条关行路径统一调用——暂存态不再从关掉的行里漏出。
- i18n `queue.scheduleCap` 文案随语义改写:「已达 24 小时上限」→「超出 24 小时上限,已忽略」
  (en 同步),明确表达「未生效」而非「已顶格」。

## 改了哪些文件
- `frontend/src/components/QueuePanel.tsx`:presetSchedule 拒绝语义、resetStaging + 三关行路径、
  saveSchedule 24h 终门、input `max` 属性 + onChange 拒绝回写。
- `frontend/src/i18n/locales/zh.json` / `en.json`:`scheduleCap` 文案。
- `frontend/src/components/QueuePanel.schedule.mount.test.tsx`:钳制测试改写为拒绝语义;
  新增 4 个测试(遗留超限 seed 不回退+Save 终门、手输超限 Save 拦截、`max` 属性 ≈ now+24h、
  取消清空暂存重开从 now 重新起步)。

## 验证
- `bun test src/components/QueuePanel src/i18n`:**28/28 过**(schedule mount 12 个:7 既有含 1 改写 + 5 新)。
- `bunx tsc --noEmit`:过(worktree 缺 bindings,先 `bun install` + `wails3 generate bindings` 补齐)。
- `bun run build`:过(chunk 体积警告为既有)。
- 全量 `bun test`:265 pass / 6 fail——失败全部为 NewSessionModal.mount **pre-existing**
  (`mcpServerIDs` 期望,近两条 worklog 均有记载)+ HarnessUpdateAwareness 的 react-i18next
  ESM mock 边缘(1 unhandled error,亦既有),与本改动无关。
- Go 门禁 `go build ./...` + `go vet ./...`:过(零 Go 改动;ld 的 macOS 版本 warning 为环境噪音,退出码 0)。
- 三端(§4.7/§5.6):纯前端组件 + i18n 改动,无新元素/CSS/断点规则(cap 提示复用既有
  `.queue-schedule-cap`),同构 React 树;无 `isRemoteClient()` 分支触及;后端零改动。
  **未做真机/浏览器手动冒烟**(与上一条 #130 任务同口径),onChange 拒绝回写路径 happy-dom
  不通电(文件头既有边缘),由 Save 终门测试兜底覆盖行为结果。
- 行为边界自查:cap 上界取 `>`(== now+24h 合法可存,分钮截断到分钟只会更低不会误拦);
  暂存值只会随时间流逝变得「更不超限」(cap=now+24h 随 now 前移),不存在合法暂存被终门误拦。

## 下一步
- OPEN(沿上一条 review):onChange 手选路径(现含超限拒绝回写)的真浏览器 E2E / 真机冒烟。
- 既有:NewSessionModal.mount 6 个 pre-existing 失败(`mcpServerIDs` 期望)另任务处理;
  QueuePanel 原生 title → react-tooltip 迁移(§4.5)仍是队列级清理任务。
