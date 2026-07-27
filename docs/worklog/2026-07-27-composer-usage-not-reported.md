# 2026-07-27 Composer 用量面板未上报(全 0)显示「—(未上报)」灰色

## 起因

Task #23428。`ComposerUsage`(`Composer.tsx`)此前的早退条件:

```ts
if (!hasDraft && !hasCtx && !hasCost) return null;
```

导致**当 harness 还没上报任何用量(used/size/cost/明细全 0)时,整个用量入口消失**
(`data-testid="composer-usage"` 不渲染)。用户看不到「用量入口在,只是 harness 没报」,
误以为应用没这功能 / 出 bug 了。新会话首轮(prompting 中、PromptResponse.Usage 还没回来)
尤其常见。

issue 明确要求:harness 用量全 0 时显示灰色「—(未上报)」,并强调**判定不依赖
CapabilityMatrix**(`emitsUsage` 位)——只用实际数据。

## 改法(§5.3 尊重数据源)

**判定准则**:harness 是否上报 = 实际数据里 `used/size/cost/明细 token` 任一非 0。
**不查 `CapabilityMatrix.emitsUsage`**(那是能力声明,不是真相;声明会报但实际全 0 仍
应显示「未上报」,反之亦然 —— 协议字段 / 实际行为才是真相来源,§5.3「外部事实是设计
前提时先验证」)。

- `hasUsageReported = hasCtx || hasCost || hasBreakdown`(任一非 0 = 已上报)。
- 删 `return null` 早退;`composer-usage` 始终渲染(只要有 session,入口常驻)。
- `hasUsageReported` 为假 → 渲染灰色 `<span class="cu-none">—(未上报)</span>`。
- 草稿预估(`.cu-draft`)是本地估算,**不计入「是否上报」判定**:用户在打字但 harness
  还没报时,显示 `~draft · —(未上报)`(两信息并存,不互相遮蔽)。
- 有数据(`hasUsageReported` 真)走原渲染路径(ctx / cost),**零回归**。
- tooltip 三态:未上报 → `chat.usageNotReportedTip`(人话解释);已上报无明细 →
  `chat.usageTitle`(既有);有明细 → 多行明细(既有)。

## 改了哪些文件

- `frontend/src/components/Composer.tsx`(`ComposerUsage`):
  - 删 `return null` 早退;新增 `hasUsageReported`,据此分支渲染 `.cu-none` / 原内容。
  - tooltip 三态化(未上报 / 已上报无明细 / 明细)。
  - 头部注释补「未上报」态判定准则 + 为何不依赖 CapabilityMatrix(§5.3)。
- `frontend/src/index.css`:新增 `.composer-usage .cu-none { color: var(--text-3); opacity: 0.6; }`
  (在默认 `--text-3` 基础上再降透明度,与有数据时的 text-2/text-3 拉开层级)。
- `frontend/src/i18n/locales/{zh,en}.json`:`chat` 块新增 `usageNotReported` /
  `usageNotReportedTip`(zh:`—(未上报)` / `harness 尚未上报用量`;en 对应)。
- `frontend/src/components/Composer.usage.mount.test.tsx`(新增):4 用例回归测试。
- `docs/worklog/2026-07-27-composer-usage-not-reported.md`:本条。

## 回归测试

`Composer.usage.mount.test.tsx` 4 用例(覆盖判定矩阵 + 不依赖 capability):

1. **全 0(无草稿)**:`composer-usage` 存在 + `.cu-none` 文本 = `chat.usageNotReported` +
   tooltip = `chat.usageNotReportedTip` + 无 `.cu-ctx`/`.cu-cost`。
2. **有草稿 + 用量全 0**:`.cu-draft` 与 `.cu-none` 并存(`~draft · —(未上报)`)。
3. **有 context(used/size)**:渲染 `used / size · pct%`,**无** `.cu-none`(不回归),
   tooltip = `chat.usageTitle`(无明细回退)。
4. **仅有 cost**:渲染 `$cost`,**无** `.cu-none`(不回归)。

测试不注入任何 `CapabilityMatrix`,从根上钉死「判定只看数据、不查能力声明」。

## 验证

- `bun install` + `wails3 generate bindings`(worktree 无 node_modules / bindings)。
- `bun test src/components/Composer.usage.mount.test.tsx`:**4/4 通过**。
- `bun test src/components/Composer.mount.test.tsx`:**5/5 通过**(既有 paste / enqueue /
  mention 用例不回归)。
- `npm run build`(`tsc && vite build --mode production`):**通过**(仅既有 chunk size 警告)。
- 全量 `bun test --isolate`:**138 pass / 0 fail**。
- `go build ./...` / `go vet ./...`:clean(仅 pre-existing macOS 链接器版本警告,无 Go 改动)。

## 下一步

- 实机抽验(`wails3 dev`,macOS WebKit):新会话首轮用量区显示灰色「—(未上报)」;
  首条 Prompt 返回(有 usage)后切到正常 `used / size · pct%`,无「未上报」残留。
- tooltip 文案可按实机反馈微调(当前「harness 尚未上报用量」偏技术,若用户不熟
  harness 一词可改「尚未收到用量数据」)。
