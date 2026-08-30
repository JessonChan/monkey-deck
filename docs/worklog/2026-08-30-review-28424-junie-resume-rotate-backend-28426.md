# 2026-08-30 · 复审 #28424 junie resume rotate-once 后端面(Task #28426)——APPROVE

## 结论

**APPROVE**。后端面(打标 `tagResumeRotate` + 消费 `messageKey` rotate 档)全链路通电、并发安全、窗口次序正确;与 #28425(前端面,已 APPROVE)合成方案 C 完整闭环。无 P1/P2。

## 反向实证(逐点从打标追到消费,防「类型补丁」)

1. **打标链路次序正确**(`internal/acp/runner.go` ResumeChatSession):抑制层(窗口内丢历史重放)在 `tagResumeRotate` **之前**——窗口内重放块先被丢弃,tagging 不可见,臂标天然只可能被 RPC 返回后的块消费;元数据(available_commands/config_option)穿抑制层进 `liveOnEvent`,kind 不匹配不耗臂标。RPC 返回后 `handler.OnEvent = liveOnEvent` 保持打标活跃(旧代码同位置恢复 `realOnEvent`,写入位次不变,无新增竞争面;`liveOnEvent` 闭包只捕获 atomic 臂标 + 不可变 `realOnEvent`)。
2. **消费真实读取**(`internal/chat/chat.go:2537`):`messageKey(ls, e.MessageID, role, e.RotateOnce)` 是全仓唯一调用点;rotate 档 `rotateOnce || ls.fallbackRole != role` 强制 `fallbackSeq++` 换 key → `handleEvent` 建新 entry。主键路径 `if messageId != ""` 在 rotate 档**之前**早退,带 id 消息不可能被自己的标劈开(与前端 streamMerge L57 早退镜像)。
3. **wire 不丢字段**:`handleEvent` 尾部 `s.emit(EventUpdate, e)` 原 struct 直发(SessionID/Seq 就地补,`RotateOnce` 原样),JSON `rotateOnce,omitempty` → 前端;popout 与远程 WS 转发路径 #28425 已实证。
4. **dispatch 全覆盖**(`internal/acp/handler.go:791`):每条 SessionUpdate 均经 `h.OnEvent(e)`,`EmitTurnUsage` 合成的 usage_update kind 不匹配、不耗臂标——正确(usage 非消息块)。
5. **liveSession 生命周期核对**:`startLive` 每次(含 ensureLiveNoReset 重连路径)新建 `ls.index` → 后端 rotate 档在实际链路上防御性(worklog 如实声明);双端消费同一带标事件,重连场景下也无分歧可能。
6. **错误路径**:resume 能力缺失/RPC 失败 → `proc.shutdown()` 返回,臂标随闭包消亡,不泄漏;`spawnAndInit` 失败同。窗口外无 session 存在,「Initialize 返回 → 抑制层安装」间隙不可能有 chunk(session 尚未创建)。

## 并发与状态机

- `atomic.Bool` CAS:并发 SessionUpdate 回调(§1.3)下恰好一条带标;`SessionEvent` 值传递,per-callback 副本置位无共享写。`messageKey` 调用方持 `ls.mu`。`go test -race ./internal/acp/` 绿(worklog 声称 `internal/chat` 的 4 个 race 为基线 2ea816b 既有测试侧问题,与本改动无关——本改动未引入共享状态,核实成立)。
- `tool_call` 清 `fallbackRole`(既有硬边界)与 rotate 档正交:rotate 后 `fallbackRole=role`,下一无标 chunk 回归粘连——测试子例 1 锚定(`old | new!` 两段)。

## 测试质量

- 断言锚定值:段数、精确文本(`old`/`new!`/`ab`)、臂标布尔,非「字段存在」式。
- **负向回绑实验(本复审实测)**:临时删 `rotateOnce ||` 档 → `TestSegmentFallbackResumeRotate` 子例 1 **FAIL**,失败信息正是病灶本身(`rotate-once must split into 2 segments, got 1: [{agent oldnew!}]`);还原后绿。测试非纸面,咬得住回归。
- `tagResumeRotate` 3 例覆盖:恰一次消耗/非匹配事件(thought、带 id、metadata)不耗臂标且后续首块仍打标/未武装零行为(NewSession 零感知)。

## gate 复跑(本 worktree 实测)

- 环境修复:worktree 缺 `node_modules` + `frontend/bindings` → `bun install` + `wails3 generate bindings -clean=true -ts -i`(gitignore 生成物,既有约定,与代码无关);`bun run build:dev` 产出 `frontend/dist` 供 go:embed。
- `go build ./...` / `go vet ./...` 干净(linker macOS 版本 warning 为环境固有);`go test ./...` **15/15 包 ok**;新增 5 个 Go 测试(verbose)全 PASS;`go test -race ./internal/acp/` ok。前端 `bun test` 472/0 由 #28425 同 commit 复跑,本面不重复。

## 提交纪律

- 触及文件恰为规格范围(4 后端 + 3 前端 + 3 测试),前端部分系方案 C 跨端设计(后端打标、前端消费),前端面由 #28425 独立复审——非夹带。runner.go 触及的抑制窗口旧中文注释已转英文(§3.7)。无无关改动。

## 残留(已在 #28424 worklog OPEN 声明,不阻塞)

- 穿透重放尾巴自身开出的气泡与 DB 末条重复(cosmetic;junie 场景臂标落在重放首块,重放尾巴独立成块、真回复按既有语义并入——方案 C 边界即如此拍板,父 issue #28423)。
- 首个无 messageId **thought** chunk 未打标(规格钉死 agent_message_chunk);真机 smoke(重开 junie session 立即发一条)待用户执行,不阻塞收口。
