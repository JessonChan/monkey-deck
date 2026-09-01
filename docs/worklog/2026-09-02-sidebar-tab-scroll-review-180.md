# #180 审卡落档:侧栏滚到选中 tab session 行 前端面(APPROVE)

- 日期:2026-09-02
- 任务:Task #28944(review #28943)
- 关联:#180(需求)、Task #28943(实现,commit `9eae644` + worklog `da7fd81`)
- 基线:main HEAD `da7fd81`
- 结论:**APPROVE**(completed-ready;不 push、不关 issue,按任务流程)

## 评审范围与改动面

`9eae644` 仅两个文件:`frontend/src/components/Sidebar.tsx` 三个 hunk(rootRef 声明 /
选中行滚动 effect / `<aside ref={rootRef}>`)+ 新增 `Sidebar.tab-scroll.mount.test.tsx`。
零后端、无新增 i18n key / CSS、App.tsx / TabBar / `TAB_LIMIT` 零触碰。

## 红线逐条核验(diff 级)

- **kbd 光标滚动(694-701)零改动**:diff 中仅作上下文出现。
- **手动 loadMore 按钮零改动**:`Sidebar.tsx:1113` 增量公式未被触碰,effect 只复用同一公式。
- **分页状态结构零改动**:`sessionLimit: Record<string, number>`(168 行)原样;新增的
  `scrollTick` 是独立 state,不进分页结构。
- **零后端 / 零 i18n / 零 CSS** ✓。

## 「类型补丁」反模式扫(逐消费端验证运行时行为)

1. **effect 是否真接进选择流**:tab 点击与 ⌘1-9 均经 `App.tsx openSession` →
   `setSelectedSessionId`(唯一选择入口;无 boot 自动恢复路径,`selectedSessionId` 初始为
   null)→ Sidebar prop 变化触发 effect。TabBar 只渲染 `sessionById(id)` 命中的 tab
   (App.tsx:2457),跨页目标必然在 `sessionsByProject` 全量列表里 → 翻页查找可达。
2. **守卫与 loadMore 按钮逐字对齐**(复验行号:523/841/846/1109):
   `searching = searchProj === pid && searchQ.trim() !== ""`、`activeTags = tagFilter[pid] ?? []`、
   `hiddenCount = max(0, fullList - (sessionLimit[pid] ?? 25))`、增量
   `(prev[pid] ?? 25) + 25` —— 与按钮渲染条件及 onClick 完全一致;过滤态下 `projectList`
   本就绕过切片(524 行),早退正确。另有 `expanded.has(pid)` 折叠守卫(折叠翻页渲染不出
   行,静默 no-op,spec 未要求自动展开,保守合理)。
3. **循环有界**:每 tick 至多翻一页,`hiddenCount` 单调递减;main.tsx 无 StrictMode,无
   双调用翻双页问题。快速连切 tab 场景幂等(新 id 重新走守卫,最多对同行多滚一次)。
4. **DOM 定位**:`session-<id>` testid 在重命名(941)与普通(988)两分支都挂在
   `.session-item-row` 上;右键菜单等其它 `*-<id>` testid 前缀不同,`rootRef` 限定 aside
   子树,无误命中。`scrollIntoView({block:'nearest'})` 与 kbd 先例同参。

## 测试断言质量(锚定值,非字段存在)

三条用例均断言到具体输出:目标行节点身份(`scrollCalls[0].el === row`)、精确参数
`{block:"nearest"}`、恰好一页(s55 仍不可见 + loadMore 仍在)、幽灵 id 零 scroll 调用 +
仍恰 25 行。无「字段存在」式弱断言。

## 复验(基线 `da7fd81`,原始输出)

- `bun test components/Sidebar.tab-scroll.mount.test.tsx` → **3 pass / 0 fail**(15 expect)。
- `bun run test`(= `bun test --isolate`)→ **535 pass / 0 fail**(74 files,7839 expect()
  calls),与实现 worklog 记录一致。
- `bunx tsc --noEmit` → **exit 0**(0 error)。
- 对照组:审卡初跑(生成 bindings 前)出现 11 fail / 49 个 `TS2307`,`bun install` +
  `make bindings` 后全消——纯环境根因(gitignored 生成物),与实现 worklog 的踩坑记录吻合,
  非代码缺陷。⚠ 必须用 `bun run test`(--isolate),裸 `bun test` 会跨文件互踩 globalThis。

## 三端说明(§4.7)

行为为引擎中性 DOM API(`querySelector` + `scrollIntoView`),无 CSS/布局/交互面改动;
移动端抽屉关闭时容器隐藏,scrollIntoView 无害 no-op。三端无新增回归面;本端(桌面 GUI)
已由 mount 测试与全量套件覆盖。

## 结论

实现与验收逐条对应(跨页先翻页后滚、可见行直接滚、无此 id 零翻页),红线零违反,测试
锚定值到位,复验全绿。**APPROVE,停 completed-ready。**

## 改了哪些文件

- 新增:`docs/worklog/2026-09-02-sidebar-tab-scroll-review-180.md`(本文件,单文件单提交)

## 下一步

- 无。等待人工 push / 关 issue 决策。
