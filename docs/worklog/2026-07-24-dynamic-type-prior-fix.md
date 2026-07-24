# 打开 session 不在最底部:动态类型先验修复虚拟化 total 偏差

## 起因

用户反复报告:打开任意 session(含全新/短会话),视图都不在最底部,而是停在半中腰。此前已修两个切会话 bug(stick-flip、FAB 残留),问题依旧。用户明确:这不是切会话问题,而是「定位本身算错了」,且与页面元素种类多少相关。

## 根因

**虚拟化下窗口外的行永远不在 DOM,无法实测,只能用先验高度估算 `layout.total`。**

固定先验(`PRIOR_HEIGHT`)取全库 P50 定标定标值(agent=90、user=45、thought=48、tool=56、plan=120)。但单个 session 的真实高度分布可能远偏 P50:
- agent 真实 ~250-300px(长 markdown 回复),先验 90 → 偏差 ~3 倍
- plan 真实 ~200-250px,先验 120 → 偏差 ~2 倍

200 条消息、窗口只渲染底部 30 行时,上方 170 行全用固定先验 → `layout.total` 严重偏小 → `scrollTop = total - clientHeight` 永远到不了真实底部。

**数值验证**(Python):
```
真实 total: 31082, 真实底部 scrollTop: 30282
固定先验 total: 16207, scrollTop: 15407, 偏差: 49%
动态先验 total: 31082, scrollTop: 30282, 偏差: 0%
```

TDD 复现(组件级):关闭动态先验后,`.chat-content` 高度 vs 真实 total 误差 **45.66%**(测试失败);开启后误差 <5%(测试通过)。

这解释了用户所有观察:
- 「打开 session 不在最底部」→ total 偏小,scrollTop 被钳在偏上位置
- 「与元素种类多少相关」→ agent/plan 等高先验偏差大的类型越多,total 偏差越大
- 「全新短会话也有」→ 即使消息少,只要有 agent 回复,先验就偏小

## 改法

`HeightModel` 从「实测 Map + 固定先验」升级为「实测 Map + **动态类型先验**」:

```ts
// set 时按类型累积样本(sum, count)
set(row: VRow, height: number): boolean {
  // ... 写 measured ...
  let stats = this.typeStats.get(row.kind);
  if (!stats) { stats = { sum: 0, count: 0 }; this.typeStats.set(row.kind, stats); }
  stats.sum += rounded - (prev ?? 0);
  stats.count += prev === undefined ? 1 : 0;
}

// h() 未测量行优先用同类型已测量均值,样本不足(<3)退回固定先验
h(row: VRow): number {
  const m = this.measured.get(row.id);
  if (m !== undefined) return m;
  const stats = this.typeStats.get(row.kind);
  if (stats && stats.count >= MIN_TYPE_SAMPLES) return Math.round(stats.sum / stats.count);
  return this.prior(row);
}
```

窗口内的实测行越多,类型先验越准,total 越接近真实(RO 收敛后偏差从 ~50% 降到 <5%)。

**接口变更**:`set(id, h)` → `set(row, h)`(需要 `row.kind` 累积类型统计);`prune(Set<id>)` → `prune(VRow[])`(prune 后重建类型统计)。ChatView 的两处调用同步适配。

## 改了哪些文件

- `frontend/src/lib/virtualList.ts`:`HeightModel` 加 `typeStats` Map + 动态类型先验;`set`/`prune` 接口变更。
- `frontend/src/lib/virtualList.test.ts`:适配新接口;新增 2 个动态先验单测(≥3 样本用均值、<3 退回固定先验)。
- `frontend/src/components/ChatView.tsx`:RO 回调 `model.set(rs[idx], h)`、切 session `model.prune(rows)` 适配新接口。
- `frontend/src/components/ChatView.virtual.mount.test.tsx`:新增动态先验 total 精度测试(TDD 复现:固定先验误差 45.66% → 动态先验 <5%)。

## 验证

- `tsc --noEmit` → OK
- `bun test` → 128 pass, 0 fail(新增 3 个测试:2 单测 + 1 组件测试)
- `bun run build` → 绿(仅既有 chunk-size 警告)
- TDD:关闭动态先验 → 组件测试失败(误差 45.66%);开启 → 通过(误差 <5%)

## 下一步

- 真机验证:打开长会话(session 消息多、agent 回复长),确认视图落在最底部;
- 若仍有残留偏差,考虑提高 `MIN_TYPE_SAMPLES` 或加权(近期样本权重更高);
- 考虑持久化 typeStats(同 session 重开免重新收敛)。
