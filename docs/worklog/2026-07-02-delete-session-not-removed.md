# 2026-07-02 修复:右键删除会话/移除项目确认弹窗按钮点不动 → 会话不消失且无报错

## 起因(症状)
在侧栏会话列表右键 →「删除会话」,弹确认弹窗,点「删除」按钮后:
- 会话**没有从列表消失**(刷新也不消失,因为根本没删)。
- **没有任何错误提示**。
- 「移除项目」的确认弹窗同样点不动。

## 根因
确认弹窗的 `modal-card` 只对 `onClick` 做了 `stopPropagation`,**没有拦 `onMouseDown`**。
而 Sidebar 全局挂了:

```ts
window.addEventListener("mousedown", closeCtx);   // closeCtx = () => { setCtx(null); setConfirm(null); }
```

任意 `mousedown` 冒泡到 window 都会触发 `closeCtx()` → `setConfirm(null)`。
点确认弹窗里的「删除」按钮时事件时序为:
1. `mousedown` 先冒泡到 window → `closeCtx()` → 弹窗**卸载**。
2. `click` 派发时按钮已不在 DOM → `onRemoveSession` **从未被调用**。
3. 于是 `ChatService.DeleteSession` 没发 → DB 记录还在 → 会话不消失 → 也没报错。

右键菜单(ctx-menu)能用,是因为它自己的容器有 `onMouseDown={(e) => e.stopPropagation()}`;
确认弹窗漏了这条,是同一个 listener 的受害者。

这是「事件冒泡 + 全局监听」的典型陷阱:`onClick` 拦不住 `mousedown`,而关闭逻辑挂在 `mousedown` 上。

## 改法
文件:`frontend/src/components/Sidebar.tsx`、`frontend/src/index.css`

1. **确认弹窗容器拦 mousedown**:两个 confirm 弹窗(project / session)的 `modal-overlay` 与 `modal-card`
   都加 `onMouseDown={(e) => e.stopPropagation()}`,与 ctx-menu 对齐。这样 mousedown 不冒泡到 window,
   弹窗不再被提前卸载,按钮的 `click` 能正常派发。**这是核心修复。**

2. **删除/移除改成 async 确认流 + 失败内联报错**:
   - 新增 `deleting` / `deleteErr` 状态。
   - 新增 `onConfirmRemoveProject` / `onConfirmRemoveSession`:setDeleting → await props.onRemove* →
     成功才 `setConfirm(null)`;失败 `setDeleteErr(String(e))`,弹窗不关。
   - 删除按钮 `disabled={deleting}` 防重复点。
   - session 确认弹窗里渲染 `deleteErr`(`.modal-del-err`)。

   App 侧 `removeSession` / `removeProject` 本就是 `await ChatService.*()` 后再改 state:
   - 成功 → 改 state(列表移除等)→ resolve → Sidebar 关弹窗。
   - 失败 → 函数 reject → state 不动(与「DB 没删」一致)→ Sidebar catch → 内联报错。

3. **打开/关闭 confirm 时重置 deleteErr**(closeCtx、菜单「删除会话/移除项目」入口),避免上一次错误残留。

## 为什么这么改(根因不变量)
不变量:**全局 mousedown 监听只该响应用户在「弹窗之外」的点击来关闭弹窗,不能吃掉弹窗内部交互**。
ctx-menu 已靠容器 `stopPropagation` 守住这条不变量;confirm 弹窗违背了它。修法是让 confirm 弹窗
对齐 ctx-menu,而不是给每个按钮单独挡事件——一处容器级修复消灭整类问题。

未引入「超时兜底 / 重试 / 全局 toast」:桌面应用有人在场,删除失败直接在原弹窗内联报错最直接,
用户可重试或取消,符合 §3.4「有人在场」的产品取向。

## 验证
- `bun run tsc --noEmit` 通过(0 error)。
- 逻辑复核:修复后 mousedown 被弹窗容器 stop,不再触发 closeCtx;click 正常派发到「删除」按钮 →
  onConfirmRemoveSession → ChatService.DeleteSession → 后端关 harness + 清 worktree + 删 DB →
  App removeSession 改 state → 列表移除。失败时弹窗内联报错且不关。

## 改了哪些文件
- `frontend/src/components/Sidebar.tsx`:confirm 弹窗 onMouseDown stopProp + async 确认流 + deleteErr 状态/内联提示。
- `frontend/src/index.css`:`.modal-del-err` 样式。

## 下一步
- 手动回归:右键会话 → 删除 → 确认,会话消失;右键项目 → 移除 → 确认,项目消失;
  断开后端时删除应弹内联错误。
