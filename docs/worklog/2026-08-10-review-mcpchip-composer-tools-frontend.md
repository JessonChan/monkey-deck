# 2026-08-10 Review #115 McpChip 迁到 compose-tools 前端 (APPROVE, Task #24260)

**起因**:Task #24260 对 #115(2 commit:`c35e78a` 功能 + `4bf41cf` worklog)做
Frontend Reviewer 端到端验收。改动纯前端,无后端变更。

## 复审范围

- `components/McpChip.tsx`:class `chat-model` → `compose-mcp`;Plug size 12→11;
  加 `data-tooltip-place="top"`;去掉 inline `style`(并入 CSS class);注释中文→英文(§3.7)。
- `components/ChatView.tsx`:删 `import McpChip` 与头部 `<McpChip>` 渲染。
- `components/Composer.tsx`:import McpChip;在 `compose-tools` 末尾(branch chip 之后)
  渲染 `<McpChip sessionId={sessionId} />`。
- `index.css`:新增 `.compose-mcp`(同 compose-branch / history-chip 族,去 cursor/hover)。
- `Composer.mount.test.tsx` / `Composer.usage.mount.test.tsx`:`chatServiceMock` 补
  `GetSessionMcpServers: mock(async () => [])`。

## 正确性 ✅

### Props 流(无新增透传)✅
Composer props 已有 `sessionId: string`(`Composer.tsx:21`),直接喂 McpChip,
**无新增 prop drilling** —— 正是本次迁位的核心收益。ChatView 侧仅删除引用,无悬空 import。

### McpChip 防御与生命周期 ✅
- `useEffect([sessionId])` 内 `if (!sessionId) return` 守卫 —— Composer 测试 STUB_PROPS
  用 `sessionId: ""`(`Composer.mount.test.tsx:129`),McpChip 返 null、不调 binding。
  迁位后 39 个 Composer 测试全过,证明空 session 路径不炸。✅
- `servers.length === 0` → 不渲染(无 MCP 的 session 不占位),语义不变。✅
- `alive` flag + cleanup `() => { alive = false }` 防止 unmount 后 setState —— 迁位不涉及此,
  原生命周期完整保留。✅

### `.compose-mcp` 视觉同族(关键验收点)✅
与 `.compose-branch` / `.compose-history-chip` 逐项对齐:

| 属性 | compose-branch | compose-history-chip | compose-mcp |
|---|---|---|---|
| font-family | var(--mono) | var(--mono) | var(--mono) |
| font-size | 10.5px | 10.5px | 10.5px |
| color | var(--text-3) | var(--text-3) | var(--text-3) |
| background | var(--elev-2) | var(--elev-2) | var(--elev-2) |
| border | 1px solid var(--sep) | 1px solid var(--sep) | 1px solid var(--sep) |
| padding | 2px 7px | 2px 7px | 2px 7px |
| border-radius | 5px | 5px | 5px |
| height | 20px | 20px | 20px |
| margin-left | 4px | 4px | 4px |
| gap | 4px | 3px | 3px |
| cursor/hover | pointer + hover | pointer + hover | **无(只读)** |

差异仅「无 cursor/hover」—— 符合「状态指示不是操作」的语义定位。Plug 图标 11px 与
`compose-branch` 的 `GitBranch size={11}` 对齐。✅

### inline style → CSS class 无信息丢失 ✅
原 `style={{ display: "inline-flex", alignItems: "center", gap: 3 }}` 三项全部落入
`.compose-mcp`(`display: inline-flex; align-items: center; gap: 3px`)—— 无样式回归,
且把样式收敛进 class(便于主题/跨平台一致性调优,§4.6)。✅

### tooltip-place 一致性 ✅
新增 `data-tooltip-place="top"` 与同族邻居一致(`compose-branch` / `compose-history-chip`
均 `top`)。react-tooltip 单例 `md-tip` 复用(§4.5)。✅

### TypeScript / Wails binding ✅
- McpChip props `{ sessionId: string }` 不变;Composer 传 `sessionId`(已是 string)——
  类型对齐。✅
- `ChatService.GetSessionMcpServers` binding 存在(测试 mock 印证)。无新增字段,
  **无类型补丁反模式**(§5.3:字段加了但全链路无人消费 —— 本次无新字段)。✅

### i18n 同步 ✅
`chat.mcpChipTip` 在 `locales/{en,zh}.json:175` 双语存在:
- en: `"MCP servers in this session: {{names}}"`
- zh: `"本会话的 MCP 服务器:{{names}}"`

`{{names}}` 插值消费端在 McpChip 内(`names = servers.map(s => s.name).join(", ")`),
全链路有消费。✅

### 测试 mock 补全(关键防回归)✅
McpChip 随 Composer 挂载后会调 `GetSessionMcpServers`。两个 Composer mount 测试的
`chatServiceMock` 都补了 stub,组件渲染时不炸。`Composer.mount.test.tsx` /
`Composer.usage.mount.test.tsx` 共 **39 pass / 0 fail**。**无其它测试 import McpChip**
(全仓 grep 确认),无遗漏消费端。✅

### data-testid 可访问性(§4.2)✅
`data-testid="chat-mcp-chip"` 保留(见下面 nit #1 命名建议);tooltip 满足可解释性。

## 观察项(非阻塞 nit,不改)

### #1 data-testid 命名前缀仍为 `chat-`
McpChip 物理位置已迁到 Composer,但 testid 仍是 `chat-mcp-chip`,而同族邻居用
`composer-*` 前缀(`composer-branch` / `composer-history-chip` / `composer-history-badge`)。
**无任何测试当前依赖此 testid**(全仓 grep 无消费),日后若要加 Composer 集成测试可顺手
改为 `composer-mcp-chip` 对齐前缀。**不阻塞**。

### #2 i18n key 仍在 `chat.` 命名空间
`chat.mcpChipTip` 语义上已属 Composer,理论可迁到 `composer.mcpChipTip`。但 key 数量
少(仅 1 条 × 双语)、迁移收益低、且 `chat.` 命名空间本就含 chip 相关文案。**记为可选,
不阻塞**。

## 验证(acceptance gate)

1. `cd frontend && bun install` → 364 packages。
2. **`cd frontend && bun test --isolate Composer`**:**39/39 pass**(138 expect calls)。
3. **`cd frontend && bun test --isolate`(全量)**:209 pass / 2 fail / 2 errors。2 fail
   全在 `NewSessionModal`(binding 缺失,worktree 未 `wails3 gen bindings`,环境问题,与
   本改动无关)。改前(父 commit `5a1f5bf`)同环境同失败,**无新增失败 = 无回归**。✅
4. `cd frontend && bunx tsc --noEmit`:所有报错均为既有 `Cannot find module '../bindings/...'`
   (worktree 缺 `wails3 gen bindings` 产物),**无** McpChip / Composer 改动相关类型错。✅

## Verdict:APPROVE

迁位改动最小、干净:Composer 已有 `sessionId` 无需新增透传、`.compose-mcp` 与同族 chip
视觉逐项对齐(只读无 hover 的差异符合语义)、inline style 全部并入 class 无样式丢失、
tooltip-place 与邻居一致、两个 mount 测试补 mock 防 binding 调用炸组件、39 Composer 测试
全过、i18n zh/en 同步、无类型补丁反模式、无回归。两项 nit(testid 前缀 / i18n 命名空间)
均非阻塞,记为后续可选。建议合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-review-mcpchip-composer-tools-frontend.md`(本条,新增)。
