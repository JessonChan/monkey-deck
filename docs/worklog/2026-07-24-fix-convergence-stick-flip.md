# 修复收敛期贴底判定误翻(stick-flip)

日期:2026-07-24

## 起因

用户报告:切换会话后滚动落点偏上——A 已在底部,切到 B/C/D(含全新会话)都"略高于底部"。
非"记住上次位置"问题(全新打开也复现),是间歇性的(取决于高度收敛时序)。

## 根因

RO 回调与 React 提交之间存在竞态窗口:

1. `applyInitialPosition` 用先验高度算出 `lay.total`,写 `el.scrollTop = lay.total - clientHeight`,stick=true。
2. RO 测量真实高度(通常 > 先验),`computeLayout` 得到更大的 `newLay.total`,写入 `layoutRef.current`。
3. RO re-pin 写 `el.scrollTop = newLay.total - clientHeight`,但浏览器把 scrollTop **clamp** 到已提交的
   `scrollHeight - clientHeight`(React 尚未提交新 `.chat-content` 高度)→ scrollTop 停在旧底部。
4. scrollTop 变化触发 scroll 事件 → onScroll rAF 入队。
5. rAF 执行时读 `layoutRef.current.total`(已推进到新值)与 `el.scrollTop`(被 clamp 到旧底部):
   `isAtBottom(新total, 旧scrollTop, viewport)` → gap = 新total - 旧scrollHeight ≫ 80 → **stick 误翻 false**。
6. 后续 `useLayoutEffect` 的贴底分支被跳过,视图停在偏上位置。

关键:旧代码 `isAtBottom(lay.total, …)` 用模型 total(超前),新代码 `isAtBottom(el.scrollHeight, …)`
用 DOM 已提交高度(真相)——收敛期两者不一致,只有后者与 `el.scrollTop`(被 clamp 到 DOM 坐标系)自洽。

## 改法

### 主修复:`onScroll` 贴底判定读 `el.scrollHeight`

`frontend/src/components/ChatView.tsx`:

```ts
// 旧(有 bug):
const nearBottom = isAtBottom(lay.total, el.scrollTop, el.clientHeight);
// 新:
const nearBottom = isAtBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
```

`lay` 仍用于锚点/窗口计算(模型坐标系);贴底判定是视口事实,读 DOM。

### 辅修复:切 session 时重置头/尾区高度

`.chat-body` 按 `key={sessionId}` 重挂载,新 session 的头/尾区是全新 DOM(权限卡/plan/打字指示
有无可差上百 px),旧实测高不适用:

```ts
headHRef.current = HEAD_PRIOR;
tailHRef.current = TAIL_PRIOR;
```

### 测试 harness 增强

`frontend/src/components/ChatView.virtual.mount.test.tsx`:

- `scrollHeight` getter:从已提交的 `.chat-content` style.height 读取(模拟浏览器 layout)。
- `scrollTop` getter/setter:WeakMap 存储 + clamp 到 `[0, scrollHeight - clientHeight]`
  + 变化时同步派发 scroll 事件(WebKit 语义)。
- 可变几何 mock(`mockRowH`/`mockHeadH`/`mockTailH`):测试可模拟高度收敛/增长。
- 手动 rAF 模式(`manualRaf` + `rafQueue`):控制 rAF 执行时序,复现竞态窗口。

### 复现测试(TDD)

新增测试"收敛期 stick 不误翻":

1. 挂载 20 条,收敛到贴底。
2. 切手动 rAF → 派发 scroll 事件(rAF 入队)→ 改 `mockRowH=200` → RO trigger(layoutRef 推进)。
3. 执行 pending rAF:此刻 `el.scrollHeight` = 旧高度,`layoutRef.total` = 新超前值。
4. 旧代码:stick 误翻 false → 后续不贴底 → **测试失败**(已验证)。
5. 新代码:stick 保持 true → 贴底重定位 → 测试通过。

## 改了哪些文件

- `frontend/src/components/ChatView.tsx` — 贴底判定 + 切 session 重置 + 注释更新
- `frontend/src/components/ChatView.virtual.mount.test.tsx` — harness 增强 + 复现测试

## 验证

- `tsc --noEmit` 通过
- `bun test` 119 pass / 0 fail(含 3 个 mount test)
- `bun run build` 绿色(仅预存 chunk-size 警告)
- TDD:旧代码下复现测试失败,新代码通过

## 下一步

- 真机验证(macOS WebKit + Windows WebView2):切会话/全新打开后滚动落点是否贴底。
- 若仍有偏移,检查是否有其他收敛路径(如 tail 区权限卡异步出现)触发类似竞态。
