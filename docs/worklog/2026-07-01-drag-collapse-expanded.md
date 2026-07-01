# 拖拽时自动折叠项目(修复拖动距离过长)

**日期**:2026-07-01
**类型**:fix(UI)

## 起因

上一条(项目拖拽排序)落地后,用户反馈:拖动时需要拖**非常长的距离**才能挪到目标位置。

## 根因

展开态项目 `useSortable({ disabled: true })` 不可主动拖,但**仍渲染 session 列表、占据完整高度**。dnd-kit 的碰撞检测(closestCenter)基于 DOM 矩形:拖一个折叠项时,要**跨越展开项的整段高度**才能让 `over` 落到下一项 → 视觉上拖了很远却没换位。

## 改法

`onDragStart`:把当前 `expanded` 快照存进 `expandedBeforeDrag` ref,然后 `setExpanded(new Set())` 全折叠 → 拖动期间列表全是均匀单行高度,碰撞检测准确、换位距离短。
`onDragEnd` / `onDragCancel`:`setExpanded(expandedBeforeDrag.current)` 恢复原展开态 → 不打断用户原本在看的项目(尤其用户展开着 A、去拖 B 的场景)。

拖动一旦开始,active.id 由 DndContext 固定跟踪,中途 `setExpanded` 只改渲染/碰撞尺寸,不中断进行中的拖动。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx`(+ `expandedBeforeDrag` ref、`handleDragStart` / `handleDragCancel`、DndContext 加 `onDragStart` / `onDragCancel`)

## 验证

- `bunx tsc --noEmit`:干净通过。
- GUI 拖拽手感待实机(同上一条 `2026-07-01-project-drag-reorder.md`):确认折叠后拖动顺滑、结束后原展开项恢复。

## 下一步

无。
