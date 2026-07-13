# 终端标签 Cmd/Ctrl+1..9 快速切换

## 起因
多终端标签时,用鼠标点切换效率低;VSCode/浏览器/iTerm 共识的 `Cmd/Ctrl+1..9` 直接跳第 N 个标签,
桌面用户有肌肉记忆。需求:只在终端面板可见时生效,避免与其它全局快捷键(如 ⌘J 切面板)冲突。

## 设计
- **监听点放在 `TerminalPanel` 组件内**(window keydown),不放在 App.tsx。
  理由:`TerminalPanel` 本身就是「面板可见才挂载」(`termOpenBySession[sid] &&` 条件渲染),
  监听随挂载/卸载注册与清理,**天然满足「仅面板可见时生效」**,无需额外 visible 标志或条件判断。
- 判定 `e.metaKey || e.ctrlKey`(mac 走 metaKey、其它平台 ctrlKey,二者取或兼容);
  显式排除 `altKey/shiftKey`(避开带修饰键的其它组合)。
- key 范围 `"1".."9"`(字符比较,省去 Number 解析 + 反向校验);`idx = key - 1`。
- **越界忽略**:`idx >= tabs.length` 直接 return,不报错(符合需求「超出标签数则忽略」)。
- 处理后 `e.preventDefault()` 防止浏览器把数字键转发进 xterm 输入或触发其它默认行为。
- 依赖 `[tabs, onSelectTab]`:`onSelectTab` 是 App.tsx 里 `useCallback([])` 稳定引用,tabs 变化时
  重新绑定拿到最新数组(避免闭包捕获旧 tabs)。

## 改了哪些文件
- `frontend/src/components/TerminalPanel.tsx`:新增一个 `useEffect`,window keydown 监听
  `⌘/Ctrl+1..9` → `onSelectTab(tabs[idx].id)`。

## 验证
- `wails3 generate bindings` 生成 bindings(本机不入库)后 `cd frontend && bun run build`
  (tsc + vite production)通过,无类型/编译错误。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿(纯前端改动,仅回归)。

## 下一步
- 手动在 wails3 dev 验证:多标签下 ⌘1/⌘2… 切换正确;越界(如只有 2 个标签按 ⌘5)无反应无报错;
  面板收起后快捷键不再触发(不与其它快捷键冲突);带 Shift/Alt 时不触发。
- 可选增强:tab 上显示序号角标作为视觉提示(当前未做,避免越界需求范围)。
