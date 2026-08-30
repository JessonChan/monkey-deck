# 2026-08-30 · junie resume 粘连缓解:resume 后首个无 messageId chunk 强制开新块(#79 / Task #28424)

## 起因

重开 junie session 后立即发消息,回复「粘」进 resume 前的旧气泡(用户观感:发送成功无回复)。父 issue #28423 全量规格拍板方案 C:resume 结束后的**第一个**无 messageId `agent_message_chunk` 强制开新块,只 rotate 一次;后续 chunk 回到既有无 messageId 粘连语义。

## 根因(引用 audit + rotate 边界)

两个 harness 缺陷叠加(`docs/worklog/2026-08-06-acp-conformance-audit.md` 实证):

1. **junie resume 违规重放历史**(违反 session-resume.mdx MUST NOT replay;探针 ResumeReplays 5/5 稳定检出,`drain 3s` 后完全可靠)——重放块在 `conn.ResumeSession` 阻塞窗口**之后**仍在流入,穿透 `runner.go` 既有抑制窗口(该窗口只覆盖阻塞 RPC 期间)。
2. **junie 不发 `messageId`**(§5.4 #10)——所有 chunk 走 fallback merge。

叠加效果:穿透重放/上一轮中断残留的 streaming 气泡在 resume 边界后仍开着,fallback merge「找最后一个同类型 streaming item 归并」把真实回复并了进去(前端 `streamMerge.ts` 文本替换语义还会覆盖掉旧气泡内容,回复出现在用户消息上方)。**rotate 边界**:resume 完成后首个无 messageId message chunk 是边界——它之前开的块都属 resume 前世界,不允许粘连;它之后的块回到既有语义(连续同 role 粘连、role 变化/tool_call 轮换)。

## 改法(方案 C:后端打标,前端消费)

- **打标(`internal/acp/runner.go`)**:`ResumeChatSession` 在阻塞 RPC 前装好 `atomic.Bool` 臂标;放行链路包一层 `tagResumeRotate`——`agent_message_chunk` 且 `MessageID==""` 时 CAS 消费臂标、给该事件置 `RotateOnce`。窗口内的重放块先被抑制层丢弃,tagging 永远看不到,故天然只有 resume 返回后的块能消费;thought/metadata/带 id 的块穿过不耗臂标;每 resume 恰好一条事件带标。`NewSession` 路径不装,零感知。带 messageId 的 harness(omp/opencode)完全不受影响(主键路径不读该标)。
- **字段(`internal/acp/handler.go` + `frontend/src/types.ts`)**:`SessionEvent.RotateOnce bool`(`json:"rotateOnce,omitempty"`),随既有 `chat:event` JSON 通道下发,无新 binding。
- **后端消费(`internal/chat/chat.go` `messageKey`)**:fallback 路径 rotate 条件加一档 `rotateOnce || fallbackRole != role` → 强制 `fallbackSeq++` 换新 key → 新 entry。主键路径显式忽略该标(带 id 的消息不许被自己的标劈开)。resume 后 `liveSession` 本就是新建的,此档在实际链路上是防御性的,但把 rotate 语义收敛在 merge 本体内(§5.3 不变量归一)。
- **前端消费(`frontend/src/lib/streamMerge.ts`)**:fallback 分支回搜「最后一个同类型 streaming item」前先看 `ev.rotateOnce`——置位则跳过回搜直接 finalize+新开气泡;只 rotate 这一次,后续 chunk 回归既有粘连。
- **既有机制零改动**:resume 抑制窗口(丢历史重放、放行元数据)、resume_patch(mcpServers omitempty 兜底)原样保留;真回复内容不丢不吞(区别于被否决的「扩大抑制窗口」方案——那会吞掉真回复的首块)。

## 改了哪些文件

- `internal/acp/handler.go`:`SessionEvent` 加 `RotateOnce` 字段。
- `internal/acp/runner.go`:`ResumeChatSession` 事件链加装 `tagResumeRotate`(纯函数抽出便于单测);触及的抑制窗口注释转英文(§3.7)。
- `internal/chat/chat.go`:`messageKey` 加 `rotateOnce` 参数 + fallback rotate 加档。
- `frontend/src/types.ts`:`SessionEvent` 加 `rotateOnce?`。
- `frontend/src/lib/streamMerge.ts`:fallback 回搜前消费 `rotateOnce`。
- 测试:新 `internal/acp/resume_rotate_test.go`(3 例:首块打标恰一次/非匹配事件不耗臂标/未武装零行为);`internal/chat/segment_test.go` 加 `TestSegmentFallbackResumeRotate`(rotate 一次后回归粘连 + messageId 路径无视该标);`frontend/src/lib/streamMerge.test.ts` 加 3 例(强制新块不粘 streaming 残留+第二 chunk 回归粘连/对 DB 末条开新块/带 id 主键路径零回归)。

## 验证

- `go build ./...`、`go vet ./...` 干净;`go test ./...` 15/15 包全绿(含新增 4 个 Go 测试)。
- `cd frontend && bun test --isolate`:472 pass / 0 fail(含新增 3 例);`bun run build:dev`(tsc + vite)绿。
- 本 worktree 首次构建需先 `wails3 generate bindings -clean=true -ts -i` + `bun install`(bindings 不入库,既有约定)。
- `go test -race ./internal/acp/` 绿(新增原子臂标无竞争)。**注**:`go test -race ./internal/chat/` 有 4 个 DATA RACE 失败(empty_turn/runPrompt 断连类测试),**已用 `git stash` 在基线 2ea816b 复现,系既有测试侧竞争,与本改动无关**(本改动未引入任何共享状态),不夹带修复。

## 下一步 / OPEN

- **真机 smoke(待用户执行,不阻塞收口)**:重开 junie session 立即发一条,确认回复独立成块、不再粘进 resume 前气泡/穿透重放尾巴。
- 已知残留(超出本任务语义,未动):① 穿透重放尾巴本身仍会开出一个与 DB 末条重复的气泡(cosmetic,方案 C 只保 rotate 不保去重);② resume 后首个无 messageId **thought** chunk 未打标(规格钉死 agent_message_chunk),若 junie 式回复以思考开头且残留 thought 气泡开着,思考块仍可能粘——待真机确认是否需要同款加档。
- reviewer 审后停 completed-ready,不关(硬纪律)。
