# 2026-07-27 user msg-meta 显示历时,删除 TurnDivider

## 起因

Task #23426。回合时间锚点(开始时刻 + 本轮持续时间)此前由 `TurnDivider` 承担
(ChatView.tsx 每条 user 消息前的发丝线 + 时间 + 历时)。元信息散落在独立分隔线里,
与消息本体分离;而 agent 消息早有底部 `msg-meta`(时间 + 复制),user 消息却无 msg-meta。
统一收敛:把历时 / 时间挪进消息底部的 msg-meta,删除 TurnDivider。

## 改法

1. **user 消息底部新增 msg-meta**(ChatView.tsx ChatRow user 分支):`发送时刻 · 格式化历时 + 复制`。
   - 历时 = `formatDuration(durationMs)`,沿用原 TurnDivider 的格式化函数(<1s 空、<60s `Ns`、<60m `Mm SSs`、≥60m `Hh MMm`)。
   - 复制按钮从「气泡上方 user-msg-actions」移到底部 msg-actions(与 agent 一致)。
2. **turn duration 传入 ChatRow**:`ChatRow` 新增 `durationMs?: number` prop;渲染循环
   (L545-552)对 user 行算出 `durationMs` 后传入,非 user 行传 undefined。
3. **删除 TurnDivider 组件**及其 CSS(`.turn-divider` / `-line` / `-time` / `-dur`)。
   原内容(时间 + 历时)已被 user msg-meta 完整吸收,发丝线分隔无信息量故删去。
4. hover 复制按钮统一:`.row-user:hover .msg-actions`(原 `.row-user:hover .user-msg-actions` 随类名删除)。

语义不变:`turnBounds`(ChatView.tsx:200)仍按 user 消息下标算 `{start, end}`;
进行中(prompting)的末回合无 end、不显示历时(零回归)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - ChatRow user 分支:新增 msg-meta(时间 + 历时 + 复制),移除上方 user-msg-actions。
  - ChatRow 签名:新增 `durationMs?: number`。
  - 渲染循环:删 TurnDivider,`durationMs` 传入 ChatRow。
  - 删除 `TurnDivider` 组件函数;`turnBounds` 注释同步。
- `frontend/src/index.css`:删 `.turn-divider*` 四条 + `.user-msg-actions`;hover 规则改
  `.row-user:hover .msg-actions`;新增 `.msg-dur { opacity: 0.7; }`。
- `frontend/src/components/TurnDivider.duration.mount.test.tsx` → `msgmeta.duration.mount.test.tsx`:
  断言选择器从 `.turn-divider-dur` 改为 `[data-testid='msg-user'] .msg-dur`,4 用例全更新。
- `docs/worklog/2026-07-27-msgmeta-duration-delete-turndivider.md`:本条。

## 验证

- `bun install`(worktree 无 node_modules)。
- `wails3 generate bindings`(补齐前端 bindings,否则 tsc 报 TS2307,与本次改动无关)。
- `npm run build`(`tsc && vite build --mode production`):**通过**(仅既有 chunk size 警告)。
- `bun test src/components/msgmeta.duration.mount.test.tsx`:**4/4 通过**。
- `bun test`(全量):127 pass / 7 fail —— 7 fail 全在 `HarnessUpdateAwareness.mount.test.tsx`
  (`ChatService.GetConfig is not a function`),**与本次改动无关的既有失败**。

## 下一步

- 实机抽验(`wails3 dev`,macOS WebKit):user 消息底部出现 `时间 · 历时 + 复制`,
  回合结束后历时出现,prompting 中无历时;TurnDivider 不再出现。
