# 2026-07-23 feat:PermissionCard 加「全局允许」按钮(global)(Task #22127)

## 起因
Task #22127:权限裁决卡(`PermissionCard`,`ChatView.tsx`)目前只有
「允许本次 / 本会话 / 本项目 / 拒绝」四档,缺一个最高档「全局允许」(跨所有项目 / 会话
自动放行)。本任务仅做前端:加按钮 + 调 `onRespond("global")`。后端如何记忆「全局」档
是另一条任务(见「下一步」),与本条解耦。

## 改法
KISS,三处最小改动:

1. **PermissionCard 加按钮**(`ChatView.tsx`):在 `project` 与 `deny` 之间插一颗
   `<button data-testid="perm-global" onClick={() => onRespond("global")}>`。
   - 档位按「范围升序」自然排列:`once < session < project < global`,再 `deny`。
   - 复用现有 `.perm-btn .perm-allow`(绿色)样式,无需新增 CSS。
2. **i18n**:`permAllowGlobal` 加进 `zh.json`(「全局允许」)与 `en.json`(「Allow globally」),
   与现有 `permAllow*` 键同处,保持字典顺序一致。
3. `onRespond` 回调链不变(`ChatView` → `App.tsx#respondPermission` →
   `ChatService.RespondPermission(sid, perm.id, "global")` → `Handler.RespondPermission`
   → `RequestPermission` 的 `p.response <- "global"` → `applyDecision("global", opts)`)。

## 改了哪些文件
- `frontend/src/components/ChatView.tsx`:`PermissionCard` 加 `perm-global` 按钮。
- `frontend/src/i18n/locales/zh.json` / `en.json`:新增 `permAllowGlobal` 键。

## 验证
- `wails3 generate bindings`(bindings 不入库,本地生成以跑前端 build)。
- `bun run build`(`tsc && vite build`):**通过**(仅 chunk>500kB 的既有 warning)。
- `bun test`:97 pass / 0 fail。
- 注意:后端 `applyDecision`(`internal/acp/handler.go:464`)目前没有 `case "global"`,
  会落到 `default`(= once:允许本次、不记忆)。前端按钮先把 `optionId="global"` 发出去,
  后端记忆语义留给配套任务实现 —— 本条只动前端。

## 下一步
- 后端配套:在 `applyDecision` 加 `case "global"` 并落「全局」级记忆(需比 session/project
  更广的存储,如应用级全局开关 / DB 全局权限表),使「全局允许」真正跨项目生效。
- 视交互需要,考虑「全局」这种高危档是否要二次确认(§3.4 高危必须人工)。
