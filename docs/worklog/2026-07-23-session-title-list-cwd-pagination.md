# 2026-07-23 fix(acp): 探针确认 OMP session/list sessionId 语义 + 修 SessionTitle 匹配/兜底(Task #22117)

## 起因

`ChatSession.SessionTitle`(`internal/acp/runner.go`)经 `session/list` 拉 harness 为本 session
生成的权威标题。旧实现:

```go
lr, _ := cs.Conn.ListSessions(ctx, acp.ListSessionsRequest{})  // 无 cwd 过滤、不分页
for _, s := range lr.Sessions {
    if s.SessionId == cs.SessionID && s.Title != nil { return *s.Title, nil }
}
```

两个隐患:(1) **匹配的 sessionId 是否就是 NewSession 给的那个**?(OMP 是否用自家内部 id?)
此前只是「恰好能用」;(2) 无过滤拉首页,目标 session 仅因「最新」侥幸落在首页,跨项目切换 /
续旧 session 时有被挤出首页静默漏抓的风险。Task #22117 要求先探针确认 sessionId 语义,再修匹配/兜底。

## 探针(throwaway `probe_tmp/`,已删;真 harness,§5.3 外部事实先验证)

spawn `<bin> acp` → Initialize → NewSession → ListSessions(unfiltered vs cwd-filtered):

| harness | unfiltered 首页 | NextCursor | cwd-filtered | NextCursor |
|---|---|---|---|---|
| OMP 17.0.7 | 50 条(跨所有项目) | `"50"`(**有更多页**) | **3 条**(本项目) | nil |
| opencode 1.18.4 | 100 条 | nil | **2 条** | nil |

**结论**:
1. **sessionId 语义已确认**:OMP/opencode 的 `session/list` 返回的 `sessionId` 与 `NewSession`
   返回的**完全一致**(OMP UUID 形 `019f…`、opencode `ses_…`,精确相等命中)。`session/list` 的
   `sessionId` 就是协议 session 主键,**不是** harness 自家内部 id。现有 `s.SessionId == cs.SessionID`
   精确匹配正确,无需模糊化(§5.3:sessionId 是不变量,禁用 cwd 启发式当主键)。
2. **协议支持 `cwd` 过滤 + `cursor` 分页**(`ListSessionsRequest.{Cwd,Cursor}` / `NextCursor`),
   两个 harness 实测都支持。旧实现两个都没用 → 拉全量首页(OMP 还分页,首页 50 条封顶),
   目标 session 不在首页就静默漏抓。

## 改法(匹配 = cwd 过滤 + 精确 sessionId;兜底 = cursor 分页,有页数上限)

`internal/acp/runner.go`:
- 新增 `sessionLister` 抽象(`func(ctx, cwd, cursor) -> (sessions, nextCursor, error)`),
  把 session/list 单页拉取从 `SessionTitle` 抽出,**便于单测注入 mock**(§5.1 不启真 harness)。
- 新增纯逻辑 `findSessionTitle(ctx, list, cwd, sid)`:
  - **cwd 过滤**:按 `cs.WorkDir` 过滤(探针:50/100 → 2/3 条,目标 session 必在其中 —— §1.4
    每个 session 的 cwd = 项目目录/worktree)。把目标 session 钉在本项目首页,根治「被跨项目
    噪声挤出首页」。
  - **cursor 分页兜底**:逐页跟进 `NextCursor` 直到命中 / nil / 空串 / 耗尽。超大项目才触发,
    但保证「cwd 过滤集里也能找到」。按协议主键 sessionId 归并,不猜边界(§5.3)。
  - **`maxListPages=100` 上限**:防 misbehaving peer 永远返回非空 cursor 致死循环(peer 不可全信)。
- `SessionTitle` 改为构造 `listOnePage`(调 `cs.Conn.ListSessions` 带 `Cwd`+`Cursor`)委托给
  `findSessionTitle`。能力守卫(`!CanListSessions` 早返)不变,`TestSessionTitleCapabilityGuard` 无回归。

## 改了哪些文件

- `internal/acp/runner.go`:新增 `maxListPages` 常量、`sessionLister` 类型、`findSessionTitle`;
  重写 `SessionTitle`(cwd 过滤 + 分页委托)。
- `internal/acp/runner_test.go`:新增 `TestFindSessionTitle`(7 子测:首页命中 / 翻页命中 /
  nil cursor 终止 / nil Title 跳过 / 空 cursor 终止 / maxListPages 防死循环 / list 报错透传)。

## 验证

- 探针:真 `omp acp` / `opencode acp`,见上表(throwaway 程序,已删,不入库)。
- `go build ./internal/...`:✅(仅 main.go 的 `all:frontend/dist` embed 警告 —— 本 worktree 未
  构建前端,既有无关);`go vet ./internal/acp/... ./internal/chat/...`:✅。
- `go test ./internal/acp/ ./internal/chat/ ./internal/titlegen/ -count=1`:✅ 全 pass。
  `TestSessionTitleCapabilityGuard`(能力守卫无回归)+ `TestFindSessionTitle`(7 子测全 pass)。
- `ld: warning ... macOS version` 为工具链版本不符的既有噪声,与本改动无关。

## 下一步

- 桌面 app 实测(可选):跨多个项目切来切去、续一个非「最新」的旧 session 后跑一轮,确认侧栏
  标题仍能被 harness 权威标题覆盖(而非卡在兜底首条消息标题)。OMP 标题命中率本就低(~15%,
  在线 smol 凭据问题,非本应用 bug),重点看 opencode(应稳定覆盖)。
- 未改 §5.4(原则性规则无需新增;cwd 过滤/分页是实现细节,落在本文 + 代码注释)。
