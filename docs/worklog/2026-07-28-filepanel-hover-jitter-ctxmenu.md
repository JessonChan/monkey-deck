# 2026-07-28 FilePanel 行 hover 抖动修复 + 文件树右键菜单

**类型**:fix(file-panel) + feat(file-panel)

## 起因

用户反馈两点:

1. 右侧文件目录树,鼠标 hover 时行内布局"乱动"——根因是 `.tree-acts`(行尾操作按钮组)原先用 `display:none → inline-flex` 切换,从非 hover 到 hover 时按钮组从文档流外切入,挤动文字、触发 reflow,产生可见抖动。
2. 文件 / 文件夹行上右键没有任何菜单——缺少"Reveal in Finder"等桌面端常用操作入口。

## 改法

### 1. hover 抖动:display 切换 → opacity 切换(零布局位移)

`frontend/src/index.css` `.tree-acts`:

- 改为常驻布局(`display: inline-flex` 永远在文档流里占位),hover/选中态只切 `opacity: 0 → 1`。
- 顺手把 `.tree-row.sel`(选中行)也纳入显示条件——选中但鼠标移开时操作按钮仍可见,符合 VSCode 行为。

opacity 过渡不触发布局,彻底消除抖动。

### 2. 文件树右键菜单(复用 Sidebar ctx-menu 范式)

`frontend/src/components/FilePanel.tsx`:

- 新增 `rootPath` prop(`activeSession.worktreePath || project.path`,经 SidePanel 透传,App.tsx 传入)——文件树 `node.path` 是相对路径,需拼成绝对路径才能交给系统。
- 新增 ctx-menu 状态 + 复用项目既有 ctx-menu 范式(fixed 定位 + 全局 Esc / outside-mousedown / resize / scroll 关闭 + `useLayoutEffect` 视口 clamp 防溢出)。
- 文件 / 文件夹 `tree-row` 加 `onContextMenu`;无 `rootPath` 时不拦截、放行浏览器默认菜单。
- 菜单项:复制路径 / 在 Finder 打开(`ChatService.RevealPath`)/ 分隔线 / 新建文件(仅文件夹)/ 重命名 / 删除——镜像行尾 inline 按钮的能力,右键也能直达。
- 绝对路径解析:`rootPath` 拼相对路径;空相对路径(根)直接用 `rootPath`。

### 3. prop 透传

`App.tsx` → `SidePanel.tsx` → `FilePanel.tsx` 新增 `rootPath`(`SidePanel.Props` 加字段,透传给 `FilePanel`)。

## 改了哪些文件

- `frontend/src/index.css`:`.tree-acts` 由 display 切换改 opacity 切换。
- `frontend/src/components/FilePanel.tsx`:加 `rootPath` prop + ctx-menu 状态/处理器/渲染,`tree-row` 加 `onContextMenu`。
- `frontend/src/components/SidePanel.tsx`:`Props` 加 `rootPath`,透传给 `FilePanel`。
- `frontend/src/App.tsx`:`<SidePanel>` 传 `rootPath`。
- `frontend/src/i18n/locales/{en,zh}.json`:`filePanel.copyPath` / `filePanel.revealInFinder` 双语。

## 验证

- `bun run tsc --noEmit`:零错误。

## 下一步

- 桌面实测:确认 hover 不再抖动;右键文件 / 文件夹弹出菜单,"在 Finder 打开"能打开对应目录。
