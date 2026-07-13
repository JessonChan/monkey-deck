# 修复侧栏项目导入失效(路径输入框 + 拖拽换位)

**日期**:2026-07-14
**类型**:fix(UI)

## 起因

用户反馈:新建/导入项目无法在侧栏拖拽换位置。

## 根因

排查 Sidebar.tsx drag-drop 逻辑后确认:**拖拽排序逻辑本身正确**(`SortableContext items` / `useSortable({ id })` / `handleDragEnd` / `reorderProjects` 链路无 bug,key/id 对新建与已有项目完全一致)。

真正的问题出在**导入项目从未被添加**:

1. **`onAddProjectByPath` 未连线**:Sidebar 声明了 `onAddProjectByPath?` prop,路径输入框 `submitPath` 调 `props.onAddProjectByPath?.(path)`——但 App.tsx 从未传这个 prop,可选链直接跳过 → 输入路径按 Enter 后什么都不发生,项目不存在,自然无法拖拽。

2. **`startAdd` 同时触发文件选择器和路径输入框**:点击 + 按钮时 `startAdd` 既 `setAdding(true)`(显示路径输入框)又 `props.onAddProject()`(打开原生文件选择器)。文件选择器抢焦点 → 输入框 `onBlur` → 200ms 后 `setAdding(false)` 输入框消失 → 用户来不及用路径输入。两条添加通道互相打架。

## 改法

- **App.tsx**:新增 `addProjectByPath(path)` callback(调 `ChatService.AddProject("", path, "")` + `refreshProjects`),传 `onAddProjectByPath={addProjectByPath}` 给 Sidebar。
- **Sidebar.tsx**:`startAdd` 去掉 `props.onAddProject()`——点 + 只显示路径输入框(不再同时弹文件选择器)。路径输入框行内新增「浏览目录」按钮(FolderOpen 图标,`data-testid="browse-project-path"`),点击才打开文件选择器。两条通道独立、不再冲突。
- **index.css**:`.add-path-row` 改 flex 布局,`.add-path-input` 改 `flex:1` 以容纳浏览按钮。

## 改了哪些文件

- `frontend/src/App.tsx`(+ `addProjectByPath` callback + 传 prop)
- `frontend/src/components/Sidebar.tsx`(`startAdd` 精简 + 浏览按钮)
- `frontend/src/index.css`(`.add-path-row` flex 布局)

## 验证

- `go build ./...` / `go vet ./...` / `go test ./...`:全过(后端无改动,仅确认无回归)。
- `cd frontend && bun run build`(tsc + vite):通过,无类型错误。
- 无新依赖。

## 下一步

- 实机验证(macOS WebKit):① 点 + 出路径输入框 ② 输入路径 Enter 能添加 ③ 浏览按钮能打开文件选择器 ④ 添加后项目可拖拽换位。
