# #181 标签 chip ellipsis 返工前端评审(#28957,fe-reviewer)

日期:2026-09-02
评审对象:`4101821 fix(frontend): tag chips render ellipsis via display block — inline-flex ignored text-overflow (#181)`(+ `3b28d63` worklog)
结论:**APPROVE**(前轮 #28953 的 1 项 blocking 已修复;D1-D6 全部达标;2 条 non-blocking nit 记录在案)

## 前轮 blocking 复核(ellipsis 硬切)

修法与根因严格对位:`.session-tag-chip`/`.session-tag-more` 由 `display: inline-flex` 改 `display: block`(text-overflow 按 css-overflow-3 只适用于 block container),`line-height: 12px → 14px` 使 10px 字形在 14px 盒内居中(垂直居中职责移交父级 `.session-item-main` 的 flex align-items:center)。markup 零改动,行高纪律(盒高 14px)不变量保持。

**独立实证(本评审自跑,非复述 coder 探针)**:
- headless Chrome 结构探针(复刻 app 上下文:全局 border-box + `.session-item-main` flex + `.session-label`):block chip 恒 72×14px、截断生效(`scrollWidth` 153/112 > `clientWidth` 72)、文本行盒 `dy=0`(与盒几何中心重合);带 chips 行高 30px == 裸行 30px(行高纪律保持)。inline-flex 旧版对照同样结构性截断——字形有无是 paint 时行为,DOM 探针不可分;由 css-overflow-3 规范保证 + coder 像素探针 + 前轮真机观察硬切三方三角定位,判定「…」在场。
- 门禁断言复核:test 1 提取 CSS 规则体锚定 `display: block` / 无 `inline-flex` / `text-overflow: ellipsis` 在场——把前轮「只断言规则在场」的漏检位钉死,防 display 回退致静默硬切。
- 定向测试(全新 worktree `bun install` 后):`bun test Sidebar.tags.mount.test.tsx locales.test.ts` → **13 pass / 0 fail**;`bunx tsc --noEmit` 49 条全为 TS2307 缺 bindings(本 worktree 未跑 `wails3 gen bindings` 的环境伪影),返工改动零新增类型错误。
- 测试断言质量按「类型补丁」反模式反向追踪:字段到输出逐个锚定——chip `textContent`、`style` 含 `tagColor()` 色值、more chip `+2` 文本、tooltip 完整载荷、5+1 个 chip 计数、`d`/`e` 不渲染——无空壳字段。

## 逐项核对(D1-D6 终判)

| 项 | 结论 | 证据 |
|---|---|---|
| D1 形制复活 | ✓ | 14px/10px/padding 0 6px/999px/72px/flex-shrink:0/#2d2e30/tagColor 同源,逐项与前轮一致;72px 省略本次真实生效(见上) |
| D2 cap 3 +「+N」 | ✓ | markup 未动,前轮已锚定通过 |
| D3 槽位不变 | ✓ | fork 徽章 → chips IIFE → pin,未动 |
| D4 色点完全删除 | ✓ | DOM/CSS 双门禁在场,未动 |
| D5 纯展示 | ✓ | 无 onClick,未动 |
| D6 移动端 chip 内省略兜底 | ✓ | ellipsis 与视口无关(max-width 72px + block 截断),三端同一渲染分支;css-overflow-3 为跨引擎规范级结论(WebKit 同 Chromium) |

三端说明(§4.7):纯 CSS 展示片段,无 `isRemoteClient()` 守卫/事件通道/断点触碰,三张脸同一修复收益;桌面 webkit 像素手感留人实测(coder worklog 已标注,不再重复)。

## Non-blocking nits(不阻塞,留档)

1. **`.session-tag-more` 字形中心偏下 1px**:`line-height: 14px` 命中 1px 边框的 border-box(内容盒 12px),行盒自内容盒顶起排 → `+N` ink 中心 = 盒中心 +1px(canvas 量测 inkH 7px,ink 4.5..11.5 于 0..14 盒内,无渗色,与 coder「字形落在内容盒内」结论一致)。10px 字号下单看不可感;将来若触碰该规则,可单独给 more chip 用 `line-height: 12px` 归零。
2. **i18n key 遗留命名**:`sidebar.tagDotsTip` 名字仍属 #174 点族(zh/en 双语在场、locales 同步测试过);换名 = 三处 churn,仅记录不要求。

## 验证工具备注

本机 `browser` 工具 `tab.screenshot()` 全变体超时(4 次),探针改走 DOM 量化 + canvas ink 度量;截图通道问题已上报工具链。

## 下一步

- 停 completed-ready;不 push、不关 issue,orchestrator 处置。
