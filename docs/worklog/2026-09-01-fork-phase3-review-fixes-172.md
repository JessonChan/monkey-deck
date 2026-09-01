# #172 fork Phase 3:review 裁决落地(按钮位置/血缘转写/空会话/钉库 fatal/测试基建)

日期:2026-09-01
关联:#172(session/fork)、review 结论(2026-09-01 对话裁决)

## 起因

#172 Phase 2(fork 全链路)完成后 review 提出 5 项,用户裁决:

1. **按钮位置**(P1-1):分叉按钮只在**最后一条 agent 行**渲染(协议无位置参数,fork 恒为末尾分叉;挂在早期消息上会邀请协议兑现不了的预期)。
2. **消息历史**(P1-2,用户方案推翻"深拷贝前缀"建议):fork 行不拷贝消息,DB 加血缘标识,**查询时拼装**——"查当前 session 的 + 它 fork 自的 base 的",历史即完整。用户认可补充设计:水位列 `fork_base_seq`(源在 fork 时刻的最大消息 seq)、回放去重按主键外不变量。
3. **测试基建**(P1-3):按既定策略收口 mock 泄漏。
4. **ACP id 钉库失败改 fatal**(P2-4)。
5. **空会话禁 fork**(P2-5)。

用户同时确认**工作区语义**:fork 钉在源的目录上(worktree 会话 → 同一 worktree 文件夹,guest 角色;普通会话 → 项目目录)——与既有实现一致,维持不变。

## 改动

### 1. 按钮:仅最后一条 agent 行(`ChatView.tsx`)

- 新增 `lastAgentIdx`(逆向扫 items 的 useMemo,镜像 `agentTurnDuration` 的廉价扫描)。
- `ChatRow` 的 `canFork` 收紧为 `(props.canFork ?? false) && row.kind === "agent" && row.first === lastAgentIdx`。
- 测试改为两轮对话(u0/a1/u2/a3),断言全树只有 1 枚 fork 按钮。

### 2. 血缘转写(store + chat)

- **迁移 `0024_session_fork_base_seq.sql`**:`sessions.fork_base_seq INTEGER NOT NULL DEFAULT 0`(水位;0=未记录)。`sessionColumns`/`scanSession` 27→28 列,列数守卫测试同步 28。
- **store 新增**:
  - `SetSessionForkBaseSeq`(写水位;lineage 元数据不动 updated_at,与 pinned/tags 同理);
  - `MaxSessionMessageSeq`(读源最大 seq,fork 时捕获水位);
  - `ListMessagesUpToSeq`(源消息按 `seq<=水位` 升序取,血缘前缀查询)。
- **chat `ForkSession`**:RPC 前最后一刻 `srcMaxSeq := MaxSessionMessageSeq`(源已过 busy 守卫,空闲,无新行;即使 fork 后源继续长消息,水位天然排除);落库时 `SetSessionForkBaseSeq(fresh, srcMaxSeq)`。
- **`LoadMessagesPage` 血缘拼装**(`forkLineagePage`):fork 行(`forked_from!="" && fork_base_seq>0`)的转写 = base 前缀(负 seq 偏移 `m.seq - watermark - 1` ∈ [-N,-1])+ 自身消息(正 seq),**单一升序游标**——前端分页(beforeSeq cursor / hasMore probe / prepend)零改动。非 fork 行走原路径。
  - 关键不变量:own 查询 cursor≥0(负游标已翻完 own,直接跳过——否则取"最新一页"会令游标回跳,曾致无限循环);base 严格排除游标行(`srcBefore = offset + watermark`,不含 +1);merge 顺序 base 在前 own 在后(时序);超窗从头截(保最新窗口)。
- **fakeagent e2e 追加断言**:水位=2;源 fork 后新消息不漏进 fork 视图;base 行以 fork 的 session id 出面。

### 3. fork 窗口回放抑制(`acp/runner.go` `Fork`)

opencode 在 fork RPC 窗口内回放 forked session 的最近 20 条 session/update(携带**新 fork 的 ACP sessionId**),而 chat.handleEvent 会把这些事件钉到**源** liveSession → 源 UI 闪现重复气泡 + 内存 timeline 污染。修法同 Resume 的抑制窗:RPC 期间 Handler.OnEvent 丢弃内容类 chunk(message/thought/tool/plan),元数据(available_commands/config/usage)放行;RPC 返回即恢复。fork 行的历史来自 DB 血缘查询,丢弃无损失。这是「按 messageId 去重」意图的更强实现(回放携带跨 session 的新 messageId,messageId 事后去重根本对不上;源头抑制才是不变量)。

### 4. 空会话禁 fork(`chat.go`)

`errForkSourceEmpty`(中文人话,§4.4):源 session 无消息时在 ensureLive **之前**拒绝(不值得为空会话 spawn harness)。

### 5. ACP id 钉库失败 fatal(`chat.go`)

`UpdateSessionACP` 失败不再 Warn 吞掉:未钉 id 的 fork 行下次 open 会 NewSession 开出**无上下文**新会话却戴着 fork 徽章——比报错更糟。改为 best-effort 删行(`DeleteSession`)+ 返回错误。

### 6. 测试基建:共享全表面 chatservice mock(`src/test/chatservice-mock.ts`)

- **根因**:bun `mock.module` 是进程级替换。各测试文件手挑**部分**函数 mock,同进程多文件批跑时**最后注册者**对所有文件生效——Sidebar 系文件的 4 函数 mock 让 ChatView 树里的 McpChip 调 `GetSessionMcpServers` 拿到 undefined 崩掉(fork 三文件批跑必挂 3 个)。
- **修法**:`mockChatservice(overrides)` 按**生成的 binding 全表面**(121 函数)构造,未覆盖者一律 async undefined;`registerChatserviceMock(mock, overrides)` 注册。未知 override 名直接 throw(拼写错误必须响)。
- fork 三文件(ChatView.fork / Sidebar.fork / Sidebar.forkbadge)迁移到工厂;双向批跑 12/12 绿,顺序无关。
- **诚实边界**:套件其余 ~15 文件的既有泄漏(virtualList/math/table/permission 等,基线批跑 49 fail 指纹与改动前完全一致)**未迁移**——独立基建工作,本次不动;但模式已立,后续按文件渐进迁移即可。

## 踩坑(本次实证)

- `base, err := ...` 在 if 块内遮蔽外层 `var base`——块内赋局部、外层恒 nil,merged 恒等于 own。症状:wide page 只返回 own 行。Go 老坑,`:=` 在新作用域即新变量。
- 负游标下 own 查询按"最新一页"回取 → 游标回跳正数 → **分页无限循环**(测试挂死 180s 超时才发现)。负游标必须跳过 own 查询。
- 测试期望表手工推演跨 own/base 边界的 probe 行极易错;改**性质断言**(分页拼接 == 全量升序)更稳。
- 前端 probe 约定:`msgs` 升序返回 limit+1,**最旧**那条是 probe;`slice(1)` 去掉后 cursor=新首行;被切行由下一页 `seq < cursor` 正常取回,无丢失无重复。

## 验证

- Go:`go test ./internal/...` 15 包全绿(含 chat 19.8s 全量);新增 `fork_lineage_test.go` 3 用例(分页全量等价/源后长不泄漏/非 fork 不受影响)、fakeagent e2e 扩血缘断言、既有 fork mock 测试补源消息种子、store 列数守卫 28。
- 前端:`bunx tsc --noEmit` 0 错;fork 三文件单跑 + 双向批跑 12/12 绿(修前反序必挂 3);ChatView 家族回归仅剩预存失败(math 等,stash 基线指纹一致,非本次引入)。
- 三端:改动面为前端组件渲染 + Go binding 逻辑,无新协议面;§4.7 三端回归——GUI/远程浏览器/PWA 共用同一 React 树与 binding 通道,按钮位置/血缘分页对三端同效;未动 ≤768px 断点与 remote 守卫。

## 下一步

- 套件其余文件渐进迁移到 `registerChatserviceMock`(独立任务)。
- 真机 fork 一次 opencode 会话验证血缘转写视觉(可选,单测已覆盖行为)。
