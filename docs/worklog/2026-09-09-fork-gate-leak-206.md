# 2026-09-09 调查:fork 按钮门控漏点定位(#206)—— 无漏,入口可见是声明位门控的正确产物

## 起因

Task #29050(issue #206):用户实测「不支持 fork 的 harness(如 codex-acp)仍看到 Fork 入口」。
理论门控链(前端 `canForkSession` 声明位门控 + 后端 `CanFork`/`ForkSession` 双保险)已上线,
入口仍可见 → 怀疑门控链有漏点或误报。任务规定:**有漏即修 / 无漏出结论(反证落 worklog,不修码)**。

## 结论(无漏)

**门控链逐项核查无漏点。入口对 codex-acp 可见,是因为 codex-acp 自己在 Initialize 响应里
声明了 `sessionCapabilities.fork: {}` —— 按 #172 铁律①(声明位是唯一门控,错误码不作依据),
入口就该显示;且 codex-acp 的 `session/fork` 对有历史的 session 实测可用。**
「codex-acp 不支持 fork」这一前提被 harness 自身 wire 行为反驳,属误认,非本仓漏点。
唯一失败形态(零回合 session fork 报 `-32603 no rollout found`)已被本仓
「空会话拒绝 fork」守卫(`chat.go` ForkSession,`errForkSourceEmpty`)在任何 RPC 之前拦截。
按任务规定此分支不修码;issue 关单动作留人。

## 核查记录(按嫌疑清单逐项)

1. **消费点全查(App.tsx `canForkSession` 下游)**:门控本体 `App.tsx:1402-1405` 干净
   (`!s → false;!!harnessCaps[s.harness]?.sessionFork`,无 `?? true`/默认开)。全部消费点仅两处入口:
   - Sidebar 右键菜单项 `Sidebar.tsx:1223`:`props.canForkSession?.(ctx.session) && props.onForkSession &&` 双门;
   - ChatView 消息行按钮:`App.tsx:2673` 传 `canFork={canForkSession(activeSession)}`,
     `ChatView.tsx:869` 再与「agent 行 + 末条 agent」条件与(`?? false` 兜底),`MessageActions`
     仅在 `fork` 对象非空时渲染(`ChatView.tsx:1255`)。
   - Sidebar 的 GitFork 徽章(`Sidebar.tsx:1026`)是 lineage 标记(`forkedFrom` 非空才渲染),不是入口。
   - popout 自举:popout 与主窗口共用同一 App 组件,`reloadHarnessCaps` 挂载即拉 +
     订阅 `chat:harness-capabilities`(`App.tsx:1394-1398`),popout 照常拿到 harnessCaps。
   - 无键盘快捷键等未门控渲染分支。Composer 分支 chip → NewSessionModal 是 git worktree
     「新建会话」链路,与 #172 ACP fork 是两个特性,不受此门控(设计如此)。
2. **ProbeCapabilities 失败路径无 all-true 占位**:spawn 失败返回全 false 矩阵
   (`internal/acp/capability.go:165`);NewSession 失败只带已得声明位(`:178-181`)。
   SDK `SessionCapabilities.Fork` 是对象指针(`fork,omitempty`,`{}` 即声明),不存在
   「显式 false 被当真值」的歧义。`chat.go` capabilityCache 只在 `probeCapabilitiesAsync`
   写入(合并保留旧项,`:3477-3488`);前端初载 `{}` → 未探测/事件未达 = 隐藏(fail-closed)。
3. **AddHarness 派生 id 一致性**:`resolveHarnessID`(`chat.go:3315-3349`)对内置 /
   catalog / 用户 harness 三方查重,冲突加 `-2` 后缀消歧;session.harness 与
   capabilityCache 同以 harness.ID 为键,不存在别名撞键查到错误 caps 对象的路径。
4. **判定**:同上结论 —— 用户前提被 wire 实证反驳。

## 实证(wire 级,本机 `~/.bun/bin/codex-acp` 真实 stdio JSON-RPC 握手)

- **codex-acp Initialize 响应**:`agentCapabilities.sessionCapabilities` 含
  `{"resume":{},"list":{},"close":{},"delete":{},"fork":{},"additionalDirectories":{},"subagents":{}}`
  —— **fork 声明在场**(omp 同样声明 `fork:{}`,对照一致)。
- **零回合 session fork**(session/new → session/fork):
  `{-32603 "Internal error","data":{"details":"no rollout found for thread id …"}}`
  —— 与 #172 先例一致(-32603 而非 -32601,故「错误码不作门控依据」铁律有效)。
- **有历史 session fork**(session/load 既有 rollout `019c7ac2…` → session/fork):
  **成功**,返回新 sessionId `01a081c0-5ed9-…` 与 configOptions —— codex-acp 的 fork
  对真实(非空)会话可用;而空会话 fork 本仓已在 RPC 前拒绝,应用内正常流程打不到该错误。

## 改了哪些文件

无代码改动(无漏分支,任务规定不修码)。本文档一条。

## 验证

1. `frontend`: `bun run build`(tsc + vite)通过;`git status` 干净
   (dist/bindings/node_modules 均 gitignore,无 `.rak-env` 等运行时文件混入)。
2. **既有 fork mount 测试即「undeclared → 不渲染」契约**:`ChatView.fork.mount.test.tsx`
   (canFork=false → 按钮完全不渲染,hide not disable)+ `Sidebar.fork.mount.test.tsx`
   (undeclared → 菜单项不渲染)共 7 用例全绿 —— 任务第 5 项要求的测试形态已存在,无需新增。
3. 全量 `bun test`:577 tests / 81 files,21 fail + 1 error **均为既有环境性失败**
   (clipboard/execCommand happy-dom、panel layout、worktree guard、tool card copy、
   LaTeX、coarse pointer、scheduled alarm 等;与本树零代码改动一致,无任何 fork 相关失败)。
4. 生成绑定核对:`wails3 task bindings` 产物 `sessionFork: boolean`,与前端消费字段名一致。

## 下一步 / OPEN

- 若 codex-acp(Zed adapter)侧认为其对 fork 的声明与产品语义不符(尤其零回合场景的
  `-32603`),那是上游声明问题;按铁律①本仓不做行为级门控(错误码不作依据,#172 探针已裁决)。
- issue #206 关单动作留人;不 push、不自行派 review(按任务规定)。
