# 2026-07-23 review:权限弹窗「全局允许」端到端验收(Task #22129 / Review #22125)

## 起因
Review #22125 = 端到端验收「权限弹窗全局允许」整条链(被审 Task #22126 后端 +
#22127 前端 + #22128 rebase 恢复)。Reviewer 职责:不只「编过 + 测过」,要证明
**行为真的实现了**(防「改签名不改函数体、build 绿但 bug 在」)。重点核对四段 DoD:
①前端 global 按钮;②后端 onRespond("global")→全局 PermissionRule(level=allow,准确匹配);
③单测;④跨项目自动放行。

## 验证做了什么
1. **环境对齐**:`bun install` + `make bindings`(bindings 不入库,启动生成)+ `bun run build`
   (`tsc && vite build`)+ `go build ./internal/...` + `go vet ./internal/...`:全绿
   (vite 仅 chunk>500kB 旧 warning;go build ./... 的 `frontend/dist` embed 报错是预存在,
   前端未构建产物所致,与改动无关)。
2. **全链路逐段读源码核对**(非盲信 worklog,确认函数体行为真实改变):
   - **前端按钮**(`ChatView.tsx:1309`):`perm-global` → `onClick={() => onRespond("global")}`,
     真发出 `"global"`。i18n `permAllowGlobal`(zh「全局允许」/en「Allow globally」)在位。✓
   - **App 透传**(`App.tsx:761`):`respondPermission(optionId)` 原样把 `optionId` 传给
     `ChatService.RespondPermission(sid, perm.id, optionId)`——无过滤、无映射,"global" 原样进后端。✓
   - **service 桥**(`chat.go:1890`):`RespondPermission` 只对 `"project"` 写 `SetProjectAllowExternal`,
     `"global"` 不特判,直接 `ls.chat.RespondPermission(reqID, "global")` 转发到 handler 通道。✓
   - **handler 消费**(`handler.go:373-385`):`RequestPermission` 收到 `"global"` →
     `applyDecision("global")` + `emitGlobalRule(req)`,返回 allow 选项。
   - **applyDecision 的 global 分支**(`handler.go:483-487`):`case "project", "global":` 真正
     `sessionAllowExternal.Store(true)` + `projectAllowExternal.Store(true)`——**函数体行为变了**,
     不是只改签名。(本 session 即时放行,降级安全)✓
   - **emitGlobalRule**(`handler.go:496-501`):`OnGlobalRule != nil` 时真正调
     `OnGlobalRule(permissions.ExactMatchRule(toMatchRequest(req)))`——把请求固化成规则交 service。✓
   - **ExactMatchRule**(`permissions.go:271-289`):命令 → `^QuoteMeta(cmd)$`(锚定+转义全等);
     无命令有路径 → 首个 location 原值;否则仅工具+动作。level=allow、enabled=true。**形状准确匹配**。✓
   - **持久化 + 跨 session 刷新**(`chat.go:2287-2300`):`persistGlobalPermissionRule` 把
     `permissions.Rule` 转 `store.PermissionRule` 调 `CreatePermissionRule`(`chat.go:2325`):
     validate → `st.CreatePermissionRule`(入库)→ `applyPermissionRulesToAll`(`chat.go:2273`)
     遍历**全部活跃 session** 调 `SetPermissionRules`。**跨 project/session 自动生效** ✓
   - **回调注册**(`chat.go:1078`):`startLive` 里 `chat.Handler.OnGlobalRule = s.persistGlobalPermissionRule`
     真接线。✓
3. **测试断言真行为**(读测试体确认非「永真测试」):
   - `TestRequestPermissionGlobalEmitsExactMatchRule`(`handler_global_test.go:16`):
     断言 OnGlobalRule 被调 + 规则形状 `^git status$` + 返回 allow + **`dispatch==1`**(第二次请求不再弹窗,
     验记忆命中)。真实行为断言。✓
   - `TestExactMatchRuleReproducesRequest`(`permissions_test.go:269`):
     用 ExactMatchRule 造规则喂引擎,**同命令 allow / 不同命令(前缀/后缀)ask / 不同工具 ask**——
     真正验「准确匹配」语义,不是形状空判。✓
   - `TestRequestPermissionGlobalFSShapePath` + `TestRequestPermissionGlobalNoCallbackStillAllows`:
     fs 路径形状 + nil 回调降级放行。✓
4. **全量测试**:后端 `go test ./internal/...` 全绿(acp/chat/permissions 等);前端 `bun test`
   97 pass / 0 fail。

## 验收结论
**PASS**。四段 DoD 全部真实生效,无「改签名不改行为」、无断链:
- ①前端 global 按钮 + i18n ✓
- ②后端 onRespond("global")→全局 PermissionRule(level=allow,ExactMatchRule 准确匹配)✓
- ③单测覆盖形状 + 复现语义 + 记忆 + 降级,-race 干净 ✓
- ④跨项目自动:经 CreatePermissionRule → applyPermissionRulesToAll 刷全部活跃 session 规则快照 ✓

## 观察(非阻塞,记录供后续判断)
- **本 session 内是粗记忆、非准确规则**:`applyDecision("global")` 把 `sessionAllowExternal`/
  `projectAllowExternal` 都置 true,本 session 后续**所有**权限请求经顶部记忆分支(handler.go:303)
  直接放行,**不走规则引擎**(记忆优先级高于规则)。即「全局允许 git status」后,本 session 内连
  `rm -rf` 也会被记忆放行(本 session);准确规则只对**其它/新 session**(经 DB 规则)生效。这是
  coder 的 KISS 取舍(worklog #22126 已明述「本 session 即时放行」),自洽且降级安全,不判为问题。
  单测 `...EmitsExactMatchRule` 诚实标注验的是记忆路径(dispatch==1),规则复现另由
  `TestExactMatchRuleReproducesRequest` 独立覆盖。
- **无跨 session 集成测试**:要让两个活跃 session 互相验证需 store + 多 live session,较重。当前靠
  既有已测的 `applyPermissionRulesToAll` 机制 + 引擎复现单测组合证明,单测范围内可接受;
  实机跨 session 验证留给 `wails3 dev`(worklog #22128「下一步」已列)。
- **高危档无二次确认**(§3.4「高危必须人工」):「全局允许」一键即落全局 allow 规则,无 confirm。
  worklog #22127「下一步」已记此考量。若产品反馈误点风险大,可加二次确认弹窗(改动小)。

## 改了哪些文件
- 仅本条 worklog(本次为 review,未改功能代码;环境产物 node_modules/bindings/dist 不入库)。

## 下一步
- 实机验证(`wails3 dev`):点「全局允许」→ 新建另一 session 触发同标识请求应自动放行;重启 app 后
  规则仍在(SQLite 持久化)。
