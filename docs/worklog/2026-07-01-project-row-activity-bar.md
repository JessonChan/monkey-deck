# 项目行活跃信号(左竖条)

**日期**:2026-07-01
**类型**:feat(UI)

## 起因

项目折叠时,对其下「有活跃/未读 session」**完全无任何提示**。session 行的 `unread-dot` / `tail-spinner` / `perm-dot` 只在 `isOpen` 展开后渲染(Sidebar.tsx),折叠态用户必须逐个展开才知道哪个项目有动静 —— 真实 UX 缺口。

## 设计决策(克制方案,非原提案的底部流光)

与用户讨论后,**否决了原提案的「慢速底部流光」**,改为更克制的「左边缘竖条」,理由:

1. **运动 vs 颜色**:侧栏是常驻元素,永不停止的横向流光会在余光里持续「叫」用户(外周视觉对运动敏感是视觉皮层机制,非审美问题);多个项目同时活跃 = 多条流光 = 噪音放大。竖条静态时不抢余光,扫视时一眼可见。
2. **running vs unread 分开**:
   - `running`(agent 在跑,瞬时):允许**很慢的透明度呼吸**(2.5s 周期),比横向移动克制。
   - `unread`(回合结束没看,可能积攒/停留很久):**纯静态**,这种用动效是反模式 —— 它不需要「叫」你,只需「在」你扫过去时被发现。
3. **仅折叠态加,展开态不加**:展开时 session 行已有 dot/spinner,项目行再叠 = 重复信号 + 视觉噪音。
4. 左竖条是成熟 UI 常见手法(VS Code/Slack/Discord),有肌肉记忆。

## 改法

数据来源已有,无需新逻辑:每个 session 的 `status==="prompting"`(running)与 `unreadBySession[s.id]`(unread)都是 Sidebar 的 props。项目级只 `.some()` 聚合。

- **Sidebar.tsx** (项目行 map 内):计算 `projRunning` / `projUnread`,折叠时(`!isOpen`)给 `.project-item` 加 `has-running` / `has-unread` class(running 优先)。
- **index.css**:`.project-item.has-unread::before` / `.has-running::before` = `position:absolute; left:0; top:4px; bottom:4px; width:3px; background:var(--accent)`;`.has-running` 叠加 `@keyframes proj-bar-breathe`(opacity 1↔0.35,2.5s)。`pointer-events:none` 不挡点击。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx`(项目行 map,+6 行)
- `frontend/src/index.css`(+11 行 CSS)

## 验证

- `bunx tsc --noEmit` 干净通过。
- (未做实机视觉验证 —— 纯 CSS 渲染,逻辑为布尔聚合,风险极低;留待下次 `wails3 dev` 顺带确认。)

## 下一步

可选:展开态是否也要个极弱信号(目前按「session 行已够」不加)?观察实机使用后再定。
