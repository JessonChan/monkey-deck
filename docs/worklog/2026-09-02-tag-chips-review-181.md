# #181 标签命名 chip 前端评审(#28953,fe-reviewer)

日期:2026-09-02
评审对象:`eadffd2 feat(frontend): session row tag chips — named hash-colored chips with +N overflow (#181)`(+ `051397a` worklog)
结论:**REJECT**(1 项验收不达标,修法 2 行 CSS;其余全部通过)

## 逐项核对(D1-D6)

| 项 | 结论 | 证据 |
|---|---|---|
| D1 形制复活 | **部分不达标** | 14px 高/10px 字/padding 0 6px/999px 圆角/max-width 72px/flex-shrink:0/#2d2e30 深墨字/background=tagColor 8 色同源——全部与 #150 原版(`a060aba`)逐字一致 ✓;**但「72px 省略」实际不生效**,见下 |
| D2 cap 3 +「+N」 | ✓ | `Sidebar.tsx:1046-1075`:`slice(0,3)` + `+N`(N=总数−3),more chip tooltip 复用 `sidebar.tagDotsTip` 带全量列表;测试锚定 `+2` 文本与 tooltip 完整载荷 `{"tags":"a, b, c, d, e"}` |
| D3 槽位不变 | ✓ | fork 徽章(1026-1035)→ chips IIFE(1046-1075)→ pin(1076),原色点槽位;Pencil/pin/闹钟/popout/harness icon 零波及 |
| D4 色点完全删除 | ✓ | `.session-tag-dots`/`.session-tag-dot` 规则已删;DOM `tag-dots-*` testid 计数 0;全仓 grep 无残留(`ctx-tag-dot` 属 ctx 菜单另一表面,非 #174 行内点族,保留正确) |
| D5 纯展示 | ✓ | chips 是 `<span>`,无 onClick/无过滤联动;过滤仍是独立 `button.session-tag-filter` |
| D6 移动端 chip 内省略兜底 | **不达标** | 同 D1 省略问题——长标签名被硬切,无「…」截断信号;tooltip 在触屏上需点按,兜底正是 spec 点名的 chip 内省略 |

## Blocking 发现:ellipsis 在 inline-flex 上不渲染(硬切无「…」)

**根因**:`.session-tag-chip` 同时声明 `display: inline-flex` 与 `text-overflow: ellipsis`(index.css:344-352)。`text-overflow` 按 css-overflow-3 只适用于 block container;inline-flex 让 chip 自己成为 flex container,内部文本是 anonymous flex item,省略号被忽略——只剩 overflow:hidden 硬切。这是 #150 原版 CSS 自带的潜伏缺陷,本次原样复活随之带回。**旁证(仓内自证)**:同文件 `.session-label`(index.css:287)是 span/flex item(blockify 成 block container),ellipsis 正常工作——label 能省略、chip 不能,差的就是 inline-flex。

**实证(headless Chrome 渲染探针,像素级)**:复刻 chip CSS,A=inline-flex 现行版、B=inline-flex 中文长标签、C=inline-block 对照(其余声明逐字相同):
- A `a-very-long-tag-n`(硬切,**无「…」**)、B `这是一个特别特`(硬切,无「…」)
- C `a-very-lon…`(**「…」正常渲染**)
- 探针里 A/B 宽 84px 是探针页缺全局 `* { box-sizing: border-box }` 的探针伪影;真实 app 下 chip 恒为 72px(border-box 已验证)。缺陷只在省略号字形。
- 探针引擎为 Chromium;该行为是规范级(css-overflow-3 适用范围),WebKit 同样忽略 flex container 上的 text-overflow,桌面 GUI 引擎不受影响结论不变。

**建议修法(2 行,零 markup/测试改动)**:`.session-tag-chip` 去 `display: inline-flex; align-items: center`,改 `display: block; line-height: 14px`(父容器 `.session-item-main` 本就是 flex + align-items:center,chip 作为 flex item 照常居中,行高 14px 在 14px border-box 内居中字形,12px 纪律的实质不变量=盒高 14px 不破)。`.session-tag-more` 内容恒为「+N」无截断风险,可不动;建议顺手同改保持家族一致。改后可用同探针复验「…」字形,并重跑门禁。

**测试缺口**:CSS 门禁只断言规则在场/离场(`Sidebar.tags.mount.test.tsx:243-246`),没钉 display——正是本次「tsc 绿≠行为通电」的漏检位。建议门禁补一条锚定断言(chip 规则含 `display: block`/不含 `inline-flex`),防回归。

## Nits(不阻塞)

1. **i18n 键名过时**:more chip tooltip 复用 `sidebar.tagDotsTip`(en "Tags: {{tags}}" / zh 「标签:{{tags}}」),双语同步、内容对 chip 语境仍准确;唯键名 "Dots" 是 #174 遗留。改动面已限定(Sidebar.tsx+index.css+测试),本期不改;后续若动 i18n 可顺手改名 `tagMoreTip`。
2. **新标签输入无去重(既有,非本 diff 引入)**:ctx「标签 ›」输入框 Enter 直接 `[...cur, val]` 追加(Sidebar.tsx:1330-1334),敲入已存在标签名会产生重复项→chips `key={tag}`/testid 冲突。点族时代同构风险已存在,记为后续独立小修。

## 验证(评审独立复跑,非转抄 coder)

- 定向:`bun test src/components/Sidebar.tags.mount.test.tsx` → **9 pass / 0 fail**(80 expect)。
- 全量:`bun test --isolate` → **542 pass / 0 fail**(76 文件,7898 expect);`bunx tsc` → 0 错误。
- 环境注:本 worktree 原缺 `frontend/node_modules/` 与 gitignored `frontend/bindings/`,`bun install` + `make bindings`(钉版 v3.0.0-alpha2.106)后套件可跑;产物不入库。
- i18n:zh/en `tagDotsTip` 双语在场同步(逐文件核对)。
- 无障碍/工具提示:全族 react-tooltip(`data-tooltip-id="md-tip"`),无原生 title(§4.5 合规);testid 形态 `tagchip-<sid>-<tag>` / `tagchip-more-<sid>` 齐全。

## 三端说明(§4.7)

评审对象是共享 session 行的纯展示片段,无 `isRemoteClient()` 守卫/事件通道/响应式断点触碰,三张脸同一渲染分支;本次以 mount 测试 + 真实渲染探针(Chromium)验证渲染行为,省略号机制为规范级跨引擎结论(见上)。桌面 GUI/远程浏览器/PWA 无定向改动。

## 下一步

- 打回 coder:按建议修法改 `.session-tag-chip`(可选同改 `.session-tag-more`)+ CSS 门禁补 display 锚定断言,重跑定向测试后重新提审。
- 不 push、不关 issue;由 orchestrator 处置。
