# 2026-07-22 移除顶部 usage-bar,用量合并进 ComposerUsage

## 起因

Task #21322:对话区顶部有一条 `usage-bar`(footer 内、输入框上方的渐变进度条 +
占比文本 + token 明细 tooltip + $cost),与输入区已有的 `ComposerUsage`(草稿预估 +
上下文已用/上限)信息重叠。要求**移除顶部 usage-bar**,把用量信息全部收敛进
`ComposerUsage`,具体三件:**tooltip 明细**(token 输入/输出/缓存/思考/合计)、
**usageLevel 配色**(绿 → 琥珀 → 红,随上下文占比加重)、**$cost**(累计费用)。

## 改法

用量原本散在两处,现统一在 `ComposerUsage` 一处渲染。

1. **`ChatView.tsx`**:删除 footer 里的 `usage-bar` JSX 块(`usage-bar`/
   `usage-track`/`usage-fill`/`usage-text` 及 `usage-${level}` 分级 div),并删除仅
   为它服务的局部计算(`pct`/`usageLevel`/`hasUsage`/`hasBreakdown`/`usageTip`)与
   随之失活的 `formatTokens` 函数(已无任何引用)。footer 现仅剩 QueuePanel + Composer。
2. **`Composer.tsx` `ComposerUsage`**:把上述三件搬进来 ——
   - `level`(low/mid/high/crit)与原 usage-bar 同阈值,`composer-usage-${level}` 配色
     已存在,沿用;
   - tooltip 明细(`usageTip`,有明细时拼输入/输出/缓存读/缓存写/思考/合计,用 `\n`
     多行靠 react-tooltip 的 `white-space: pre-line` 渲染)挂在整段 span 上
     (`data-tooltip-id="md-tip"`),原 cu-draft/cu-ctx 的原生 `title` 一并移除
     (§4.5 禁用原生 title,改 react-tooltip);
   - 新增 `$cost`(`usage.cost.toFixed(4)`),用 `cu-cost` 配 `--green` 略低透明度
     (金钱用绿色、弱化,不与警示色抢眼)。
   - `hasDraft && (hasCtx || hasCost)` 控分隔符,避免草稿单独存在时尾巴多个「·」。
3. **CSS (`index.css`)**:删掉 `.usage-bar`/`.usage-track`/`.usage-fill`/`.usage-text`
   及 `.usage-low/mid/high/crit` 规则;`.composer-usage` 注释更新为含 $cost;新增
   `.composer-usage .cu-cost` 规则。
4. **i18n**:删除随之失活的 `composer.draftTokensTip` / `composer.contextTokensTip`
   (zh+en,各 2 行)—— 现在解释统一走 `usageTip` 的明细,不再需要这两个短 tip。

## 端到端贯通核对(非空壳)

- `ComposerUsage` 由 `Composer.tsx:585` `<ComposerUsage usage={usage} draftTokens={...}/>`
  渲染,`usage` 经 `props.usage` 从 `App.tsx` 的 ACP SessionUsageUpdate / PromptResponse
  流入(§1.6 现实面)。占比/明细/cost 全部读自 `usage`,非空壳。✓
- tooltip 走全局唯一 `md-tip` 实例(`App.tsx:1281` `<Tooltip id="md-tip" .../>`),
  CSS 已 `white-space: pre-line`(§4.5),`\n` 多行可正常换行。✓
- `usageLevel` 配色阈值与原 usage-bar 完全一致(85/60/30),视觉效果收敛不回退。✓

## 规约合规

- §4.5:移除原生 `title`,统一 react-tooltip。✓
- §4.4:仍只展示人话(已用/上限/占比/$cost + 明细中文标签),不抛原始 JSON。✓
- §5.3 KISS / Less is More:删掉一整块重复 UI + 一个失活函数 + 两个失活 i18n key。✓
- §0.3 / §6.2:本 worklog 已写;commit 原子(代码与文档分提交)。✓

## 验证

- `wails3 generate bindings`(bindings 不入库,本机生成)后 `bun run build`(= `tsc && vite build`)
  通过,仅余既有的 chunk size 警告。✓
- `bun test`:60 pass / 0 fail(含 ModelSelect mount 测试等)。✓
- 无 Go 改动,无需 `go build`。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`(删 usage-bar 块 + 失活局部计算/formatTokens)。
- `frontend/src/components/Composer.tsx`(ComposerUsage 合并 tooltip 明细 + usageLevel 配色 + $cost)。
- `frontend/src/index.css`(删 usage-bar 系列规则,加 cu-cost)。
- `frontend/src/i18n/locales/zh.json`、`en.json`(删 draftTokensTip / contextTokensTip)。
- `docs/worklog/2026-07-22-merge-usage-into-composer.md`(本文件)。

## 下一步

无。用量展示已收敛到 ComposerUsage 单一入口;若后续要恢复「渐变进度条」视觉,
可在 `cu-ctx` 内复刻 `.usage-fill` 形态,数据通路不变。
