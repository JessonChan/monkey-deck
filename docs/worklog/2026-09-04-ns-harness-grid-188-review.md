# 2026-09-04 #188 宫格 harness 选择 · fe-review(MON-673)

## 起因

评审 ce92dac(实现)+ 9019559(worklog),基线前推 fe5b85d。改动面 = NewSessionModal.tsx
+ index.css + i18n zh/en + mount 测试(5 文件 19+/139-,净删:radio 纵列 → 宫格卡片)。
反相追踪核实(从字段定义点逐消费端确认),不信 commit 叙事。

## 结论:**APPROVE**

逐项核对(清单 ①–⑨ 全过):

1. **grid 布局** ✓ `.ns-harness-list`(index.css:2888)= `repeat(auto-fill, minmax(110px,1fr))`
   + gap 8px;旧 flex-column 声明删净。`.ns-radio` 本体保留(2902),仍有活消费端
   (worktree 二选一 TSX:342 + `.ns-worktree.active .ns-radio` 2939);harness 专属
   `.ns-harness.active .ns-radio` 已删,`.ns-harness-cmd` 全仓无残留引用(仅测试负断言)。
2. **卡片形态** ✓ `HarnessIcon size={36}`(32–40 区间,组件 Props 本就收 `size?: number`,
   本体未动);名字单行 ellipsis(`max-width:100%+hidden+ellipsis+nowrap`);选中 =
   `.ns-harness.active` accent 边框(2901,存量规则)+ `ns-harness-check` 右上角标
   (lucide Check 12px);radio 圆点从卡片 JSX 删除。
3. **tooltip 合并** ✓ `data-tooltip-content` = `name\ncommand`(未装再 `\n` notInstalled),
   配合存量 `.react-tooltip` pre-line;command 芯片下卡面。测试锚定精确串
   `"goose\ngoose acp\nnewSession.notInstalled"` / `"omp\nomp acp"`。worklog 对
   react-tooltip v6 无 `data-tooltip-html` 的论证与 package.json(v6.0.8)相符。
4. **排序两键稳定** ✓ `rank=(installed?0:2)+(id===DEFAULT_HARNESS_ID?0:1)`——installed
   严格优先;omp 在所在组首位;`Array.sort` 稳定保后端序。测试以乱序输入锚定 DOM 序
   `["omp","opencode","goose","claude"]`。未装:opacity .55 灰显 + 左上角标,onClick
   无条件(仍可选)。边界:未装 omp(rank 2)落在已装他者(1)之后、未装他者(3)之前,
   合理。
5. **高度控制** ✓ `max-height:256px + overflow-y:auto`;worklog 记录了选型理由(内滚
   vs 已装优先 toggle:零组件状态、灰显项始终可达,256px≈3 行,与 ns-baseref-list 内滚
   惯例一致)。
6. **PWA ≤768** ✓ 零新增媒体查询;全文件唯一 `@media(max-width:768px)`(3233)不触及
   ns-harness/ns-radio;auto-fill 窄屏自然降列(390px≈2 列,桌面 4+)。真机目测按
   worklog 留人,非代码缺陷。
7. **i18n zh/en 同步** ✓ `newSession.notInstalled`:「未安装」/「Not installed」,两侧
   同位置。
8. **测试锚定 + 门** ✓ 三新测断言锚定值(数组精确相等/classList 布尔/tooltip 精确串/
   onConfirm 精确 payload),非字段存在性。`bunx tsc --noEmit` 0 错;`bun test --isolate`
   564 pass / 0 fail(78 文件),与 worklog 记录一致;本文件 8/8(含存量 5 测零回归)。
   复现说明:worktree 缺 gitignored 的 bindings 与 node_modules,需先
   `wails3 task bindings` + `bun install` 再跑门。
9. **红线** ✓ diff 仅 frontend/ 5 文件 + 本 worklog;后端与 #187 发现链零波及;
   HarnessIcon.tsx 不在 diff 中,仅调用传 `size`。

反相追踪(类型补丁排查):`sortedHarnesses` 被 map 消费(TSX:297)、`DEFAULT_HARNESS_ID`
进 rank、`Check` 进角标、`ns-harness-grid`/`ns-harness-check`/`ns-harness-uninstalled-*`
三个 testid 全部被测试选择器消费;`lastHarness` 预选 effect 作用于数据而非显示序,重排
不影响。无「字段加了没人读」。

非阻塞备注:①`ns-harness-check` testid 未按 harness id 限定——单选语义下任意时刻
唯一,可接受;②测试 fixture 注释「lastHarness='' + >1 harness → 无预选」措辞略松
(实际 fixture 单 harness 走「单 harness 自动选」分支),对断言无影响。

## 验证

- `bunx tsc --noEmit` → 0 错。
- `bun test src/components/NewSessionModal.mount.test.tsx` → 8 pass / 0 fail。
- `bun test --isolate` → 564 pass / 0 fail。
- 静态核查:index.css 残留类/媒体查询、bindings `Harness.installed` 字段、
  HarnessIcon Props、i18n 双语、全仓 `ns-harness-cmd` 零残留。

## 下一步

- 实现侧保持:等 orchestrator 消费本评审结论;桌面 GUI / PWA 真机目测仍是实现
  worklog 既有的人工项。
