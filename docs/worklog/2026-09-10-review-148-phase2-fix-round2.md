# 2026-09-10 #29246 review:#29245 修复轮三缺陷闭环复核(#148 二期 round 2,APPROVE)

## 起因

审 #29245 修复(main 三笔):`6dcc15e`(缺陷1:QueuePanel onDragOver 外部拖拽守卫
恢复 + 回归测试)、`c0a312f`(缺陷2:Esc listener cleanup + 泄漏测试;缺陷3:
cfgChipTip 死键消费 + 消费测试)、`cef7f00`(fix worklog)。对照 round 1 审查
(`1f3cf79`,`docs/worklog/2026-09-10-review-148-phase2-pwa-sheet-queuepanel.md`)
逐缺陷闭环判定;反相核实不信 summary,以 `git show` 实际内容 + 本机复跑为准。

## 核查清单结果

| # | 核查项 | 结果 | 证据 |
|---|---|---|---|
| ① | 缺陷1 闭环 | ✅ | 守卫在场:`QueuePanel.tsx:400` `if (!dragId) return;`,与 `32a4d57` 删除前原文逐字节一致(net diff vs `32a4d57^` 在 drag handler 区仅 +2 行英文注释);回归测试真实钉死行为:无 dragstart 的 dragover → `preventDefault` spy 断言 `prevented===false` + 两行均无 `drag-over` 类 + `onReorder` 被调即 throw,**非 tautology——本机摘除守卫后该测试实测 fail**(2 pass/1 fail),还原后恢复绿;既有 reorder 路径 57/57 全绿 |
| ② | 缺陷2 闭环 | ✅ | cleanup 在场:`Composer.tsx:1433` `return () => document.removeEventListener("keydown", onKey);`;泄漏测试以 spy 对计 keydown **净注册数**,断言链 关闭=0 → 开启=1 → Esc 关闭=0 → 重开=1 → 开启态 unmount=0(close 与 unmount 两条泄漏路径都钉死);**摘除 cleanup 后实测 fail**(9 pass/1 fail),还原后恢复绿 |
| ③ | 缺陷3 闭环 | ✅ | 消费在场:`Composer.tsx:1475` `data-tooltip-content={t("composer.cfgChipTip")}`,`data-tooltip-id="md-tip"` 锚点保留;全仓 grep `cfgChipTip` = zh.json:401 + en.json:401 两处定义 + Composer.tsx:1475 唯一消费 + 测试,**死键残留归零**;消费测试断言属性值 === `"composer.cfgChipTip"`(i18n mock 返 key 原文,精确锚定、≠ 旧拼接键)+ 真实 zh/en locale JSON 双语非空;**改回旧拼接后实测 fail**,还原后恢复绿 |
| ④ | 本机实跑 | ✅ | `bun test src/components/Composer.cfgsheet.mount.test.tsx` → **10 pass/0 fail**(8 既有 + 2 新增);`bun test src/components/QueuePanel` → 11 文件 **57 pass/0 fail**(56 + 1 新增守卫回归);`bunx tsc --noEmit` → **0 错**;`bun run build` → 通过(chunk >500kB 警告为既有状况) |
| ⑤ | diff 越界检查 | ✅ | 三笔合计仅 5 文件:QueuePanel.tsx(+3)/ QueuePanel.reorder.mount.test.tsx(+40)/ Composer.tsx(+3/-1)/ Composer.cfgsheet.mount.test.tsx(+69)/ worklog(cef7f00);**零 CSS 改动** → index.css ≤768px 块与桌面样式不受影响;守卫恢复=桌面行为还原(触屏无 HTML5 DnD,移动端零影响);chip tooltip 只作用于 `mdMobile` 才挂载的 cfg-chip,桌面 DOM 零变化 |
| ⑥ | worklog 属实性 | ✅ | `2026-09-10-148-phase2-fix-round1.md` 全部可验声明属实:57/57、10/10、tsc 0、build 过、三测试反证数字(10 pass/3 fail→13 pass)与本机复现一致 |

## 结论

**APPROVE**。三缺陷全部闭环,且各带经反证实证的防回归测试(本审查独立复现了
「摘除修复→新测试 fail」三条路径,非沿用实现方自证)。修复语义取向(cfgChipTip
选消费而非删键,文案「点按切换模型/模式/思考」贴 sheet 入口)符合 round 1 建议
的首选项。真机触屏手感(软键盘下 70dvh sheet、滚轮 select)沿 M2「仿真过、真机
留人」惯例,不阻塞。

停 **completed-ready**:不 push、不关 issue。
