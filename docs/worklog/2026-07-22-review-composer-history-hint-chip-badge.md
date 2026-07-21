# 2026-07-22 Review #21324 翻历史显眼提示端到端验收结论(PASS)

## 起因

Task #21324(Review):验收「输入框翻历史显眼提示」三件套改动。实现落在
Task #21325 的两个 commit:

- `34c6c55`(feat(composer): placeholder 瘦身 + compose-tools ↑↓ 翻历史 hint chip
  + 导航位置徽标,纯代码)
- `ce6a7cc`(docs(worklog): 同名 worklog,纯文档)

任务目标三连:① **placeholder 瘦身**(去掉内联快捷键塞句);② **compose-tools
hint chip**(把最隐晦、无 UI 入口的 ↑↓ 翻历史提为可视可点入口);③ **翻历史导航徽标**
(显示「第几条 / 共几条」的即时反馈)。

验收重点(Reviewer 职责):**拒收「改了文案 / 加了类型但行为没变」的空壳改动**——
特别核对 chip/badge 是否真渲染、是否真被 `navDisplay` state 驱动刷新、placeholder 是否
真传导到 textarea。

## 改动核对(commit `34c6c55`)

4 文件 / +68 / -4,范围聚焦(Composer.tsx + zh/en.json + index.css),无夹带:

- `Composer.tsx`:新增 `navDisplay` state;`navigateHistory` / `handleChange` / `submit`
  三处镜像;compose-tools 行加 chip / badge 互斥渲染。
- `zh/en.json`:`placeholderNormal` 瘦身;新增 `historyHint` / `historyHintTip` /
  `historyBadge` / `historyBadgeTip` 四 key。
- `index.css`:`.compose-tools` 加 `align-items: center`;新增 `.compose-history-chip` /
  `.compose-history-badge` + `compose-history-badge-in` 入场动画。

## 端到端贯通核对(不只看 diff 表面)

### 1. placeholder 瘦身传导(非空壳)

- `Composer.tsx:519`:`placeholder={prompting ? t("composer.placeholderQueued") :
  t("composer.placeholderNormal")}` —— 改后 `placeholderNormal` 值即输入框 placeholder。
- node 读值确认:zh=`"给 monkey-deck 发消息…"`,en=`"Message monkey-deck…"`(括号塞句
  已去净);`placeholderQueued` 未动(排队语义,不在本次范围)。✓

### 2. chip / badge 真渲染 + 互斥(非空壳)

`Composer.tsx:590-614`:`{history.length > 0 && (navDisplay >= 0 ? <badge> : <chip>)}`:

- **空历史 → 两者都不出**(被 `history.length > 0` 门控),不会误占工具栏。✓
- **未翻历史(navDisplay=-1)→ chip**:可点 button,`onClick` 调 `navigateHistory(-1)`
  + `requestAnimationFrame(focus)`,进入翻历史并聚焦(后续 ↑↓ 键能续翻);`disabled={disabled}`
  与 composer 禁用态联动。✓
- **翻历史中(navDisplay>=0)→ badge**:span,`t("composer.historyBadge", { idx:
  navDisplay+1, total: history.length })` —— 1-indexed(旧→新,最新=N/N),随 `navDisplay`
  即时刷新。✓

### 3. navDisplay state 真驱动刷新(核心:防「ref 变了但不重渲染」)

`navRef` 是事件处理读写权威值,但 ref 变化不触发重渲染;徽标要随翻阅即时更新必须有 state。
核对三处镜像点(全到):

- `submit`(:232-233):`navRef.current = -1; setNavDisplay(-1);` —— 发送后退出翻历史态,
  徽标消失、chip 回归。✓
- `navigateHistory`(:348 恢复草稿分支 / :352 正常流):恢复草稿 `setNavDisplay(-1)`;
  正常翻阅 `setNavDisplay(navRef.current)`(含 `next<0` 钳到 0 的分支)。✓
- `handleChange`(:366-367):`navRef.current = -1; setNavDisplay(-1);` —— 真实输入即退出
  翻历史态。✓

这是真行为变更(state 真驱动渲染),非「加了 state 但从不 set」的空壳。

### 4. i18n key 真被引用(非僵尸 key)

node 读值确认四 key 在 zh/en 均存在且合法;grep 渲染处 chip/badge 均经 `t(...)` 取值
(`composer.historyHint` / `historyHintTip` / `historyBadge` / `historyBadgeTip`),
非硬编码、非裸结构化格式(§4.4)。`{{idx}}` / `{{total}}` 插值与代码传参对齐。✓

## 规约合规

- §4.4:chip/badge 文案全走 i18n 人话(`↑↓ 历史` / `历史 3/10`),无裸露 JSON / 协议字段。✓
- §4.5:chip/badge 均挂 `data-tooltip-id="md-tip"`(react-tooltip),无原生 `title`。✓
- §4.6:纯 CSS 驱动(无 canvas / 重 backdrop-filter / 粒子),动画仅 0.12s transform+opacity,
  跨平台轻量。✓
- §5.3 KISS / Less is More:复用既有 `navigateHistory`,只加一个 state 镜像 + 两段 JSX;
  chip 与 badge 共用一个挂载点互斥渲染,不引入新组件。✓
- §0.3 / §6.2:被验收方 worklog(`2026-07-22-composer-history-hint-chip-badge.md`)自包含、
  已写;commit 原子(代码 `34c6c55` + 文档 `ce6a7cc` 分开),message 说清改了什么 + 为什么,
  代码 diff 仅含直接相关文件,不夹带。✓
- §0.2:未碰 `references/`。✓

## 次要观察(不阻塞)

- **无自动化测试断言 chip/badge 行为**:现有测试集不覆盖 Composer 翻历史 UI;本次为
  纯 UI 新增(state 镜像 + 渲染),以「贯通核对 + build/test 基线 + i18n 合法性」作验收,
  可接受。若日后 Composer 抽出为可测单元,建议补「点击 chip → navigateHistory(-1) →
  badge 出现且 idx 正确;输入/发送后 badge 消失」断言锁回归。
- **既有 slash 按钮仍用原生 `title=`**(`Composer.tsx:584`):违反 §4.5,但属既有代码、
  非本次改动引入,不在本任务范围;可另开任务统一收敛,不影响本次验收。

## 验证

- `make bindings`(`wails3 generate bindings`):291 Packages / 2 Services / 64 Methods
  / 10 Models 生成成功(环境无 bindings,补齐前置)。✓
- `cd frontend && bun run build`:tsc + vite build 通过(无类型 / 编译错误)。✓
- `cd frontend && bun test`:60 pass / 0 fail / 117 expect(streamMerge / ModelSelect /
  MermaidRenderer 等未受影响)。✓
- `node` 读 zh/en.json 四 key + `placeholderNormal`:合法 JSON,值符合预期。✓
- 无 Go 改动,无需 `go build` / `go test`。

## 结论

**PASS**。三项目标全部达成且端到端贯通、非空壳:① placeholder zh/en 真瘦身并传导至
textarea;② compose-tools hint chip 真渲染、可点、调 `navigateHistory(-1)` 进入翻历史;
③ 导航徽标真渲染、由 `navDisplay` state 驱动(navigateHistory/handleChange/submit 三处
镜像全到)随翻阅即时刷新。build 绿、60 测试全过、i18n 合法、规约合规(§4.4/§4.5/§4.6/
§5.3/§6.2)。次要观察(缺 chip/badge 自动化测试 / 既有 slash 按钮原生 title)不阻塞,
可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-composer-history-hint-chip-badge.md`(本文件)。
