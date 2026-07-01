# 项目拖拽排序(侧栏)

**日期**:2026-07-01
**类型**:feat(UI + store)

## 起因

侧栏项目列表原本只能按 `updated_at DESC` 排序,且 `TouchProject` 是死代码(session 活动不刷新项目 `updated_at`)——实际只是「最近改过项目元数据」的顺序,用户无法自定义。用户要求:拖拽改变项目顺序。

## 设计决策

1. **加 `sort_order` 整数列,而非浮点 / lexorank**:项目量级小(几十),拖拽后事务内全量重写 `0..N-1` 最简单可靠,无需 lexorank / 浮点精度再平衡。
2. **兜底 `updated_at DESC`**:`ORDER BY sort_order ASC, updated_at DESC`。全 0(从没拖过)时行为与原先完全一致,零回归;一旦拖拽即进入纯手动模式。
3. **新建项目恒在顶部**:`CreateProject` 设 `sort_order = COALESCE((SELECT MIN(sort_order)-1 FROM projects), 0)`——表空为 0,否则 MIN-1。负数累积无害(相对顺序对,下次拖拽即归一化为 0..N-1)。
4. **拖拽库选 `@dnd-kit`**(非 react-beautiful-dnd / 原生 DnD API):轻(core+sortable ~15KB gzip)、纯 DOM `transform`、React 19 兼容、跨平台一致(§4.6)。react-beautiful-dnd 已停维护且有 React 19 严格模式坑;原生 DnD 在 WebKit 手感差、动画要自写。
5. **整行可拖(仅折叠态)**:展开态 `useSortable({ disabled: true })`——不可主动拖,但仍可被其他项挤动(dnd-kit 默认行为,符合直觉:拖折叠项插入,展开项顺延)。`PointerSensor distance:6` 约束让 caret / 搜索 / 新对话等子按钮点击不误触发拖动。
6. **sticky + transform 冲突**:`.project-item` 是 `position: sticky`(吸顶)。被拖时 dnd-kit 加 `transform`,WebKit 下 sticky 与 transform 冲突。对策:`isDragging` 给 wrap 加 `dragging` class,CSS `.project-item-wrap.dragging .project-item { position: relative }` 临时去 sticky,松手恢复。

## 改法

- **后端**:migration 0007 加 `sort_order` 列;`Project.SortOrder` 字段;`ListProjects` 排序改 `sort_order ASC, updated_at DESC`(三处 SELECT/Scan 加列);`CreateProject` 设 MIN-1;新增 `Store.ReorderProjects`(事务内逐条 UPDATE);`ChatService.ReorderProjects` 暴露;`wails3 generate bindings`。
- **前端**:`@dnd-kit/core + sortable + utilities`;Sidebar 拆出 `SortableProjectRow` 子组件(`useSortable` 必须在子组件实例化,不能在 map callback 里),外层包 `DndContext / SortableContext`;`handleDragEnd` 用 `arrayMove`;App.tsx `reorderProjects` 乐观更新 + 持久化 + 失败回滚 `refreshProjects`。

## 改了哪些文件

- `internal/store/migrations/0007_project_sort_order.sql`(新)
- `internal/store/store.go`(`Project.SortOrder` 字段)
- `internal/store/projects.go`(CreateProject / ListProjects / GetProject / GetProjectByPath 加列 + ReorderProjects)
- `internal/store/store_test.go`(+ `TestProjectReorderSortOrder`)
- `internal/chat/chat.go`(+ `ReorderProjects`)
- `frontend/src/components/Sidebar.tsx`(`SortableProjectRow` + `DndContext` + `handleDragEnd`)
- `frontend/src/App.tsx`(+ `reorderProjects` + `onReorderProjects` prop)
- `frontend/src/index.css`(+ `dragging` 去 sticky 样式)
- `frontend/package.json` / `bun.lockb`(@dnd-kit 依赖)

## 验证

- `go test ./internal/...`:9 包全过(含新 `TestProjectReorderSortOrder`:新建在顶 / Reorder 重写 / sort_order 优先于 updated_at)。
- `bunx tsc --noEmit`:干净通过。
- `bun run build:dev`:393 模块构建成功(含 @dnd-kit)。
- **GUI 拖拽手感 / 跨平台一致性待实机验证**(§4.6:mac WebKit + Win WebView2)——无头环境无法模拟真实拖拽交互,需 `make dev` 实机确认:① 折叠态整行拖动顺滑 ② 展开态不可拖 ③ 子按钮点击不误触发 ④ 重启后顺序保持。

## 下一步

- 实机验证后,若 WebKit 下临时去 sticky 有视觉瑕疵(如吸顶中断),微调 `dragging` CSS。
- 若后续要 session 列表也支持拖拽,同模式可复用;但 session 现按 `prompted_at` 排序(语义不同),需另议。
