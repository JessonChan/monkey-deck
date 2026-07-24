# 打开 session 不在最底部:programmaticScrollRef 防止 stick 误翻

## 起因

用户反复报告:打开任意 session 视图不在最底部,停在半中腰。此前已修 stick-flip(贴底判定读 scrollHeight)、FAB 残留、动态类型先验,问题依旧。用户要求用更成熟的方案。

## 真机诊断(§5.5 server 模式 + 浏览器)

用 server 模式在真实 Chromium 里打开 mermaid session(17 条消息),polling 滚动几何:
- 首帧(ms=0):contentH=1275px(先验估算),scrollTop=446(=先验 total - clientHeight)
- 100ms 后 RO 收敛:contentH 跳到 3712px(真实),maxScroll=3204
- **scrollTop 永远卡在 446,3 秒不动**

根因链条:
1. `applyInitialPosition` 用先验 total 算 scrollTop(偏小)→ 写入 → 触发 scroll 事件
2. RO 收敛真实高度 → `.chat-content` height 变大 → `scrollHeight` 变大
3. `applyInitialPosition` 的 scroll 事件 rAF 在 RO 收敛 **之后** 才执行
4. rAF 读到「大 scrollHeight + 小 scrollTop」→ gap > 80 → stick 误翻 false
5. stick=false → RO/main effect 的贴底补底(S 不变量)全被跳过 → scrollTop 永远卡住

## 改法

加 `programmaticScrollRef` 标记:**仅** `applyInitialPosition` 和 `scrollToBottom` 在写 scrollTop 前置标记。
onScroll 的 rAF 见标记则跳过 stick 判定(仅重算窗口),消费标记。

为什么只保护这两处:
- `applyInitialPosition` / `scrollToBottom` 用先验/模型 total 算 scrollTop,此值可能超前或滞后于 DOM 真相。
- RO / main useLayoutEffect 的 stick 写入在 **React commit 之后** 执行,此时 `.chat-content` 的 `style.height` 已更新为 `layout.total`,
  rAF 读到的 `scrollHeight` 与 `scrollTop` 一致,stick 判定正确,不需要保护。
- 若全局保护(RO/main effect 也加标记),收敛期多个 rAF 排队会导致 stale rAF 吃掉用户的真实滚动事件(测试中间滚动测试失败)。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx`:
  - 加 `programmaticScrollRef` ref
  - `applyInitialPosition`(两个分支)+ `scrollToBottom` 写 scrollTop 前置标记
  - onScroll rAF:见标记跳过 stick 判定(仅重算窗口)
  - 移除之前在 RO/main effect/FAB 的标记(收敛后 DOM 已提交,不需要)

## 验证

- `tsc --noEmit` → OK
- `bun test` → 128 pass, 0 fail
- `bun run build` → 绿

## 真机验证(待用户执行)

用 `wails3 dev` 或桌面 app 打开长会话(agent 回复多),确认:
1. 打开 session 后视图落在最底部
2. 切走再切回,位置保持
3. 流式输出时贴底跟随
