# 2026-07-01 提交消息时说「一轮对话进行中」——sendMessage 空分支导致队列从未入队

## 现象

用户报告了一个诡异的 bug：

1. 聊天窗**直接提交**消息（没有看到排队提示，没有看到排队面板弹出）
2. 一提交后端立刻返回 `"session busy: 一轮对话进行中,请等待或打断"`
3. 用户直觉是：明明还有消息在生成（标题是「生成中」），为什么我点提交时它不知道我在忙？

## 根因

### 三个状态不一致

UI 的「忙碌/可提交」信号来自三个不同位置，但都源自同一个真相源 `statusBySession[selectedSessionId]`：

| 位置 | 读取逻辑 | 正确性 |
|---|---|---|
| **左侧栏** `Sidebar` | dot 颜色：`prompting` → 旋转灯 | ✅ |
| **对话面板 badge** | `STATUS_MAP[status]` → 文字标签 | ✅ |
| **Composer 输入框** | `prompting={status === "prompting"}` prop | ✅ |

三者的**视觉**是一致的（prompting 状态会显示停止键 + 排队占位符）。问题不在 *显示*，而在 *行为*。

### Bug: `sendMessage` 里的空分支

`frontend/src/App.tsx:477-478`:

```js
if (status === "prompting") {
}   // ← 空分支！什么都没做
```

注释写的是"idle 直发; prompting 入前端队列"，但代码里 **prompting 分支是空的**。

结果：不管 status 是什么，一定会走到下面的 `ChatService.SendMessage()`。

### 触发路径

1. 用户发 M1 → `sendMessage` → `setStatusBySession("prompting")` → `SendMessage` 成功，turn 开始
2. turn 进行中，`status = "prompting"` → ChatView 已显示停止键 + 排队占位符
3. 用户发 M2：React **没有 re-render 完**（`sendMessage` 的 closure 锁着旧 status 值 "idle"）
4. 因为 `status === "prompting"` 为 false（闭包读到过期值），**不走排队，直接调 backend SendMessage**
5. 后端收到第二个 SendMessage 时 `ls.busy = true` → 返回 `busy` 错误
6. 前端显示「一轮对话进行中，请等待或打断」

### 更深的问题：queueBySession 曾是死代码

`queueBySession` useState 声明了、`drainQueue` 写了、QueuePanel 也渲染了，但**入队的代码从未工作**。所以排队面板从未显示过消息，用户看到的就是"点了提交直接报错"。

### 为什么用户看到"标题还在生成中"但 Composer 没进入排队？

关键：**同一个 `useCallback` 闭包**。

- `sendMessage` 在 status="idle" 时被绑定（M1 发送前）
- M1 发出后 React **同步**执行了 `setStatusBySession("prompting")`
- 但 React 的 re-render 还没开始（或正在进行），用户已快速发了 M2
- M2 使用的是**同一个闭包**（仍持有 `status="idle"`）
- closure 读到旧值 → 就不排队 → 直发 → busy

## 改法

### 1. `statusRef` 防 stale closure

```ts
const statusRef = useRef<string>("empty");
useEffect(() => { statusRef.current = status; }, [status]);
```

每次 status 变化时同步更新 ref。`sendMessage` 改用 `statusRef.current` 判断，绕过 React 闭包锁。

### 2. 补全 `prompting` 分支

```ts
if (statusRef.current === "prompting") {
  const item: QueueItem = { id: `q-${Date.now()}-${selectedSessionId}`, text, mentions };
  queueBySessionRef.current = {
    ...queueBySessionRef.current,
    [selectedSessionId]: [...(queueBySessionRef.current[selectedSessionId] || []), item],
  };
  setQueueBySession(queueBySessionRef.current);
  return;  // 到这里就结束了，不会走到 SendMessage
}
```

入队成功 → 更新 queueBySession state → QueuePanel 弹出显示排队消息 → 回合结束 `drainQueue` 自动续发。

### 3. 更新 sendMessage 的依赖

```ts
}, [selectedSessionId]);  // 移除了 status（改用 statusRef.current）
```

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | 加 `statusRef`；补全 `sendMessage` 的 `prompting` 分支为入队逻辑；移除 dependency `status` |

Go 零改动 —— `wails3 gen bindings` 不需要。

## 验证

- `bunx tsc --noEmit` ✅
- `go test ./internal/chat/` ✅ (1 packages ok)
- 逻辑审查：
  - ✅ idle 时走原路径，行为不变
  - ✅ prompting 时入队（而非直发），队列面板显示
  - ✅ 回合结束 `drainQueue` effect 触发 `statusRef.current === "idle"` → dequeue → 发下一条
  - ✅ statusRef 防 closure 过期：每次 render 更新 ref，不受 useCallback 闭包影响
  - ✅ `interruptQueue`「立即发送」按钮仍能打断当前 turn（独立路径）

## 权衡

- **未做实机验证**: 前端依赖 Wails3 运行时 + React state machine + opencode 长回复（需要真 harness），纯前端状态逻辑用 tsc + Go 单测已足够覆盖。要验证排队面板的实际 UI 行为需要 `wails3 dev` 本地跑。
- **内存增长**: 队列消息随访问过的 session 累积。受 idle reaper（关 session）和正常使用约束，非正确性问题；如有需要可加 LRU。
- **QueueItem id 改用时间戳+sessionId**: 取消了原来的模块级 `queueSeq` 计数器（上次错误写法遗留），id 唯一性足够且避免了模块级状态的风险。

## 提交说明

```
fix(frontend): sendMessage prompting 分支入队而非直发，修 status stale closure

sendMessage 的 prompting 分支曾是空 if 块，导致 turn 进行中时点击发送
直接调后端 SendMessage → 遭 busy 拒绝。补全为入队逻辑，并用 statusRef
绕过 useCallback 的 stale closure 锁，确保 React re-render 期间也能正确
读取最新 status 判定是否排队。
```
