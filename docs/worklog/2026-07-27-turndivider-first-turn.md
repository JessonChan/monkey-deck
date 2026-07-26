# 2026-07-27 TurnDivider 首轮也显示

## 起因

Task #23419。`ChatView.tsx:552` 的 TurnDivider 渲染条件是 `userItem && row.first > 0`,
导致**首轮对话(user0 前)没有分隔线** —— 多轮边界清晰,但首轮缺一条发丝线 + 开始时间锚点,
视觉上首条 user 消息直接贴在 head 区下,缺少「这是一轮开始」的视觉提示。

## 改法

`row.first` 是数组下标恒 `>= 0`,`> 0` 即「跳过首条」。改为 `>= 0`(等价去条件,但保留
`>= 0` 让意图自注释:每条 user 前(含首轮)都插分隔线)。

```diff
-                  {/* 回合分隔:每条用户消息(首条除外)前插一条带时间的分隔线,让多轮对话边界清晰。 */}
-                  {userItem && row.first > 0 && <TurnDivider ts={userItem.ts} durationMs={durationMs} />}
+                  {/* 回合分隔:每条用户消息前插一条带时间的分隔线(首轮亦显示),让每轮对话边界清晰。 */}
+                  {userItem && row.first >= 0 && <TurnDivider ts={userItem.ts} durationMs={durationMs} />}
```

语义不变:`turnBounds`(ChatView.tsx:200)本就为每条 user(含首条 user0)算出
`{start, end}`,首轮 end = 该回合最后一条消息 ts(非末回合必完整),故首轮分隔线自然
显示 turn1(user0→agent1)的开始时刻 + 持续时间。进行中(prompting)的末回合仍无 end、
不显示时长(零回归)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:L552 条件 `> 0` → `>= 0`,注释同步。
- `frontend/src/components/TurnDivider.duration.mount.test.tsx`:4 个用例的断言从
  「仅 user2 前有 divider」改为「两条 user 前均有 divider」,并校验首轮 turn1 时长。
  头部语义注释同步更新。
- `docs/worklog/2026-07-27-turndivider-first-turn.md`:本条。

## 验证

- `bun install`(worktree 无 node_modules)。
- `wails3 generate bindings`(补齐前端 bindings,否则 tsc 报 TS2307,与本次改动无关)。
- `npm run build`(`tsc && vite build --mode production`):**通过**。
- `npm test -- TurnDivider`:**4/4 通过**。
- `npm test -- ChatView`:**10/10 通过**。
- `npm test`(全量):123 pass / 7 fail —— 7 fail 全在 `HarnessUpdateAwareness.mount.test.tsx`
  (HarnessPane data-testid 找不到),**与本次改动无关的既有失败**。

## 下一步

- 实机抽验(`wails3 dev`,macOS WebKit):首轮 user 消息上方出现发丝线 + 开始时间 +
  (回合结束后)本轮时长,与多轮形态一致。
