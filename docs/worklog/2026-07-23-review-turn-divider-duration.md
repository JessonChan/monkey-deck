# 2026-07-23 review:TurnDivider 显示本轮持续时间 端到端验收(Task #22113 / Review #45)

## 起因
Review #45(被审 Task #22112 `feat(chat): TurnDivider 显示本轮持续时间`,commit `73085ac` +
worklog `2026-07-23-turn-divider-duration.md`)。Reviewer 职责:不只是「编过 + 测过」,要证明
**行为真的实现了**(防「改签名不改函数体、build 绿但 bug 在」)。本次为「端到端验收」——用真 React
树挂载真 `ChatView`,断言 `.turn-divider-dur` 真的渲染出本轮耗时。

## 验证做了什么
1. **环境对齐**:`bun install` + `make bindings`(bindings 不入库,启动生成)+ `bun run build`
   (`tsc && vite build`)+ `go build ./...` + `go vet ./...`:全绿(go 仅 macOS linker 版本 warning,
   无关;vite 仅 chunk>500kB 旧 warning)。
2. **设计前提核对**(读后端源码,非盲信 worklog):
   - `internal/store/messages.go` `AppendMessage`:`CreatedAt: now()` —— 落库时刻即写入时刻。✓
   - `internal/chat/chat.go` `persistTurn`(1688):按 `timeline` 真实时序逐条写库,故回合最后一条
     message 的 `createdAt` ≈ 回合结束时刻。✓
   - `App.tsx` `messagesToItems`(444):所有 item 类型都把 `m.createdAt` 映射成 `ts`。✓
   - 结论:前端「turn end = 该回合最后一条 item 的 `ts`」成立(§5.3 尊重数据源,无新增字段)。
3. **逻辑审查**(`ChatView.tsx` 180-193 / 500-509 / 1505-1518):
   - `turnBounds` 以 user 消息在 items 里的**索引**为 key(`m.set(start, …)`);渲染 `turnBounds.get(row.first)`
     用同一索引空间 —— 一致,无错位。
   - 语义(实现 = 设计一致):**每条 user 前的分隔线标注「该 user 开启的这轮」** 的开始时刻 + 持续时间
     (Option A)。故 user2 前的分隔线显示 turn2(user2→agent3)耗时,turn1(user0→agent1)因首条无
     divider 而不显示(与改动前「首条 user 无分隔线」一致,零回归)。
   - `formatDuration`:<1s→空 / <60s→`Ns` / <60m→`Mm SSs`(整分省略秒)/ ≥60m→`Hh MMm`;复用既有 `pad2`。✓
   - 进行中回合(`status==="prompting"` 且为最后一回合)`complete=false` → 无 end → 不显示时长;分隔线
     本身(时间戳)仍在。✓
4. **端到端验收测试**(新增 `frontend/src/components/TurnDivider.duration.mount.test.tsx`,复用
   `ChatView.virtual.mount.test.tsx` 的 happy-dom + binding/i18n/RO mock 套路,挂载真 `ChatView`):
   - 多轮(idle):user2 前分隔线渲染 turn2 耗时 `1m 23s`(83s),`.turn-divider-time` 文本含 ` · 1m 23s`。✓
   - prompting 最后一回合:0 个 `.turn-divider-dur`(零回归),但 `.turn-divider` 仍在。✓
   - prompting→idle:0→1,duration 出现,值 `1m 23s`。✓
   - `formatDuration` 边界:<1s 不渲染 / 90s→`1m 30s` / 3661s→`1h 01m`。✓

## 验收结论
**PASS**。实现与 DoD(「回合分隔线追加显示本轮 agent 耗时,如 `14:30 · 1m 23s`」)一致,行为真实生效,
无回归。新增 4 个端到端 mount 测试作为回归守卫(全量 `bun test`:87 pass / 0 fail,含原有 83)。

## 观察(非阻塞,记录供后续判断)
- **Option A vs B(产品取舍,非 bug)**:当前 Option A——divider 标注它所衔接的那一轮(turn2 的耗时
  显示在 user2 前)。后果:**第一轮(user0)的耗时永不显示**(首条无 divider,与首条不显示开始时刻一致)。
  备选 Option B——divider 显示「上一轮」的耗时(user2 前显示 turn1 耗时),则每个已结束回合的耗时都
  会在下一轮的 divider 上出现,且发新消息时上一轮刚结束、耗时立即可见,体感更「即时」。两者皆自洽;
  coder 选 A 且与 DoD 示例吻合,不判为问题。若日后产品反馈「想看每一轮耗时」,可考虑切 B(改动小:
  渲染处把 `turnBounds.get(row.first)` 换成上一 user 的 bounds)。
- **实时流式边界**(worklog 已述):刚结束的最后一回合 items 仍在内存(未重载)时,tool item 的 ts
  缺失 / agent item 的 ts 为流式开始时刻 → 时长为下界估计;重开会话从 DB 重载后精确。日常不影响
  (分隔线主要看历史回合)。已记录,不另开 OPEN。

## 改了哪些文件
- `frontend/src/components/TurnDivider.duration.mount.test.tsx`(新增):TurnDivider 持续时间端到端
  验收 mount 测试(4 用例)。

## 下一步
- (可选)桌面 app 实测多轮对话确认 WebKit 渲染;切 Option B 的产品判断 deferred。
