# 2026-08-10 McpChip 从 ChatView 头部迁到 Composer compose-tools(#115, Task #24259)

**起因**:issue #115 —— MCP 状态 chip 原本挂在 ChatView 头部(model chip 旁),与
「输入区状态指示」(branch chip、history chip)语义同族却分散两处。把它迁到
Composer 的 `compose-tools`,与同类 session-context 指示器聚到一起,头部更干净。
同时消除「ChatView 单独 import + 渲染」的耦合(Composer 本就持有 `sessionId`,无需额外透传)。

## 改法

- **McpChip.tsx**:样式从 `chat-model`(头部 model chip 风格)换成新 `.compose-mcp`
  class,与 `compose-branch` / `compose-history-chip` 同族(mono + elev-2 底 + sep 边 +
  height 20px + margin-left 4px),但**只读**(无 pointer/hover —— 状态指示不是操作)。
  Plug 图标尺寸 12 → 11 与 branch 的 11 对齐;补 `data-tooltip-place="top"` 与邻居一致。
  注释转英文(§3.7)。
- **ChatView.tsx**:删 `import McpChip` 与第 655 行 `<McpChip>` 渲染。
- **Composer.tsx**:import McpChip;在 `compose-tools` 末尾(branch chip 之后)渲染
  `<McpChip sessionId={sessionId} />` —— Composer 已有 `sessionId` prop,无需新增透传。
- **index.css**:新增 `.compose-mcp`(模型同 compose-branch,去掉 cursor/hover)。
- **测试**:`Composer.mount.test.tsx` / `Composer.usage.mount.test.tsx` 的
  `chatServiceMock` 补 `GetSessionMcpServers: mock(async () => [])` —— McpChip 现在随
  Composer 挂载,会调这个 binding,不补会炸(组件渲染时报错)。

## 验证

- `bunx tsc` 干净(bindings 已 `wails3 generate bindings` 生成)。
- `bun run build` 成功。
- `bun test --isolate`:`Composer.*` 全部 39 pass;全量 217 测试剩 5 个 fail 全在
  `NewSessionModal.mount.test.tsx`(与本次无关,改动前同样 fail —— 预存在)。

## 改了哪些文件

- `frontend/src/components/McpChip.tsx`(样式 class + 英文注释)
- `frontend/src/components/ChatView.tsx`(移除 import + 渲染)
- `frontend/src/components/Composer.tsx`(import + 渲染)
- `frontend/src/index.css`(`.compose-mcp`)
- `frontend/src/components/Composer.mount.test.tsx` / `Composer.usage.mount.test.tsx`(mock 补全)

## 下一步

无;功能点完整收口。
