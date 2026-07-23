# 2026-07-23 enqueueTip i18n 去 auto-start 残留文案(Task #22146)

## 起因
Task #22140(`36f5857`)已把 `enqueueMessage` 改为「只停车、不 auto-start」:无论 idle/prompting 都只把消息压入 session 队列,移除了 idle 时立即 `drainSession` / prompting 时 `armScheduleTimer` 两条主动触发分支,续发时机统一交给 `chat:status` handler 内 turn 结束的 idle 事件。

但 `composer.enqueueTip`(入队列按钮 tooltip,全态显示)的文案还停留在旧行为:`"...auto-sent after current turn, or starts now if idle"` —— `or starts now if idle` 是已删除的 auto-start 行为的残留,与现行实现对不上,会误导用户(idle 态点入队列并不会立即发)。

本任务:修 `enqueueTip`(en+zh)去掉 auto-start 残留文案,顺带核对 `queueSendTip` / `placeholderQueued` 是否同样过时。

## 核对结论:queueSendTip / placeholderQueued 无需改
两个 key 都只在 `prompting` 态显示(`Composer.tsx:531` `placeholder={prompting ? placeholderQueued : placeholderNormal}`、`Composer.tsx:649` `title={prompting ? queueSendTip : sendTip}`)。prompting 态下「本轮结束后自动续发」依然成立(turn 结束的 idle 事件触发 `drainSession`),文案 `"auto-sent after this turn"` / `"本轮结束后自动发"` 准确。✓ 不动。

## 改法
只动 `enqueueTip`,去掉 `or starts now if idle` / `空闲则立即开始`,保留 `always queues` + `auto-sent after current turn`(prompting 态主场景的续发说明,idle 态用户从 QueuePanel 看到入队项自明)。

| key | 改前 | 改后 |
|---|---|---|
| `enqueueTip` (en) | `Enqueue · ⌘⇧Enter (always queues; auto-sent after current turn, or starts now if idle)` | `Enqueue · ⌘⇧Enter (always queues; auto-sent after current turn)` |
| `enqueueTip` (zh) | `入队列 · ⌘⇧Enter(始终入队;本轮结束后自动发,空闲则立即开始)` | `入队列 · ⌘⇧Enter(始终入队;本轮结束后自动发)` |

## 改了哪些文件
| 文件 | 改动 |
|---|---|
| `frontend/src/i18n/locales/en.json` | `composer.enqueueTip` 去 auto-start 残留。 |
| `frontend/src/i18n/locales/zh.json` | 同上。 |

## 验证
- `node -e JSON.parse(...)`:两份 JSON 合法。
- `bun install` + `wails3 generate bindings`(环境补齐,bindings gitignore 不入库)+ `bun run build`:exit 0(仅既有 chunk 体积告警)。
- `bun test`:107 pass / 0 fail。
- 逻辑核对:enqueue 现行为「只入队不主动发」,新文案不再承诺 idle 立即开始 ✓;`queueSendTip`/`placeholderQueued` 在 prompting 态文案准确,不动 ✓。

## OPEN / 备注
- `enqueueTip` 仍通过原生 `title` 属性挂载(`Composer.tsx:640`),与 §4.5「统一 hover tooltip 用 react-tooltip、禁用原生 title」相悖 —— 属既有 Composer tooltip 统一迁移范围(`sendTip`/`stopTip` 等同),不在本任务(纯文案修复)范围内,留待统一迁移。
