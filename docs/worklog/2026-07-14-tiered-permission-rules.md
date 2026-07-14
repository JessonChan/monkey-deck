# 2026-07-14 分级访问控制(allow/ask/deny + 配置 + 默认规则)

## 起因
Task #15111。原权限模型只有「记忆」(session/project allow always)与「弹窗」两档:
没选记忆时每次工具执行都弹窗确认,体验割裂(尤其只读类工具反复确认)。需要分级访问
控制:按 tool/动作/路径/命令模式设 allow(自动放行)/ ask(弹窗)/ deny(自动拒绝),
消除对话中反复确认,同时把危险命令(rm -rf 等)硬拦下。

## 设计(分级机制 + 配置框架,聚焦主流工具)
**路由优先级**(在 `acp.Handler.RequestPermission` 内,工具执行前):
1. **记忆命中**(用户曾选 session/project allow always)→ 放行(最高优先,§3.4)。
2. **规则引擎**:逐条评估 `permission_rules`,首条命中者决定裁决:
   - allow → 自动放行、deny → 自动拒绝(都不弹窗)、ask/无命中 → 弹窗确认。
3. 兜底:无规则引擎 → 弹窗(等价旧行为)。

**规则维度**(AND 语义,空约束 = 通配):
- `tool_name`:ACP ToolKind(read/edit/execute/...)
- `action_type`:动作分组(read/write/exec/other/any),由 ToolKind 派生
  (read/search/think/fetch→read;edit/delete/move→write;execute→exec)
- `path_pattern`:glob(对任一 location 命中即算);支持 `dir/**` 前缀、无 `/` 时对 basename 也匹配(贴近 .gitignore)
- `command_pattern`:正则(对从 RawInput 抽取的 bash 命令匹配;抽不到则规则不命中)
- `level`:allow/ask/deny;`sort_order` 决定优先级(小者先判定)
- `enabled`:可禁用单条

**默认规则**(表空时播种,用户可改/删):
1. exec + 危险命令正则(rm -rf 家族 / fork 炸弹 / mkfs / dd→/dev/ / >/dev/sd)→ **deny**
2. read 类(只读)→ **allow**(agent 反复读代码无需反复确认)
3. write 类(edit/delete/move)→ **ask**
4. exec 类(普通命令)→ **ask**(危险命令已被第 1 条截走)

**不做的**:边缘工具全覆盖(留给后续增量);每项目独立规则(全局一份,够用且简单);
Terminal 类回调(阶段 0 不支持)。范围严格限定「分级机制 + 配置框架 + bash/edit/write/read 默认」。

## 改法(分 3 层)
- **纯逻辑层 `internal/permissions/`**:Rule / Engine / Decide / ActionOfKind / ExtractCommand /
  DefaultRules。零 DB / 零 ACP 依赖,单测注入规则即可(§5.1)。非法正则的规则跳过不崩。
- **持久化层 `internal/store/migrations/0009_permission_rules.sql` + `permissions.go`**:
  `permission_rules` 表 CRUD + `SeedDefaultPermissionRules`(表空播种)。store 不依赖
  internal/permissions(避免反向依赖),默认规则的 struct 转换在 service 层做。
- **Hook `internal/acp/handler.go`**:`Handler.permRules atomic.Pointer[permissions.Engine]`,
  `SetPermissionRules` setter;`RequestPermission` 在记忆之后、弹窗之前评估规则。deny 返回
  reject option(harness 给了 reject 时)或 cancelled(没给)。
- **Service `internal/chat/chat.go`**:启动时播种默认 + 读取规则;session 启动(startLive)
  把规则快照刷进 handler;CRUD 方法(List/Create/Update/Delete/Reorder/ResetPermissionRules)
  暴露给前端,每次变更后 `applyPermissionRulesToAll` 刷新所有活跃 session 的 handler 快照。
- **前端**:`PermissionSettings.tsx` 弹窗(规则列表 + 行内编辑 + 增删 + 上下移优先级 + 恢复默认),
  Sidebar header 加 `ShieldCheck` 图标按钮入口;zh/en 文案;CSS。

## 改了哪些文件
- 新增 `internal/permissions/permissions.go` / `defaults.go` / `permissions_test.go`
- 新增 `internal/store/migrations/0009_permission_rules.sql` / `permissions.go` / `permissions_test.go`
- 改 `internal/acp/handler.go`(permRules 字段 + setter + RequestPermission 路由)、`runner.go`(ChatSession.SetPermissionRules 透传)
- 新增 `internal/acp/handler_rules_test.go`(allow/deny/ask/记忆优先级 四组复现测试)
- 改 `internal/chat/chat.go`(chatConn 加 SetPermissionRules;startLive 快照;CRUD + 刷新方法)
- 改 `internal/chat/queue_test.go` / `idle_reaper_test.go`(mock 补 SetPermissionRules)
- 新增 `frontend/src/components/PermissionSettings.tsx`
- 改 `frontend/src/App.tsx`(状态 + 渲染)、`Sidebar.tsx`(入口按钮)、`index.css`(面板样式)、
  `i18n/locales/{en,zh}.json`(文案 + common.done)

## 验证
- `go build ./...` / `go vet ./...` 全绿(仅 macOS 链接器 SDK 版本警告,与改动无关)。
- `go test ./...` 全绿:permissions(引擎/默认规则/路径/命令/禁用/非法正则)、store(CRUD/播种)、
  acp(handler 规则路由 4 组)、chat(queue/idle reaper 回归)。
- `wails3 generate bindings` 重新生成(chatservice 暴露 6 个权限方法 + PermissionRule model)。
- `cd frontend && bun run build`(tsc + vite production)通过,无类型/编译错误
  (仅预存在 chunk>500kB 警告)。
- `frontend/dist/index.html` 临时 stub(go:embed 要求目录非空,被 .gitignore 排除不入库)。

## 下一步
- 手动 wails3 dev 验证:默认规则下 read 工具不弹窗、edit/普通 bash 弹窗、`rm -rf` 被 deny;
  设置面板增删改规则、移优先级、恢复默认;规则变更即时作用于活跃 session。
- 边缘工具(grep/glob/webfetch/...)的细化默认规则增量补。
- 可选:危险命令被 deny 时前端给「被规则拦截」的可视反馈(当前静默 reject)。
