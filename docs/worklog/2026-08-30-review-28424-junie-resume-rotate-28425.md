# 2026-08-30 · 复审 #28424 junie resume rotate-once 前端面(Task #28425)——APPROVE

## 结论

**APPROVE**。方案 C(后端打标、前端消费、只 rotate 一次)的 `rotateOnce` 字段全链路通电,消费端真实读取;硬性测试三条全数落地且断言锚定值;gate 与 worklog 声称逐字一致。无 P1/P2。

## 反向实证(逐点从字段定义追到输出,防「类型补丁」)

1. **定义→wire 对齐**:`internal/acp/handler.go` `RotateOnce bool`(json `rotateOnce,omitempty`)↔ `frontend/src/types.ts` `rotateOnce?: boolean`(手维护镜像,optional 匹配 omitempty 的缺省)。非 binding 类型,无需 wails3 gen(实证:gen 前后 bindings 产物不含该字段,事件载荷走 `app.Event.Emit` 运行时序列化)。
2. **wire 无丢字段点**:`flattenUpdate` 产出 → runner `liveOnEvent` 打标 → `handleEvent`(chat.go)尾部 `s.emit(EventUpdate, e)` **原 struct 直发**,无中途重建;popout(window.go)与远程 WS(`internal/remote/server.go` hub `s.hub.broadcast(ev)` 原样转发 CustomEvent)三张脸均送达。
3. **前端消费真实读取**:`App.tsx applyEvent` L407 把 `ev` 原样传入 `applyEventToItems`;`streamMerge.ts` L88-93 `if (!ev.rotateOnce)` 跳过同类型回搜 → `lastSameType=-1` → else 分支 `finalizeLast()`(收掉残留气泡的 streaming spinner)+ 新开气泡。reachable 性由测试 1 实证(新气泡真出现)。第二个无标 chunk 回落既有粘连(替换语义与后端累积全文一致,`bubbles[1].text==="real reply"` 锚定)。
4. **主键路径零回归**:`streamMerge.ts` L57 `if (ev.messageId)` 在 fallback 块之前 return,rotateOnce 不可达;后端 `messageKey` 同样早退。测试 3(messageId+rotateOnce 归并为一气泡)双端锁定。
5. **边界核对**:rotate 时末项为 tool → `finalizeLast` 对 tool no-op、新气泡照开,更早的 streaming 气泡已被穿透重放 tool_call 自己的 `finalizeLast` 收口,无 spinner 残留路径;DB 末条(非 streaming)场景测试 2 锁定。

## 测试质量

- 断言锚定值:气泡数量、精确文本、streaming 布尔——非「字段存在」式断言。
- **负向回绑实验**:把 `if (!ev.rotateOnce)` 临时改为 `if (true)` → streamMerge.test.ts 1 fail(rotate 测试咬住);还原后全绿。测试非纸面。

## 硬性测试对照(父 issue)

1. resume 标记后首个无 messageId agent chunk → 新块;第二个 → 回归粘连:✅ streamMerge.test.ts 例 1 + chat segment_test `TestSegmentFallbackResumeRotate` 子例 1。
2. 有 messageId harness 零回归:✅ streamMerge 例 3 + segment_test 子例 2(主键路径显式无视该标)。
3. 重放抑制窗口不回退:✅ runner.go 抑制 switch 原样保留(pass-through 由 `realOnEvent(e)` 换 `liveOnEvent(e)`、RPC 返回后 `handler.OnEvent = liveOnEvent`,窗口内重放块先丢弃、tagging 不可见);`go test ./internal/acp/` 既有用例全绿。

## gate 复跑(本 worktree 实测)

- 复跑前修复环境:worktree 缺 `node_modules` + `frontend/bindings` 生成物陈旧(缺 chatservice)→ `bun install` + `wails3 generate bindings -clean=true -ts -i`(均 gitignore,既有约定,与代码无关)。
- `go build` / `go vet` 干净(linker macOS 版本 warning 为环境固有);`go test ./...` 15/15 包 ok。
- `bun test --isolate`:472 pass / 0 fail(与 worklog 声称一致);`bun run build:dev`(tsc + vite)绿。

## 提交纪律

- `2c87988`(代码)+ `829d020`(worklog)原子分开;触及文件恰为规格范围(acp 打标 + chat 消费 + 前端消费 + 三处测试),无夹带。新注释英文,触及的旧中文注释已转英文(runner.go 抑制窗口段)。基于 main=2ea816b。

## 残留(已在 #28424 worklog OPEN 声明,不阻塞)

- 穿透重放尾巴自身仍会开一个与 DB 末条重复的气泡(cosmetic,方案 C 只保 rotate 不保去重)。
- 首个无 messageId **thought** chunk 未打标(规格钉死 agent_message_chunk);真机 smoke(重开 junie session 发一条)由用户执行,不阻塞收口。
