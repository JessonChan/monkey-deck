# 2026-08-10 Re-review #115 McpChip 迁 compose-tools 前端 (APPROVE, Task #24261)

**起因**:Task #24261 对 #115(2 commit:`c35e78a` 功能 + `4bf41cf` worklog)做独立的
Frontend Reviewer 复审。前序已有 #24260(`c25cc8d`)复审并 APPROVE,本条为再次独立验证,
不依赖前序结论、自跑一遍验收门。改动纯前端,无后端变更。

## 复审范围(同 #24260,独立复核)

- `components/McpChip.tsx`:class `chat-model` → `compose-mcp`;Plug size 12→11;
  加 `data-tooltip-place="top"`;inline `style` 并入 CSS class;注释中→英(§3.7)。
- `components/ChatView.tsx`:删 `import McpChip` 与头部 `<McpChip>` 渲染。
- `components/Composer.tsx`:import McpChip;`compose-tools` 末尾(branch chip 之后)渲染。
- `index.css`:新增 `.compose-mcp`。
- `Composer.mount.test.tsx` / `Composer.usage.mount.test.tsx`:`chatServiceMock` 补
  `GetSessionMcpServers` stub。

## 正确性(独立确认)✅

### Props 流 ✅
`Composer.tsx:21` props 已有 `sessionId: string`,直接喂 McpChip,**无新增 prop drilling**
—— 迁位核心收益达成。全仓 grep `McpChip` 确认:仅 Composer.tsx import + 渲染、McpChip 自身、
两个测试的注释提及;ChatView 侧无悬空引用。✅

### McpChip 防御与生命周期 ✅
- `useEffect([sessionId])` 内 `if (!sessionId) return` 守卫(McpChip.tsx:20)—— Composer 测试
  STUB_PROPS 用 `sessionId: ""`,McpChip 返 null、不调 binding。
- `servers.length === 0` → 不渲染(:27),语义不变。
- `alive` flag + cleanup `() => { alive = false }`(:19,24)防 unmount 后 setState,完整保留。✅

### `.compose-mcp` 视觉同族 ✅
与 `.compose-branch`(index.css:1296)/ `.compose-history-chip`(:1273)逐项对齐:
`var(--mono)` / 10.5px / `var(--text-3)` / `var(--elev-2)` / `1px solid var(--sep)` /
`2px 7px` / `5px` / `height 20px` / `margin-left 4px` 全一致。差异仅「无 cursor/hover」——
符合「状态指示不是操作」语义。Plug 11px 与 branch 的 `GitBranch size={11}` 对齐。✅

### inline style → CSS class 无丢失 ✅
原 `style={{ display: "inline-flex", alignItems: "center", gap: 3 }}` 三项全部落入
`.compose-mcp`(index.css:1313-1313)。无样式回归,样式收敛进 class(§4.6)。✅

### tooltip-place 一致 ✅
`data-tooltip-place="top"`(McpChip.tsx:35)与 `compose-branch` / `compose-history-chip`
邻居一致;react-tooltip 单例 `md-tip` 复用(§4.5)。✅

### TypeScript / Wails binding ✅
McpChip props `{ sessionId: string }` 不变;Composer 传 `sessionId`(已是 string)——类型对齐。
无新增字段,**无类型补丁反模式**(§5.3)。✅

### i18n 同步 ✅
`chat.mcpChipTip` 双语存在:`i18n/locales/en.json:175` / `i18n/locales/zh.json:175`。
`{{names}}` 插值消费端在 McpChip(`names = servers.map(s => s.name).join(", ")`),全链路有消费。✅

### 测试 mock 补全 ✅
两个 Composer mount 测试的 `chatServiceMock` 都补了 `GetSessionMcpServers` stub,
McpChip 随 Composer 挂载调 binding 不炸。**无其它测试 import McpChip**(grep 确认)。✅

### data-testid 可访问性 ✅
`data-testid="chat-mcp-chip"` 保留(无测试消费,见 nit #1);tooltip 满足可解释性(§4.2/§4.5)。✅

## 观察项(非阻塞 nit,不改,同 #24260)

### #1 data-testid 前缀仍为 `chat-`
物理位置已迁 Composer,但 testid 仍是 `chat-mcp-chip`,同族邻居用 `composer-*` 前缀。
**无测试当前依赖**(全仓 grep 无消费),日后加 Composer 集成测试时可顺手改 `composer-mcp-chip`。不阻塞。

### #2 i18n key 仍在 `chat.` 命名空间
`chat.mcpChipTip` 语义上已属 Composer,理论可迁 `composer.mcpChipTip`。key 数量少(1×双语)、
迁移收益低。记为可选,不阻塞。

## 验证(acceptance gate,本次自跑)

1. `cd frontend && bun install` → 364 packages。
2. **`cd frontend && bun test --isolate Composer`**:**39/39 pass**(138 expect calls)。✅
3. **`cd frontend && bun test --isolate`(全量)**:209 pass / 2 fail / 2 errors。2 fail 全在
   `NewSessionModal.mount.test.tsx`(binding 缺失 `Cannot find module '.../chatservice'`,
   worktree 未 `wails3 gen bindings`,环境问题,与本次改动无关)。**无新增失败 = 无回归**。✅
4. `cd frontend && bunx tsc --noEmit`:所有 `error TS` 均为既有 `Cannot find module '../bindings/...'`
   (worktree 缺 bindings 产物,涉及 App/ChatView/Composer/McpChip 等全仓 import 行);
   **McpChip.tsx 仅 2 行报错均为 binding 模块缺失(:3/:4),无本次改动相关类型错**。✅

## Verdict:APPROVE

独立复审确认 #24260 结论:迁位最小干净 —— Composer 已有 `sessionId` 无需新增透传、
`.compose-mcp` 与同族 chip 视觉逐项对齐(只读无 hover 符合语义)、inline style 全部并入 class
无丢失、tooltip-place 与邻居一致、两 mount 测试补 mock 防 binding 炸组件、39 Composer 测试全过、
i18n zh/en 同步、无类型补丁反模式、无回归。两项 nit(testid 前缀 / i18n 命名空间)非阻塞。
建议合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-rereview-mcpchip-composer-tools-frontend.md`(本条,新增)。
