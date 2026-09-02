# Review #28963 — #190 fork 标题入 custom_title(后端面)✅ APPROVE

- **日期**: 2026-09-03
- **角色**: backend reviewer
- **对象**: `3ca88b0`(`fix(chat): fork of renamed session inherits title via custom_title (#190)`)+ `92a7e46`(worklog)。两 commit 已合入 main。

## 起因

带用户重命名(custom_title)的源会话被 fork 后,继承标题原落在 `title` 列,被 harness 权威标题更新链路(`syncSessionTitle` / `session_info_update`)在第一次 turn 后冲掉。规格四项:①有 custom 源 → `UpdateSessionCustomTitle(fresh.ID, custom+" (fork)")` 写免疫列,`CreateSession` title 参数回落源 harness 标题裸值;②无 custom 源现状不变;③custom 持久化失败 `slog.Warn` 静默不阻断;④三场景测试 + fork 徽章与 rename 徽章共存断言。红线:`syncSessionTitle` 不加守卫;前端/store/runner 零改动。

## 审查方法

按「类型补丁」反相追踪:不信 commit message 叙事,从 `custom_title` 写入点出发逐个确认真实消费端(Sidebar 显示/铅笔/fork tooltip/搜索/ChatView 头 + meta 事件合流)与免疫不变量(全部标题更新链路的 SQL 落点);测试逐条核断言锚定值;独立复跑 vet + 双包全量测试 + fork 用例 verbose。

## 逐项验证

1. **① 有 custom 源**(chat.go:1169-1184):`forkTitle = se.Title`(裸值无后缀)进 `CreateSession`;建行后 `UpdateSessionCustomTitle(fresh.ID, se.CustomTitle+" (fork)")`。免疫前提核过 SQL 落点:`UpdateSessionCustomTitle` 只写 `custom_title`(store/sessions.go:132-135);harness 侧三条链全只写 `title` 列——`syncSessionTitle`(chat.go:603)、`session_info_update` handler(chat.go:2831)、`UpdateSessionACP`(store:118,fork 流程内唯一的后续 title 写入,传 `fresh.Title` 裸值,与 custom 列无交集)。成功才回填 `fresh.CustomTitle`(else 分支),失败路径不返回半填充对象。
2. **② 无 custom 源**:legacy 路径 `title+" (fork)"`、custom 空,`fork_test.go:130-135` 锚定值钉死;fakeagent 真 wire e2e(`src title (fork)`)同证。新增断言仅一行,既有断言零改动即过(回归确认)。
3. **③ 失败静默**:`slog.Warn` 后不 return,fork 继续——与相邻 worktree best-effort 同构,且不越权补写 title 列(碰 `UpdateSessionTitle` 属红线,退化形态 = 裸标题,worklog 190 已如实记录)。注入精确性核过:trigger `BEFORE UPDATE … WHEN NEW.custom_title LIKE '% (fork)' AND <> OLD` 只命中 custom 一步(`CreateSession` 是 INSERT;worktree/forked_from/watermark/acp 的 UPDATE 均不含 `custom_title` 列,NEW=OLD 不触发);fixture 的源 rename 在 trigger 建立前且不带后缀,自体不受影响。断言锚定:fork 成功 + `ForkedFrom`/`ACPSession=="fork-acp-1"`/`ForkBaseSeq==2` 逐值核对。
4. **④ 测试**:三场景齐且全为锚定值断言(非字段存在性)。**发现一处规格缺口**:共存断言缺失——`TestForkSessionCustomTitleInherits` 钉了 custom_title/title/免疫但没钉 `ForkedFrom`,`forked_from AND custom_title` 同行并存(两枚徽章的数据对)在带 rename 路径上无断言,两半只在各自无 custom 测试里分别钉过。审查期补钉(见下)。

## 消费端通电(反类型补丁追踪)

`custom_title` 的读取面在本次改动前已存在且全链路活跃:Sidebar 显示 `customTitle || title`(Sidebar.tsx:929)、rename 铅笔(973)、原标题 tooltip(968)、fork 徽章 tooltip 源标题解析(580)、搜索(503)、ChatView 头(788);`chat:session-meta` 事件合流是 spread 后只 patch `title`(App.tsx:779),UI 侧免疫成立;前端 fork 后走 `refreshSessions` 重拉(App.tsx:1319-1324)——DB 写入是承重通路,DB round-trip 断言覆盖。徽章共存由两独立字段驱动,数据并存即渲染并存,前端零改动成立。

## 审查修正(f978407,test-only)

`TestForkSessionCustomTitleInherits` 补 `fresh.ForkedFrom != se.ID` 断言 + DB round-trip 检查扩展 `forked_from`,规格 ④ 的共存断言就地闭合。零生产代码触及,独立 commit 与被审 commit 分离。

## 独立验证(本机复跑)

- `go vet ./internal/chat/... ./internal/store/...` 干净;`go test ./internal/chat/... ./internal/store/... -count=1` 全绿(chat 18.2s / store 1.6s,ld macOS 版本 warning 为环境噪音)。
- `-run TestForkSession -v`:9/9 PASS(含 fakeagent 真 wire e2e、#189 watermark fatal、注入静默);修正后 `-run TestForkSessionCustomTitle -count=1` 复跑 PASS。
- 全量 `go build ./...` 未跑(worktree 无 frontend/dist 引导态,既有情况;internal 包经 vet+test 编译全过,与 #189 review 同判)。
- 三端(§4.7):纯 Go 后端 + test-only 修正,binding 签名与事件零变化,三端同效;后端能力验证统一做一次。红线核实:diff 仅 `internal/chat/`,store/前端/runner 零文件触及。

## 非阻塞观察

- fork-of-fork 后缀叠加:`"x (fork)"` 源再 fork → `"x (fork) (fork)"`,与 legacy 后缀行为同构,外观性,接受。
- worklog 190 称「`-run ForkSession -v` 10 个 fork 测试」,实配 9 个(`TestForkSession*`;lineage 两用例名为 `TestForkLineage*` 不匹配该 pattern)——纯 prose 计数,不影响结论。
- 失败退化态标题为裸源 harness 标题(无 ` (fork)` 后缀),与成功态 fork 行的可辨识性略不对称——规格明文「不阻断、静默」,补写需碰红线链路,取舍正确。

## 结论

**APPROVE**。①②③逐点落地且行为通路核实;④三场景齐,共存断言缺口已由审查期 test-only 补钉闭合。红线全部遵守(`syncSessionTitle` 无守卫、store/前端/runner 零改动)。按流程停 completed-ready:不 push、不关 issue、不自行派卡。

## 下一步

- 留人:真机视觉验收(带 rename 源 fork → 标题稳定不被 harness 冲掉;fork 徽章 + rename 铅笔共存),回写后由 coder 流程收尾关 #190。
