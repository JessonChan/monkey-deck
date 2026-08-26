# 2026-08-26 修复 review #24335 缺口:自定义循环档可达(本地 reveal state)+ Apply 按钮 react-tooltip

## 起因

Task #24336:落实 review #24335(`docs/worklog/2026-08-26-review-24335-queue-repeat-frontend.md`,
REQUEST_CHANGES)的两个阻塞项 + 顺手项 P3:

1. **P1 自定义档不可达(功能死路径)**:`applyRepeatTier("custom")` 提前 return 不设任何本地
   state,而分钟输入框渲染条件与 select 显示值都读**服务端镜像** `repeatTierOf(item.repeatEveryMs)`
   ——普通项(repeatEveryMs=0)选「自定义」时什么都没提交、`chat:queue` 快照永不回流,输入框
   永不出现,任何旁路重渲染(ticker/快照)还会把 select 弹回「不重复」。环死锁:奇数间隔只能靠
   自定义输入设置,而输入框只在已有奇数间隔时显示 → 生产环境没有任何路径能产生奇数间隔。
2. **P2 Apply 按钮原生 `title`**(§4.5 硬约束,新代码违规):应换 react-tooltip 三件套
   (`data-tooltip-id` + `data-tooltip-content` + `aria-label`,照抄同 commit 徽标 ✕)。
3. **P3(顺手)**:桌面(>768px)schedule 行不 wrap,自定义模式下整行内容在窄桌面窗口可能
   横向溢出——P1 修好后该症状显形,顺手放开 wrap。

## 改法

### P1:本地 reveal state(review 指定修法)

`QueuePanel.tsx` 新增 `customTierOpen` 布尔 state,按 review 方向接线:

- `applyRepeatTier("custom")` → `setCustomTierOpen(true)` 后 return(不提交);
- **选预设档 → `setCustomTierOpen(false)`** 再提交(review 文字没写但必须:否则从 custom 切
  预设后 `customTierOpen` 仍 true,select 永远显示 custom、输入框藏不掉);
- `startSchedule` / `resetStaging` 复位 false(reveal 不泄漏出关闭的行,与 pendingAt/
  scheduleCapped/repeatError 同一套 staging 纪律);
- map 体内算 `tierValue = repeatTierOf(mirror)`、`customVisible = customTierOpen ||
  tierValue === "custom"`,**select 显示值(`customVisible ? "custom" : tierValue`)与输入框
  渲染条件(`customVisible`)都 consult 它**——镜像自己的奇数间隔(legacy seeding)不加 flag
  也保持输入框可见 + 分钟预填。

已知并接受的瞬态:选预设后到快照回流前,select 显示旧镜像值(如 0)——这是本 select 受控于
镜像的既有行为(P1 之前选预设就是如此),不是本次引入;不做乐观 staging(KISS,快照回流快)。

### P2:Apply 按钮 tooltip 三件套

`title={t("queue.repeatApplyTip")}` → `data-tooltip-id="md-tip"` +
`data-tooltip-content` + `aria-label`(与同 commit 徽标 ✕ / 档位 span 完全同形)。

### P3:桌面 schedule/edit 行 wrap

`index.css` 基础 `.queue-item-edit` 加 `flex-wrap: wrap; row-gap: 6px;`(宽窗口无溢出 →
无 wrap,渲染不变;窄窗口优雅换行不溢出卡片)。≤768px 断点里原有的
`.queue-item-edit { flex-wrap: wrap; }` 变冗余,删除(Less is More);该断点其余规则
(flex-basis 100% 家族)不受影响。

## 改了哪些文件

- `frontend/src/components/QueuePanel.tsx`:`customTierOpen` state + 接线(P1)、Apply 按钮
  tooltip 三件套(P2)、组件头注释与相关行内注释同步。
- `frontend/src/index.css`:`.queue-item-edit` 基础规则 wrap(P3)+ 删移动端冗余行。
- `frontend/src/components/QueuePanel.repeat.mount.test.tsx`:文件头 pins 补第 5 条 + 3 个新
  mount 用例(见下)。

## 验证

- **测试**:`bun test src/components/QueuePanel.repeat.mount.test.tsx` 10/10(7 旧 + 3 新);
  全部 QueuePanel 套件 40/40。新增 3 例:
  1. **可达性锚定(review 点名的漏报形态)**:普通项(repeatEveryMs=0,生产可达状态)→ 开
     schedule 行 → 选 custom → select 显示 "custom" + 输入框出现 + **零提交** → 输入 7 →
     Apply → `onSetRepeat("q1", 7*60_000)`——生产中产生奇数间隔的唯一路径,现在端到端可达。
  2. **reveal 不泄漏出关闭的行**:custom 打开 → cancel → 重开 → select 回 "0"、输入框消失、
     零提交(props 未变,证明是本地 reset 而非镜像)。
  3. **预设切换清 reveal**:custom 打开 → 选每5min → 提交 300000 + 输入框消失。
- **TS/构建**:`wails3 generate bindings` 重新生成(worktree 缺 gitignore 中间产物)后
  `bunx tsc --noEmit` 干净;`bun run build`(tsc + vite production)通过(chunk 体积警告为
  既有)。
- **Go 门**:`go build ./...` + `go vet ./...` 干净(ld 的 macOS 版本警告为既有工具链噪音;
  本次零 Go 改动)。
- **三端矩阵(§4.7/§5.6)**:本次为纯前端组件 + CSS 改动,无 `isRemoteClient()` 分支、无
  WS/事件面改动、无 PWA 专属逻辑,三端(GUI/远程浏览器/PWA)共享同一组件与 CSS,行为同构
  ——与被 review 的原 PR 同一判定。CSS 改动逐端推演:桌面 >768px 仅在原本会横向溢出的窄窗口
  才发生 wrap(宽窗口无溢出无变化);≤768px 移动端净行为不变(wrap 从断点规则移到基础规则,
  计算值相同)。未能起真机三端冒烟(worktree 环境),判定依据为组件层无端分支 + mount 测试 +
  构建通过,与 review 原验证同口径。

## 下一步

- 复验:按 review #24335 的「下一步」清单,修复已覆盖 P1/P2/P3 + 可达性 mount 用例,可发起
  复验(本 worklog 即复验输入)。
- FYI 备查(不阻塞):i18n `repeatSent` 复数、原 commit 键数勘误,见 review worklog。
