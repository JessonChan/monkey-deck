# 2026-07-22 Review #32 移除顶部 usage-bar + 用量合并进 ComposerUsage 端到端验收结论(PASS)

## 起因

Task #21323(Review):验收 Task #21322「移除顶部 usage-bar,用量合并进 ComposerUsage」
的 commit `dc1a72b`(feat) + `d60787b`(docs worklog)。

重点不是「能否编译」,而是「代码是否真的把三件(tooltip 明细 / usageLevel 配色 / $cost)
从顶部 usage-bar 搬进 ComposerUsage 并生效」——拒收「删了 JSX 但漏搬逻辑」/「搬了
签名但函数体没引用」/「tooltip 挂了但 md-tip 实例或 pre-line CSS 缺失」的空壳改动。

## 改动核对(commit `dc1a72b`,5 文件)

**`ChatView.tsx`(真删,非空壳):**
- footer 内 `usage-bar` JSX 整块删除(`usage-bar`/`usage-track`/`usage-fill`/
  `usage-text` + `data-testid="usage-bar"` + `md-tip` 挂载)。✓
- 仅为它服务的局部计算删除:`pct`/`usageLevel`/`hasUsage`/`hasBreakdown`/`usageTip`。✓
- 随之失活的 `formatTokens` 辅助函数删除(grep 全仓 `formatTokens` 已无生产代码引用,
  仅 Composer 内用的是 `fmtTokens`,非同名)。✓ 无悬空死代码。

**`Composer.tsx` `ComposerUsage`(真合并,逻辑搬入且函数体引用):**
- `hasCost` 新增,early-return 改为 `!hasDraft && !hasCtx && !hasCost` —— cost 独立
  可渲染(原 usage-bar 同样 cost>0 即显示)。✓
- `hasBreakdown`/`usageTip` 从 ChatView 逐字搬入,`usageTip` 真的被
  `data-tooltip-content={usageTip}` 消费(非搬了不用)。✓
- wrapper span 挂 `data-tooltip-id="md-tip"` + place=top,移除 cu-draft/cu-ctx 的
  原生 `title`(§4.5 合规)。✓
- 新增 `<span className="cu-cost">${usage.cost.toFixed(4)}</span>`,由 `hasCost` 门控。✓
- 分隔符 `hasDraft && (hasCtx || hasCost)`:四种组合(draft/cost 各 0/1)逐一核对无
  孤立「·」、无漏分隔。✓

**`index.css`:** 删 `.usage-bar/.usage-track/.usage-fill/.usage-text` + `.usage-low/mid/
high/crit`(grep 确认无残留引用,保留的是既有 `.composer-usage-*` 复用配色);加
`.cu-cost { color: var(--green); opacity: 0.85 }`。✓

**i18n(zh+en):** 删失活的 `composer.draftTokensTip`/`contextTokensTip`(grep 全仓无引用);
新 `usageTip` 依赖的 `chat.usageTitle/Input/Output/CachedRead/CachedWrite/Thought/Total`
逐 key 核对存在(zh.json:118-124)。✓ 无拼写漂移。

## 端到端贯通核对(不只看 diff 表面)

确认数据真从 ACP 流到渲染、tooltip 真能多行换行,非空壳:

1. **数据源**:`ComposerUsage` 在 `Composer.tsx:585` 渲染,`usage` 经 `props.usage` ←
   App.tsx 的 ACP `SessionUsageUpdate`/`PromptResponse.Usage`(§1.6 现实面)。✓ 非硬编码。
2. **tooltip 实例**:全局唯一 `<Tooltip id="md-tip" ...>` 在 `App.tsx:1281`,`ComposerUsage`
   挂同一个 `md-tip`,复用既有基础设施。✓
3. **多行换行**:`.react-tooltip { white-space: pre-line }`(`index.css:42`),`usageTip`
   用 `\n` 拼接的明细可正常换行。✓
4. **配色阈值**:`level`(crit≥85/high≥60/mid≥30/low)与原 usage-bar 完全一致,
   `composer-usage-${level}` CSS 已存在,视觉不回退。✓

**结论:三件确实被搬入并接通数据/tooltip/CSS**,非空壳、非纸面绿。

## 验证

- `wails3 generate bindings`(bindings 不入库,本机生成)→ `bun run build`(= `tsc && vite build`):
  通过,仅余既有的 chunk size 警告(与本改动无关)。✓
- `bun test`:**60 pass / 0 fail**(117 expect,7 文件)。✓ 无新增失败。
- 无 Go 改动,无需 `go build`/`go test`。
- grep 全仓:`formatTokens` / `usage-bar`(testid)/ `usage-track` / `usage-fill` /
  `usage-text` / `draftTokensTip` / `contextTokensTip` 在生产代码**零残留**
  (仅 CSS/代码注释提及「原顶部 usage-bar」字样,非运行时)。✓

## 测试覆盖评估(§5.3,非阻塞)

本改动是 **UI 合并/迁移**(把已有渲染从一处搬到另一处),**非 bug 修复、非新逻辑分支**:
- 无新的状态机/分支需要钉死(level/usageTip 的逻辑逐字来自原 usage-bar,行为不变)。
- 对照 PASS 先例(`review-readonly-text-ready`:纯 UI 文本/无新分支豁免测试),本改动同类。
- `bun test` 60 pass 含 `ModelSelect.mount.test` 等 mount 用例,基线绿。

故不强制要求新增测试。若后续要把「draft-only 时不挂误导读 tooltip」做成行为约束,
可补一条 mount 断言,但属可选增强,非阻塞。

## 规约合规

- §4.4:只展示人话(已用/上限/占比/$cost + 中文明细标签),不抛原始 JSON/字段名。✓
- §4.5:移除原生 `title`,统一 `react-tooltip(md-tip)`。✓
- §5.3 KISS / Less is More:删一整块重复 UI + 一个失活函数 + 两个失活 i18n key,净 -30 行。✓
- §6.2:commit 原子(代码 `dc1a72b` 与文档 `d60787b` 分提交),message 说清改了什么 + 为什么,
  diff 不夹带无关文件。✓
- §0.3:被验收方 worklog 已写、自检清单满足。✓

## 非阻塞小观察(供后续参考,不影响本次合入)

当仅有 draft、无 usage/cost/breakdown 时,hover 仍显示 `t("chat.usageTitle")`(「上下文用量」)
tooltip——对纯草稿指示略不准。低影响(hover 才见、内容非空非错),可在后续把 tooltip 门控
加上 `hasCtx || hasBreakdown`,本次不强求。

## 结论

**PASS**。改动真实(真删 usage-bar + 真合并三件进 ComposerUsage 且函数体引用)、端到端贯通
(ACP → props → 渲染 → md-tip/pre-line 多行 tooltip)、build 通过、60 测试全绿、规约合规。
可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-merge-usage-into-composer.md`(本文件)。
