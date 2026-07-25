# 侧栏 + 直接浏览目录,移除粘贴路径输入框

**日期**:2026-07-26
**类型**:refactor(UI)

## 起因

侧栏「+ 添加项目」之前是「点 + 弹出粘贴路径输入框 + 浏览按钮」两通道设计(见 `2026-07-14-fix-project-import-drag.md`)。实际使用中粘贴路径通道冗余——用户一律走原生文件选择器更直观,粘贴输入框反而增加交互步骤、占侧栏空间。

## 改法

点 + 直接调 `onAddProject`(原生文件选择器),移除整套粘贴路径 UI。

- **Sidebar.tsx**:删除 `adding` / `pathInput` state、`submitPath` / `startAdd` 函数、整段 `add-path-row` JSX;`+` 按钮 `onClick` 直接绑 `props.onAddProject`;从 `Props` 移除 `onAddProjectByPath?`;空态条件 `!adding` 去掉。
- **App.tsx**:删除 `addProjectByPath` callback 与 `onAddProjectByPath={...}` 传参。
- **index.css**:删除 `.add-path-row` / `.add-path-input` 规则。
- **i18n(en/zh)**:删除 `sidebar.browseDirectory` / `sidebar.pastePathPlaceholder` 两个不再使用的 key。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx`(state / 函数 / JSX / Props 精简)
- `frontend/src/App.tsx`(`addProjectByPath` callback 与 prop 传递移除)
- `frontend/src/index.css`(`.add-path-row` / `.add-path-input` 删除)
- `frontend/src/i18n/locales/en.json`、`frontend/src/i18n/locales/zh.json`(冗余 key 删除)

## 验证

- `go build ./...` / `go vet ./...`:全过(后端无改动)。
- `cd frontend && bun run build`(tsc + vite):通过,无类型错误。
- 全仓 grep `add-path-row|pathInput|submitPath|onAddProjectByPath|addProjectByPath|browse-project-path|browseDirectory|pastePathPlaceholder`:无残留。

## 下一步

- 实机验证(macOS WebKit):点 + 直接弹原生目录选择器,选择后项目正常添加并出现在列表。
