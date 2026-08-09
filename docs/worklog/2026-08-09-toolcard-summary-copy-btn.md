# 2026-08-09 ToolCard 折叠态 summary 复制按钮 + button-in-button 修复

## 起因
Task #24193:所有 ToolCard(Edit / Read / Search / Generic / Bash)折叠态 summary 要加一个
「复制 output」按钮(copy 出 `extractToolText(rawOutput)` 的主文本),且:
1. 点击该按钮要 `stopPropagation`,不能触发外层折叠展开/收起;
2. 用 `icon-btn` 风格;
3. 要处理 button-in-button(外层 summary 是个 `<button>`,内层再放 `<button>` 是非法 HTML,
   浏览器会丢弃内层 button 的语义)。

## 根因 / 设计
- `Collapsible.tsx` 原本把 summary 包在 `<button class="collapse-summary">` 里 → summary 内
  无法放任何交互控件(button-in-button 非法)。
- 标准可访问解法:把外层 `<button>` 改成 `<div role="button" tabIndex={0}>` + `onKeyDown`
  处理 Enter/Space(等价原生 button 的键盘行为,Space 还要 `preventDefault` 防滚屏)。
  这样 summary 内可合法嵌套真实 `<button>`,且键盘可达性不丢。这是「可点击标题里含交互控件」
  的通用模式。
- 复制内容:task 明确「copy output,extractToolText」。各卡统一复制 `extractToolText(rawOutput).text`;
  EditToolCard 的 output 通常只在 failed 时存在,故 fallback 到 plainText / diff 新文本,
  保证「有内容可复制时就有按钮」。

## 改法
1. **`frontend/src/components/Collapsible.tsx`**:外层 `<button>` → `<div role="button"
   tabIndex={0} onKeyDown>`,Enter/Space 触发 toggle。注释转英文(§3.7)。
2. **`frontend/src/components/ChatView.tsx`**:新增 `SummaryCopyBtn({ text, testId })` 组件 ——
   `icon-btn tool-summary-copy` 风格,`onClick`/`onMouseDown` 均 `stopPropagation`,
   react-tooltip(§4.5),Copy/Check 图标 1.2s 反馈。接入 5 个卡片 summary:
   - EditToolCard:`!running && summaryCopyText.trim()`(output || plainText || newStr)
   - ReadToolCard / SearchToolCard / GenericToolCard / BashToolCard:`!running && outputR?.text`
   - GenericToolCard 补 `running` 局部变量(原本没有)。
3. **`frontend/src/index.css`**:
   - `.tool-summary-copy`(margin-left:auto 推到行尾、20×20、opacity 0.5→hover 1)。
   - `.collapse-summary:focus-visible` 加 inset box-shadow(键盘聚焦可见性)。
4. **i18n**:zh/en 各加 `chat.copyOutputTip`。

## 改了哪些文件
- `frontend/src/components/Collapsible.tsx`
- `frontend/src/components/ChatView.tsx`
- `frontend/src/index.css`
- `frontend/src/i18n/locales/zh.json`
- `frontend/src/i18n/locales/en.json`

## 验证
- `wails3 generate bindings` 生成 bindings(本 worktree 无,先补齐)。
- `cd frontend && bun install && bun run build`(= `tsc && vite build`)通过,无 TS / 编译错误。
- 无 lint 脚本(package.json 未配)。

## 下一步
- 桌面 app 实测各 ToolCard 折叠态:点复制按钮不展开、复制内容正确、hover 显形。
- macOS WebKit + Win WebView2 跨平台抽检(§4.6):opacity 过渡、focus ring、tooltip。
