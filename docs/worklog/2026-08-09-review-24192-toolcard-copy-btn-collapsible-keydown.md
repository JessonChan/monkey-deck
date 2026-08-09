# 2026-08-09 · Review #24192 ToolCard 折叠态复制按钮 + Collapsible keydown guard

## 起因
Task #24195:前端 reviewer 复审 PR #24192(commit `b225d20`,`feat(chat): add copy-output
button to ToolCard summaries + fix button-in-button`)。改动两块:
1. **5 个 ToolCard(Edit/Read/Search/Generic/Bash)折叠态 summary 加「复制 output」按钮**
   (`SummaryCopyBtn`,复制 `extractToolText(rawOutput)` 的主文本)。
2. **Collapsible 的 summary 从 `<button>` 改成 `<div role=button tabIndex=0 onKeyDown>`**
   (因为 `<button>` 内嵌 `<button>` 是非法 HTML,改成 div[role=button] 才能合法承载复制按钮,
   键盘可达性用 onKeyDown(Enter/Space) 补回)。

标题里的「keydown guard」即指 Collapsible 改成 div[role=button] 后的 onKeyDown 处理是否正确。
本次为**重跑**(确认 keydown 行为)。

## 复审方法(对照 reviewer 反模式清单)
- **逐文件读 + 消费端确认**(反模式:字段/逻辑加了没人消费):从 `SummaryCopyBtn` 定义出发,
  确认 5 个卡片 summary 各自接入且 props 正确;从 `.tool-summary-copy` / `chat.copyOutputTip`
  出发确认 CSS / i18n 全链路命中。
- **类型补丁反模式排查**:`SummaryCopyBtn` 新增的 `text` / `testId` props 在 5 个调用点全部被消费,
  非死字段。
- **构建**:`wails3 generate bindings`(worktree 缺)→ `cd frontend && bun install && bun run build`
  通过(剩余 chunk-size 警告为 pre-existing,与本次无关)。

## 逐项核对

### ✅ button-in-button 修复(正确)
`Collapsible.tsx` 把 summary 从 `<button>` 换成 `<div role=button tabIndex=0>`,这是「可点击标题里
含交互控件」的标准可访问解法——内层可合法放真实 `<button>`,键盘可达性用 onKeyDown 补回。注释转英文
(§3.7)。`.collapse-summary:focus-visible` 加 inset box-shadow 补键盘聚焦可见性。

### ✅ SummaryCopyBtn(5 卡接入正确)
- `onClick` + `onMouseDown` 均 `stopPropagation` → **鼠标**点复制按钮不触发展开/收起。
- react-tooltip `data-tooltip-id="md-tip"` 与全仓一致(§4.5);tooltip 文案随 `copied` 切换
  (`common.copied` / `chat.copyOutputTip`)。
- `data-testid` 各卡独立:`edit/read/search/generic/bash-summary-copy`(§4.2 测试友好)。
- `icon-btn tool-summary-copy` 复用 `.icon-btn` 基类;`.tool-summary` 是 flex 且 `.tool-title{flex:1}`
  占满剩余空间,故 `.tool-summary-copy{margin-left:auto}` 把按钮稳稳推到行尾(无溢出)。
- `!running` 守卫 5 卡一致(运行中不显示)。`GenericToolCard` 补了原本缺的 `running` 局部变量。
- 复制内容:Read/Search/Generic/Bash 复制 `outputR.text`;Edit 走 fallback 链
  `outputR?.text || plainText || parts.newStr`(edit 的 output 仅 failed 时存在,fallback 到写入/diff
  新文本,保证「有内容就有按钮」)。`copyText`(lib/clipboard.ts)Wails 原生 + 2 级 fallback,不抛错。
- i18n:zh/en 均加 `chat.copyOutputTip`,同步。

### 🔴 P1(阻塞,已修):onKeyDown 缺 nested-element 守卫
**问题**:Collapsible 的 onKeyDown 没有「事件是否源自内层交互控件」的守卫。鼠标侧 onClick/onMouseDown
都 `stopPropagation` 了,但**键盘侧没拦**。当焦点在内层复制 `<button>` 上按 Enter/Space:
1. keydown 冒泡到 summary div 的 onKeyDown → 匹配 Enter/Space → `toggle()` → **折叠/展开被误触发**;
2. 父级 `e.preventDefault()` 还会**抑制按钮自身的激活**(Enter 对 button 的 click 是 keydown 的默认动作)
   → 按 Enter 时复制根本不发生。

即:键盘用户激活复制按钮会(误折叠 + 可能不复制)。这正是本任务标题点名的「keydown guard」。

**修法**(本次 commit `8c3b426`):onKeyDown 顶部加 `if (e.target !== e.currentTarget) return;`。
- 内层按钮按 Enter/Space:e.target=button ≠ currentTarget=div → 直接 return,不 toggle / 不
  preventDefault → 按钮原生激活照常 → 复制正常;折叠不动。
- 焦点在 summary 本身:e.target === currentTarget === div → 守卫放行 → toggle 如常。
- 对其它无嵌套交互控件的 Collapsible 用法(ToolGroup / 各卡片 summary 未带按钮时)e.target 恒等于
  currentTarget → 行为不变,零回归。

这是 §5.3「找不变量,不堆 if」的落地:不变量 =「只有 summary 面本身被激活才 toggle」,`e.target ===
e.currentTarget` 是该不变量的稳定判定,而非「上一个事件是什么类型」的启发式。

### P3(非阻塞,留 follow-up)
1. **缺 `aria-expanded`**:`role="button"` 且可折叠的,ARIA 最佳实践应加 `aria-expanded={isOpen}`
   暴露展开态给屏阅用户。鼠标/键盘当前都可用,故非阻塞。
2. **与 `CopyIconButton` 轻度重复**:`SummaryCopyBtn` 与既有 `CopyIconButton`(frontend/src/components/
   CopyIconButton.tsx)同构(copy + Check/Copy 反馈),差异仅在 stopPropagation + 自定义 tooltip key。
   按 §5.3「重复 3 次再抽象」,当前 2 处可接受,后续若再出现第三处嵌套型复制按钮再抽。

## 改了哪些文件
- `frontend/src/components/Collapsible.tsx`:onKeyDown 加 `e.target !== e.currentTarget` 守卫(P1 修复)。
- `docs/worklog/2026-08-09-review-24192-toolcard-copy-btn-collapsible-keydown.md`:本条 review。

## 验证
- `cd frontend && bun run build` 通过(P1 修复后,无 TS / 编译错误)。
- 逻辑复核:onKeyDown 守卫对「焦点在 summary」(放行 toggle)与「焦点在内层按钮」(return,不误触发)
  两路均正确;无嵌套交互控件的用法零回归。

## 结论
**APPROVE(已修 P1 后)**。button-in-button 修复、SummaryCopyBtn 5 卡接入、CSS/i18n/tooltip/testid
全链路正确,无类型补丁反模式。唯一的 P1(keydown 缺守卫,标题点名项)已由 `8c3b426` 修复并复跑构建通过。
P3(aria-expanded / 与 CopyIconButton 的轻度重复)留作后续 follow-up,不阻塞。

## 下一步 / OUT OF SCOPE
- 桌面 app 实测:键盘 Tab 到复制按钮 → Enter/Space 应只复制、不折叠(验证 P1 修复);鼠标点复制按钮
  不展开(已由 stopPropagation 保证)。macOS WebKit + Win WebView2 抽检(§4.6)。
- (可选 P3)给 Collapsible summary 加 `aria-expanded={isOpen}`。
