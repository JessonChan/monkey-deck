# 2026-09-10 #29244 review:#148 二期 PWA 配置 sheet(A)+ QueuePanel 移动视觉(B)(NEEDS_CHANGES)

## 起因

审 #29243 产出(main 三笔):`62144b4`(A:Composer.cfgsheet.mount.test.tsx 新增 305 行 +
Composer.tsx +158 + index.css +62 + zh/en i18n 各 +2)、`32a4d57`(B:QueuePanel.tsx
+8/-1 + index.css +34)、`8917de5`(worklog)。反相核实不信 summary,以 `git show`
实际内容 + 本机复跑为准。

## 核查清单结果

| # | 核查项 | 结果 | 证据 |
|---|---|---|---|
| ① | 硬约束 ≤768px:门控 + CSS 归属 | ✅(A 有附带缺陷②③见下) | chip 仅 `mdMobile &&` 挂载(Composer.tsx:1239),`false &&` 渲染 null → >768px DOM 逐字节不变成立;全仓唯一 `@media (max-width: 768px)` 在 index.css:3253、闭合 :3730,A 新 CSS(3484-3562)与 B 新 CSS(3600-3627)全在块内;`data-scheduled`/`data-repeat` 全仓 CSS 读取仅 :3613/:3614,均在块内 → 桌面 CSS 不读属实 |
| ② | A:sheet 主体 | ✅ | chip 短名 `split("/").pop()`;model 组 cmdk + provider 分组(value 按 `/` 前缀聚合,localeCompare);mode/thought 原生 select;数据通道全覆盖 `onSetConfig(<ConfigOption.id>, value)`,测试以 `model_id_custom`/`build_mode`/`thinking_budget` 假 id 钉死防硬编码回归;`.compose-right .cfg-trigger{display:none}` 保留、chip 为替换入口,ModelSelect 桌面路径 diff 零触碰;`onRefreshConfig` 契约与 ModelSelect(:1553)同构;Esc/scrim/✕ 三路关;z-index 65 > 抽屉 60;`common.close` 双语在案 |
| ③ | B:三态轨道/琥珀收敛/clamp | ✅ | 灰(--sep-strong)/accent-2/紫三轨,data-repeat 规则后置 → 双态紫胜;badge 同色系(future→cyan :3626、repeat→violet :3627;due/past 基础色本为 text-3 灰非琥珀,:1760);3 行 `-webkit-line-clamp` + `min-width:140px`,与既有 `.queue-item{flex-wrap:wrap}` 配合 badge 让行;琥珀收敛声明与代码一致(resting 态仅面板标题 + header 时钟余琥珀);与 #193 零耦合(纯读态属性) |
| ④ | 测试反相 + 本机实跑 | ✅ | cfgsheet 8/8(锚定断言:`toContainEqual(["model_id_custom","ant/claude"])`、chip 含 `glm-5.1` 且不含 `zai/`、`refreshes===1`、关门 null 断言,无 tautology);QueuePanel 11 套件 56/56;全量 602:598 pass/4 fail,4 条均为 `App worktree live-guest guard` 基线在案(chatservice-mock 静态 import 环境问题,2026-09-08 worklog 记录),本机 stash 外复跑结论一致,非本次引入 |
| ⑤ | tsc + build | ✅ | `bunx tsc --noEmit` 0 错;`bun run build` 通过(chunk >500kB 警告为既有状况) |
| ⑥ | worklog 属实性 | ⚠️ | 大体属实(验证数据 8/8、56/56、598/4 全部复现),但「**不动任何回调/数据流**」与实码矛盾——见缺陷 1 |

## 缺陷(3 处,均小改,修完可过)

### 1. QueuePanel `onDragOver` 的 `if (!dragId) return;` 守卫被静默删除(必须修)

`32a4d57` 唯一的 -1 行就是这条守卫(QueuePanel.tsx:397-400 现状无守卫)。commit message
零提及、worklog 明文声称「不动任何回调/数据流」——直接矛盾;且与移动视觉零关系(触屏
无 HTML5 DnD),属夹带的桌面行为变更:

- 外部拖拽(Finder 文件、文本选区)悬停队列行时:行亮 `drag-over` 高亮(假投放目标)+
  preventDefault 放行 drop 光标;行内 drop 被 onDrop preventDefault 吞掉,queue 语义零操作。
  守卫在场时:无高亮、光标拒绝,外部拖拽对队列列表无感(原行为)。
- panel-file MIME 冒泡到 ChatView 根的 mention-drop 不受影响(onDrop 不 stopPropagation),
  OS 文件走 Wails 原生通道也不受影响——是 UX 假信号,不是功能破坏,但「桌面零修改」的
  卡片级承诺被这一行打破。
- 56/56 全绿恰因所有 reorder 测试都先 dragstart(dragstart 先于任何 dragover);被删守卫
  的行为(无 dragstart 的 dragover)无任何测试兜底。

修法:恢复 `if (!dragId) return;`(一行,内部 reorder 不受影响——dragstart 同步 flush 在先)。

### 2. MobileConfigSelect Esc listener 无 cleanup(必须修)

Composer.tsx:1427-1433 的 effect 只 `document.addEventListener("keydown", onKey)`,无
`return () => removeEventListener`。每次 open→close 循环泄漏一个 document 级 listener:
N 次开关 N 个僵尸,每次 Escape 全部空转 `setOpen(false)`(React 同值 bail-out,无可见
错乱,但泄漏单调累积,且与 Composer 既有 Escape 处理链 :683/:686/:712 并存成噪声)。
hooks usage 纪律问题。修法:effect 返回 cleanup(一行)。

### 3. `cfgChipTip` 双语死键(必须修,类型补丁反模式命中)

`composer.cfgChipTip` zh+en 各 +1,但全 src grep 仅 locale 文件命中、零 TSX 消费;chip
的 tooltip 实际拼的是 `` `${t("composer.cfgLabel.model")}: ${shortName}` ``(:1453 附近)。
commit message 与 worklog 都把它列为交付物。tsc 绿 ≠ 行为通电——正是「字段加了没人
消费」。修法二选一:chip 改 `data-tooltip-content={t("composer.cfgChipTip")}`(语义
「点按切换模型/模式/思考」更贴 sheet 入口),或双语删键。

## 备注(不阻塞)

- sheet 无初始 focus 移交/focus trap:原生 select + cmdk 触屏场景可接受,§4.2 要求的
  Esc + data-testid 已满足。
- `useMobileViewport`(Composer)与 App `mdViewport`(App.tsx:2426)同惯例双实现,MOBILE_BP
  各自定义;共享需动 App 导出面,超本次范围,现状可接受。
- 环境复现:本 worktree 跑测试前需 `bun install` + `wails3 task bindings`(bindings 为
  gitignore 生成物),与被审 worklog 环境备注一致。

## 验证(本机实测,非沿用实现方结论)

- `bun test src/components/Composer.cfgsheet.mount.test.tsx` → 8 pass / 0 fail。
- `bun test src/components/QueuePanel` → 11 文件 56 pass / 0 fail。
- 全量 `bun test --isolate` → 602 tests:598 pass / 4 fail(4 条 worktree-guard 基线)。
- `bunx tsc --noEmit` → 0 错;`bun run build` → 通过。

## 结论与下一步

**NEEDS_CHANGES**。三处缺陷全部为 1-2 行小改,修复后复跑 cfgsheet 8 条 + QueuePanel
reorder 2 条 + tsc 即可,无需重新全量回归。真机触屏手感(软键盘下 `70dvh` sheet、滚轮
select)留人实测,不阻塞终审(沿 M2「仿真过、真机留人」惯例)。不 push 不关 issue,
停 completed-ready。
