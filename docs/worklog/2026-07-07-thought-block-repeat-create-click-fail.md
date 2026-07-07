# 2026-07-07 thought-block-repeat-create-click-fail

## 现象(用户报告)
主聊天区(对话历史)的思考块 ThoughtBlock:
1. 反复创建多个思考块(实际应只有最新的在 loading)。
2. 点击思考块「点不开」(不展开)。
3. 出现时「整个页面倒着走(向上滚)」,直到走到那个新建的、不存在的(空 body)思考块停下。

## 排查过程(真实 ACP harness 实测)
写了诊断程序(`cmd/thoughtdiag`,临时),spawn 真实 omp,发多步 prompt(思考→读文件→思考→改文件→思考→确认),捕获 445 个原始 `SessionUpdate` 事件,经忠实复刻的 `chat.go handleEvent`(累积文本 + seq 赋值)后导出,再用真实前端 `streamMerge.ts` 逐条 apply。

**实测结论**(omp + opencode):
- `messageId` 在单条 message 内**稳定**(thought 共享一个 messageId,text 共享另一个)。`messageId` 不稳定假设被推翻。
- 单 turn 归并正确:3-4 个 thought + 3-4 个 agent,id 无冲突,streaming 收口正确。
- 所以「反复创建 / 点不开」**不在单 turn 的 streamMerge 归并逻辑**。

## 根因(代码层)
两个独立的设计缺陷,在特定条件下叠加放大:

### 缺陷 1:ThoughtBlock 的 open 状态按 session 共享(`ChatView.tsx:342`)
```ts
const storageKey = `md:thought-open:${sessionId}`;  // 按 session,不按 thought!
const [open, setOpen] = useState(() => localStorage.getItem(storageKey) === "true");
```
同一 session 内所有 ThoughtBlock 共享一个 localStorage 键。当 thought 因任何原因(见缺陷2)重挂载时,新实例从共享键读 open,**覆盖用户当前点击** → 「点不开」。重挂载时 `everOpenedRef` 重置 → body 不渲染 → 「不存在的空思考块」。

### 缺陷 2:thought/agent 的 id 生成在边缘情况下不稳(`streamMerge.ts:76/89`)
```ts
id: `${type[0]}-${ev.seq ?? Date.now()}`
```
- 有 messageId 时:`findIndex` 命中则 id 不变(稳定);不命中(新 messageId)则 id 随 seq 变。
- 无 messageId(回退):同类连续归并(id 稳定);但若 thought 被中间 agent 打断后又有同类 thought,新建时 id 随 seq 变。
- id 变化 → React `Fragment key={item.id}` 变化 → ThoughtBlock 卸载重挂载 → CSS spinner 从 0 开始 + open 状态重置。

### 「页面倒着走」
`ChatView.tsx` 的 `useLayoutEffect`(line 112-148)依赖 `[items]`。ThoughtBlock 反复重挂载 → DOM 高度抖动(旧移除高度减,新加入高度增)→ layoutEffect 的 scrollTop 补偿在抖动期间反复调整 → 视觉上「倒着走」。走到那个空 ThoughtBlock 停下,是高度稳定后补偿停止。

## 改法

### `frontend/src/lib/streamMerge.ts`
1. **id 基于 messageId(优先)**:有 messageId 时 `id = ${type[0]}-${messageId}`,让同 messageId 的 thought 永远 id 一致(React key 稳定),即使 findIndex 首次未命中。无 messageId 回退用 seq/Date.now()。
2. **回退路径(无 messageId)按「最后同类型」归并**:从末尾向回查找同类型 streaming item,而非只看 last(可能是异类型)。让同类连续归并更鲁棒。

### `frontend/src/components/ChatView.tsx`
3. **ThoughtBlock open 状态 per-item**:去掉按 session 共享的 localStorage 键,`open` 默认折叠,用户点击只影响该 thought。彻底消除「重挂载覆盖点击 / 点不开」。代价:放弃「session 级展开偏好」(展开一个后续默认展开)——该偏好正是 bug 根源,且非核心体验。

### `frontend/src/lib/streamMerge.test.ts`
4. 新增 2 个回归:
   - thought id 基于 messageId(同 messageId 归并后 id 稳定)。
   - 无 messageId 回退同类连续归并。

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| `frontend/src/lib/streamMerge.ts` | id 生成优先用 messageId;回退路径按最后同类型归并 |
| `frontend/src/components/ChatView.tsx` | ThoughtBlock open 改 per-item useState(去掉 session 共享 localStorage) |
| `frontend/src/lib/streamMerge.test.ts` | +2 回归(id 稳定、回退同类归并) |

Go 零改动——无需 `wails3 gen bindings`。

## 验证
- `bun test src/lib/streamMerge.test.ts` → 14/14 pass。
- 真实 omp 445 事件经修复后 streamMerge:4 thought + 4 agent,id 基于 messageId(`t-<uuid>`),无冲突,streaming 收口正确。
- 回退路径(无 messageId)同类连续归并成单 item(原:同类连续也归并,但修复让「向回查找」更鲁棒)。

## 权衡 / OPEN
- 放弃 session 级展开偏好:用户需逐个展开思考块。如需恢复偏好,应用 ref/context 跟踪「该 session 展开过」,新 thought 用偏好做默认值——但 toggle 不写共享 localStorage(避免重挂载覆盖)。非本次范围。
- 真机回归未做(需 GUI):诊断程序证实 omp/opencode 单 turn messageId 稳定 + 归并正确,但用户报告的 bug 可能在特定多轮/重挂载场景;本修复从「id 稳定 + open per-item」两处鲁棒化,覆盖最可能的根因。若仍复现,需 devtools 的 items 数组快照。
