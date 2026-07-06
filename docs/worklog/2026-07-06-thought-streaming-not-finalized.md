# 2026-07-06 thought-streaming-not-finalized

## 现象
主聊天区(对话历史,非侧栏)的 ThoughtBlock 思考块:
1. agent 的思考明明已结束、开始回复正文,但思考块的「思考中」转圈(spinner)一直不停,直到整轮回复(turn)结束才停。
2. 多步 turn(思考→工具→再思考→回复)里多个思考块都卡在 loading,视觉上像「不断新建非常多 ThoughtBlock」且都在转圈。

## 根因(纯前端,`frontend/src/lib/streamMerge.ts:66-72`)
段边界 finalize 逻辑有一个错误假设:「同 messageId 的 thought+text 共存,thought 保持 streaming(后续可能有更多 chunk)」。

原代码(line 70):
```ts
if (prev && (prev.type === "agent" || prev.type === "thought") && prev.streaming
    && prev.messageId !== ev.messageId) {  // ← 同 messageId 不 finalize
  next[next.length - 1] = { ...prev, streaming: false };
}
```
`prev.messageId !== ev.messageId` 把同 messageId 的情况排除了,导致 thought 的 streaming 永不收口,直到整轮 idle 被 `App.tsx:218-231` 的全局 finalize 清掉。

### 错误假设与协议实测
- **假设**:同 messageId 的 thought 与 text 可能交错到达,故不能在 text 开始时收口 thought。
- **实际**(ACP 协议 + opencode/omp 实测):
  - opencode(`references/opencode/.../acp/event.ts:154-199`):一条 message 的 reasoning part delta 全部先于 text part delta,`handlePartDelta` 按 partType 分发;thought 与 text 共享 `props.messageID`。
  - omp(`references/oh-my-pi/.../acp-agent.ts:1239-1263`):`#getLiveMessageId` 在 message_start 生成、message_end 清空,同一 message 生命周期内 `liveMessageId` 稳定;thought_delta 与 text_delta 共享它。
  - 即 reasoning 是 LLM 的思考阶段,text 是回复阶段,**顺序输出、非交错**。text 一旦开始,reasoning 必然结束。

### 两个现象同源
现象1 是直接根因(thought 不收口)。现象2「不断新建非常多」是多步 turn 里每个 thought 都卡在 streaming 不收口——每个思考块都一直转圈,视觉上像一堆 loading 块堆积。修复 thought 收口时机后两者同时解决。

### 之前的固化
`streamMerge.test.ts:136-145` 的测试「同 messageId 的 thought+agent 都保持 streaming」断言 `thoughts[0].streaming === true`,把这个错误行为固化成回归保护。随修复一并改正。

## 改法
`streamMerge.ts:66-74`:新建气泡时,无条件 finalize 上一个 streaming 的 agent/thought(去掉 `prev.messageId !== ev.messageId` 条件)。

不变量保证:
- 不合并气泡:`findIndex`(line 58)已按 `messageId + type` 区分,thought 与 text 仍各自独立气泡。
- 不同 messageId 的 thought 仍各自独立(新 messageId → findIndex 不命中 → 新建,且 finalize 上一个)。
- 乱序 seq 守卫(line 61)不变。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| `frontend/src/lib/streamMerge.ts` | line 66-74:去掉 `prev.messageId !== ev.messageId` 条件 + 注释改写,说明 reasoning 先于 text 的协议不变量 |
| `frontend/src/lib/streamMerge.test.ts` | line 136-152:把「同 messageId thought 保持 streaming」改为「同 messageId thought 在 text 开始时收口 streaming」+ 加文本/agent 数量断言 |

Go 零改动——无需 `wails3 gen bindings`。

## 验证
- `bun test src/lib/streamMerge.test.ts` → 12/12 pass。
- eval 复现修复前:thought→text(同 messageId M)→ thought.streaming=true(bug)。
- eval 复现修复后:
  - thought→text(同 M):thought streaming=false ✓,agent streaming=true ✓,thought 文本保留 ✓。
  - 多步 turn(thought/text × 3,各自 messageId):3 个 thought 全部 streaming=false ✓,仅最后 agent streaming=true ✓。
  - 不同 messageId thought:各自独立,mA finalize + mB streaming ✓。
  - thought→tool→thought(无 messageId 回退):各自独立 ✓。
- `tsc --noEmit` 的 16 个 `bindings/...` 找不到模块错误是**预存环境问题**(stash 前后均 16 个,bindings 未 `wails3 gen bindings`),与本次改动无关。

## 权衡 / OPEN
- 未做实机验证:需 `wails3 dev` + 真实 harness 跑含思考的 turn。复现:① 发消息让 agent 思考并回复;② 观察思考块在正文开始时 spinner 立即停(修复前一直转到回复结束)。
- ACP 协议未明文规定 reasoning/text delta 顺序;本修复依赖 opencode/omp 的实测行为(均顺序输出)。若未来有 harness 真交错发 reasoning/text 同 messageId,thought 会在首个 text 到达时过早收口——但这是协议未定义的边缘,且当前两 harness 均不如此。
