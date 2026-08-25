# 2026-08-26 Review #24297 前端二轮:收尾 #24300+#24301(#130)——PASS + 1 处收尾修复

## 审查对象
- `81bd4cf` fix(frontend): 定时超限改拒绝+关行清空暂存+手输 24h 拦截(#24300)。
- `e40b252` test(queue): 拒绝语义 5 个 mount 测试(#24300)。
- `f7ecb18` feat(frontend): chip ✕ 就地重置 + cap 族文案对齐(#24301)。
- `b65c553` test(queue): ✕ 重置 3 路 mount 测试(#24301)。
- 范围仅前端(`frontend/src/`):QueuePanel.tsx / index.css / i18n(zh+en)/ mount 测试。

## 结论:**PASS**(四项重点全部核验通过;发现 1 处拒绝语义收尾不一致,已修复 + 复现测试,见下)

## 逐项核验(任务指定重点)

### 1. 拒绝语义 ✅
- `presetSchedule` 超 `now+24h`:**不写 pendingAt、不动 input**,只亮 cap——三条子路径
  (新鲜连点超限 / seed 叠加超限 / 遗留超限 seed 再点)共用同一拒绝代码,拒绝永不写值,
  时刻绝不回退(#24299 观察 #2 的向后跳已修)。
- 测试锚定值:seed 23h55m + 30m 被拒后 Save 提交值锚回 seed 区间且
  `< seed+30m`——同时排除「未叠加」与「钳到 24h」两种错误实现(§5.3 锚定值,非字段存在 ✓)。
- 边界:`>` 判定(== now+24h 合法);预设拒绝时清 `scheduleError`(cap 是最新裁决)。
- **无死路**:遗留 3 天 seed 开行后预设全拒 + Save 终门拦截,逃生口两个——手输合法时刻
  (onChange 路径,超限才拒)与 ✕ 就地重置(#24301 补的,恰好补掉了这个死路)。

### 2. ✕ 就地重置 ✅
- `resetStagedTime` = `resetStaging()`(清 pendingAt+scheduleCapped)+ 清 scheduleError +
  ref 回写 input 回默认(now+1m);行保持打开(`schedulingId` 不动),预设 base 回落 now,
  条目自身 `scheduledAt` 不动。程序化赋值不触发 onChange(与预设回写同款机制,无回环)。
- 3 个测试锚定可见结果:①+5+10 后 ✕ → 零提交/行开/chip 消/input 回 ~now+1m,再 +5 Save
  锚定 reset 时刻+5m(泄漏暂存会晚 ~10m);②cap 亮着 ✕ → chip 与 cap 同消;③10m seed 上
  ✕ → 再 +5 Save 锚定 now+5m(残留 seed 会 ~15m)。
- a11y/§4.5:✕ 有 `aria-label` + react-tooltip(md-tip)+ `data-testid`(§4.2 ✓);嵌套锚点
  (button 在 chip span 内)由 react-tooltip v6 就近解析覆盖。

### 3. 三层拦截 ✅
- L1 原生 `max`(镜像既有 `min`):测试锚定 ≈now+24h(1 分钟截断容差)。
- L2 onChange 拒绝:超限 pick 不进 pendingAt,input 回写暂存值(无暂存回默认)——回写目标与
  `presetSchedule` 的 base 规则一致;cap 亮、error 清。真实引擎路径,行为代码推演一致
  (happy-dom 不通电为文件头既有边缘)。
- L3 Save 终门:提交复验 `ts > now+24h` → 拦截亮 cap 不提交(与过期复验同款)。两个测试
  锚定:手输 3 天 → 0 提交 + cap(非过期错误)+ 行保持打开;遗留 3 天 seed → 终门拦下。
- 层间一致性:同一「超限」裁决在 L2/L3/preset 三处的可见结果一致(cap 提示 + 值不生效)。

### 4. 不回归 ✅
- `bun test src/components/QueuePanel src/i18n`:31/31(收尾修复前)→ 32/32(含本轮新增)。
- 全量 `bun test`:268 pass / 6 fail / 1 error = #24301 基线**完全同集**
  (NewSessionModal.mount 5 个 `mcpServerIDs` pre-existing + HarnessUpdateAwareness
  react-i18next ESM mock 边缘),失败文件与 QueuePanel 零交集。
- `bunx tsc --noEmit` 0 错误;`bun run build` 过(chunk 警告既有);
  `go build ./...` / `go vet ./...` 退出码 0(本轮 4 个代码 commit 均 zero Go 改动)。
- 取消回原值语义保持(`cancelSchedule` 不调 onSchedule);ticker 门(`hasPending || staging`)
  不变;全仓 grep 无 QueuePanel 六个测试文件与 i18n 之外的消费方,E2E 无引用。
- 反模式排查(类型补丁):新增 `scheduleResetTip`/`.queue-schedule-reset`/
  `queue-schedule-pending-reset` 全部有真实消费端(i18n 渲染 / CSS 命中组件类名 / 测试选择器),
  无死字段。

### 5. 2 处文案对齐钉死 ✅
- `schedulePendingTip`:zh「上限 24 小时」→「最多 24 小时,超出不生效」、
  en "capped at 24h" → "at most 24h ahead — beyond that is ignored"——与钉死口径一致
  (读作拒绝,不再像「超限会顶格」)。
- `scheduleCap` 本身即钉死基准(zh「超出 24 小时上限,已忽略」/ en "Exceeds the 24h cap —
  ignored"),#24301 未动它(git diff 核实)。
- zh/en 两键成对同位(zh/en.json 各 375-377 行),无插值参,`locales.test.ts` 过。

## 发现与收尾修复(reviewer 修,1 行 + 复现测试)
**Save 终门 cap 分支不清 stale `scheduleError`**(另两处 cap 触发点都清):
- 场景:过期值 Save 亮过期错误 → 改输 >24h 值 → Save 终门只 `setScheduleCapped(true)`,
  过期错误与 cap 提示**同时渲染**——同一值不可能既「已过期」又「超 24h」,互相矛盾。
- 真实浏览器到不了(onChange 会先清),但 Save 终门的存在意义恰是「兜 onChange 不通电的
  引擎」,在那个场景里矛盾双提示真实可见——属终门自身要硬化的路径上的真实瑕疵。
- 修法:`saveSchedule` cap 分支补 `setScheduleError(null)`(cap 是最新裁决,与 preset/
  onChange 同规则)。复现测试:「Save cap gate supersedes a stale expiry error」——
  **红绿实证**:unfix 后该测试 fail(双提示),fix 后过;32/32 全绿。

## 非阻塞观察(记录,不要求本次改)
1. ✕ 触屏命中区 ~22px(10px 图标 + 6px×2)< `.queue-btn` 的 40px 理想值——coder 已在
   worklog 说明(✕ 不是 .queue-btn,规则够不着);次级破坏性仅清暂存,可接受。
2. 遗留超限 seed 开行时 `defaultValue` 违反自身 `max` 属性(原生校验样式可能标红)——
   seed 设计使然(#24298 起),终门保底,逃生口存在,纯外观。
3. `schedulePendingTip` 文案「预设累加出的暂存时刻」未提手输也进 chip——#24298 既有措辞,
   不在本次钉死范围。
4. chip + ✕ 使桌面窄窗口(800-900px)nowrap actions 行理论溢出风险略增(~20px)——
   #24299 观察 #4 既有,量级不变。

## 验证
- 环境:worktree 补 `bun install` + `wails3 generate bindings`(与前两轮口径)。
- `bun test src/components/QueuePanel src/i18n`:**32/32 过**(schedule mount 16:12 既有 +
  1 改写遗留 + 3 ✕ + 1 本轮复现;收尾修复前为 31/31)。
- 红绿:stash 掉组件修复 → 新测试 fail(stale 错误 + cap 双提示);恢复 → 过。
- `bunx tsc --noEmit`:过。`bun run build`:过(chunk 警告既有)。
- 全量 `bun test`:**269 pass / 6 fail / 1 error** = 基线 268/6/1 + 本轮 +1,失败同集
  (NewSessionModal.mount 5 pre-existing + HarnessUpdateAwareness ESM mock 边缘)。
- Go 门禁 `go build ./...` + `go vet ./...`:退出码 0(本轮含修复均零 Go 改动)。
- 三端(§4.7/§5.6):收尾修复为组件逻辑等价小改(终门多清一个 stale 提示),无 CSS/DOM/
  断点/远程分支触及;纯前端同构 React 树,三端行为一致,无需另验。与前两轮同口径:
  **未做真机/浏览器手动冒烟**(mount 测试 + 构建 + 红绿为实证)。

## 下步
- OPEN(沿 #24299/#24300/#24301):onChange 手选/拒绝回写 + ✕ 路径的真浏览器 E2E /
  真机冒烟(一次覆盖全部新路径)。
- 既有:NewSessionModal.mount 5 个 pre-existing 失败(`mcpServerIDs`)另任务处理;
  QueuePanel 原生 title → react-tooltip 迁移(§4.5)仍是队列级清理任务。
