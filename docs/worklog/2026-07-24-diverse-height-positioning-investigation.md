# 多样元素类型会话的定位稳定性调查

## 起因

用户实测报告:切换会话后落点偏上,且「与页面元素种类多少相关」——元素类型越多样(user/agent/thought/tool/plan 混合),落点越不准。此前已修复两个切会话相关 bug(stick-flip、FAB 残留),但用户澄清问题不在切会话,而在**当前窗口内的定位**,且与元素多样性相关。

## 调查方法

现有挂载测试用**统一 `mockRowH=100`** 模拟所有行高,完全覆盖不到「元素类型多样 → 先验偏差悬殊」的维度。扩展测试 harness 支持逐行高度覆盖(`rowHeights: Map<string, number>`),新增两个多样高度场景测试:

1. **多样高度贴底收敛**:210 条消息(30 回合:user120/agent300/thought30/tool组40/plan250,先验偏差 2-3 倍),验证 S 不变量收敛后视图钉在真底部,FAB 不出现。
2. **多样高度锚点稳定**:上翻到中部后触发测量收敛,验证 A 不变量(锚点行视觉位置不漂移)。

## 结果

**两个测试均通过**——当前实现在多样高度下定位正确:
- S 不变量:收敛后 `scrollTop = scrollHeight - viewport`,FAB 隐藏,末行在 DOM。
- A 不变量:锚点行在测量收敛后仍在 DOM,视觉位置(相对视口顶部)不漂移。

**用户报告的 bug 未被复现**。可能原因:
- 真实浏览器与 happy-dom 的 ResizeObserver/scroll 事件时序差异;
- 真实会话的元素高度分布更极端(如超长 agent 消息、展开的 tool 组);
- 用户观察到的「偏上」是收敛过程中的瞬态(先验估算 → 实测收敛),而非稳态。

## 防御性修复

在主 `useLayoutEffect` 的非贴底分支,显式用 `restoreScroll` 重定位到锚点行:

```ts
} else {
  const anchor = anchorRef.current;
  const restored = anchor ? restoreScroll(layout, rows, anchor.iid, anchor.off) : null;
  if (restored !== null) {
    el.scrollTop = restored;
    setWinIfChanged(computeWinFor(layout, restored));
  } else {
    setWinIfChanged(computeWinFor(layout, el.scrollTop));
  }
}
```

**理由**:RO 回调的 `el.scrollTop += delta` 可能被 clamp(DOM 高度尚未提交),主 effect 在 React 提交新高度后运行,此时 `restoreScroll` 算出的是 clamp-proof 的正确值。这与 stick-flip 修复(贴底判定读 `el.scrollHeight` 而非超前 `layoutRef.total`)同属「clamp-ahead」类 bug 的防御。

测试场景未触发 clamp 条件(测试通过与否不依赖此修复),但修复语义正确、幂等,增强鲁棒性。

## 改了哪些文件

- `frontend/src/components/ChatView.virtual.mount.test.tsx`:
  - 扩展 harness 支持逐行高度覆盖(`rowHeights` Map);
  - 新增 `makeDiverseItems` 生成多样高度会话;
  - 新增两个多样高度测试(贴底收敛、锚点稳定)。
- `frontend/src/components/ChatView.tsx`:
  - 主 effect 非贴底分支显式重定位锚点(防御性修复)。

## 验证

- `tsc --noEmit` → OK
- `bun test` → 125 pass, 0 fail(新增 2 个多样高度测试)
- `bun run build` → 绿(仅既有 chunk-size 警告)

## 下一步

- 真机验证:在 macOS WebKit 上打开多样元素类型的长会话,观察切换/滚动后落点是否准确;
- 若真机复现,用 DevTools 录制 ResizeObserver/scroll 事件时序,对比 happy-dom 差异;
- 考虑持久化实测高度(session 级缓存),减少每次打开的收敛时间。
