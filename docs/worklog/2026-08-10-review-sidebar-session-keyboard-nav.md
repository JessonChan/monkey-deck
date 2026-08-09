# 2026-08-10 Review #101 Sidebar session 键盘导航 前端 (APPROVE, Task #24249)

**起因**:Task #24249 对 #24248/issue #101(commit `d344e6d`,feat(sidebar): keyboard
nav for session list)的前端部分做 Frontend Reviewer 端到端验收。本审只评前端
(`frontend/src/`),无后端 / binding / i18n 改动(纯行为 + 视觉增强)。

## 复审范围

- `Sidebar.tsx`:`kbdSelectIdx` state + `kbdActiveRef`、`kbdList`(选中项目已渲染列表)、
  两个 reset effect、scrollIntoView effect、`onSidebarKeyDown` handler、`<aside onKeyDown>`
  绑定、render loop 加 index + `kbdActive` 计算 + ref/class 注入(重命名行 + 普通行两处)。
- `index.css`:`.session-item-row.kbd-active` inset accent-2 环。
- 作用域模型、guard 完备性、边界夹紧、卸载清、与 ⌘1-9 / rename / search / popout 的交互
  正交性、CSS 主题一致性、a11y、测试覆盖。

## 正确性:kbdList 与 render loop `list` 同源(核心)✅

§5.3「找不变量」的关键落地——kbdSelectIdx 是「索引」,索引只有指向「用户实际看到的列表」
才有意义。逐行核对两段计算:

| 维度 | render loop `list`(L418–425) | `kbdList`(L326–335) |
|---|---|---|
| projSessions | `props.sessionsByProject[p.id] ?? []` | `props.sessionsByProject[selProjId] ?? []` |
| sessLimit | `sessionLimit[p.id] ?? SESSION_PAGE` | `sessionLimit[selProjId] ?? SESSION_PAGE` |
| visibleSessions | `projSessions.slice(0, sessLimit)` | 同 |
| searching | `searchProj === p.id && searchQ.trim() !== ""` | `searchProj === selProjId && searchQ.trim() !== ""` |
| 结果 | `searching ? projSessions.filter(matchSession) : visibleSessions` | 同 |

`p.id === selProjId`(kbdActive 的前提)时两段**逐字段同源**;`kbdList` 额外加
`!selProjExpanded → []` 守卫(选中项目折叠时其 session list 根本不渲染,render loop
在 `isOpen && (...)` 内)——一致。`matchSession` 闭包读 `searchQ`/`contentHits`,两段在同
一 render pass 调用,见到的值相同。✅ **无索引错位风险**。

## onKeyDown:guard 完备 + 启动拦截规则 ✅

- **INPUT/TEXTAREA/contentEditable 守卫**(L361):搜索框 / 重命名输入框自己处理键,
  不被劫持。rename input 的 Enter(commitRename)/ Esc(cancelRename)、search input 的
  Esc(toggleSearch)各自独立工作。✅
- **修饰键守卫**(L362):meta/ctrl/alt 放行 → ⌘1-9(切 session)、⌘W/⌘J 等全局快捷键
  透传,不与 §cmd1-9 冲突。✅
- **overlay 守卫**(L363):`ctx || confirm` 开着时放行(Esc 关 overlay,不导航)。✅
- **启动规则**(L368–371):↑↓ 总是可启动 navigation(无副作用,button 不消费箭头);
  Tab/Enter **仅在 `kbdSelectIdx != null`**(导航已启动)时才拦截 → 未启动时 Tab 走原生
  焦点遍历、Enter 走原生提交,**不困焦点、不抢原生 Enter**。这是避免「陷阱焦点 / 抢
  composer Enter」的关键设计,落地正确。✅
- **`e.preventDefault()` 位置**(L373):在所有 early-return guard **之后**、实际推进前
  调用,只对真正要拦截的键拦截。✅

## 边界夹紧 / reset / 卸载清 ✅

- **步进夹紧**(L393):`Math.min(prev+1, len-1)` / `Math.max(prev-1, 0)`,无 wrap-around,
  到边缘停住(符合列表直觉)。✅
- **启动位置**(L386–392):prev==null 时从当前激活 session 的 index 步进(找不到则 ↓→0 /
  ↑→末尾),↑↓ 从当前位置起跳而非跳到列表边缘。✅
- **reset-on-project-switch**(L341):`useEffect([selProjId])` 切项目必清(kbdSelectIdx 只
  对选中项目有意义)。mount 时也跑一次,kbdSelectIdx 本就是 null,no-op(React bailout)。✅
- **reset-on-list-shrink**(L342–344):dep `[kbdList.length]`(用 length 而非数组引用,
  避免每 render 新数组触发)——列表缩到 idx 以下(搜索过滤 / session 被删 / 折叠重展开
  回到 SESSION_PAGE)即清。✅
- **卸载清**:kbdSelectIdx 是 useState,state 随组件实例存在;Sidebar 卸载(popout 模式
  隐藏 Sidebar)即丢弃,**无跨 mount 泄漏**。worklog「卸载清由 state 随卸载丢弃 + 两个
  reset effect 共同满足」的论证成立。✅

## Enter 激活 vs click handler 一致性 ✅

Enter(L376–383)与普通行 onClick(L533–536)行为逐行对齐:

| 分支 | onClick | Enter |
|---|---|---|
| popout session | `poppedSessionIds.has(s.id) && onFocusPopout` → `onFocusPopout(s.id)` | 同 |
| 普通 | `else onSelectSession(s.id, p.id)` | `else onSelectSession(s.id, selProjId!)` |

kbdActive 前提是 `p.id === selProjId`,故 `selProjId!` 与 `p.id` 等价;`!` 非空断言安全
(前置 `list.length === 0` early-return,而 kbdList 在 `!selProjId` 时返 [])。✅

## 与 rename / search / popout 的交互正交性 ✅

- **rename 期间**:renamingId 命中的行重渲染为 input,kbdActive 仍可命中同 idx(若
  kbdSelectIdx 指向它)→ ref 移到 rename 行 div;但 INPUT 守卫使 navigation 键不触发,
  rename input 自己的 onKeyDown(Enter commit / Esc cancel / IME triple-guard)独立工作。
  commitRename 后行重渲染为普通态,kbdActive 仍真、ref 回普通行。**无冲突**。✅
- **search 期间**:search input 聚焦时 INPUT 守卫挡住 navigation;search 过滤改变 list
  内容,kbdList 同步重算(见上「同源」)。✅
- **popout**:Enter 与 click 都先判 `poppedSessionIds.has` → focus popout,不就地选中。✅

## CSS / 主题 ✅

`.session-item-row.kbd-active { box-shadow: inset 0 0 0 1.5px var(--accent-2); }`:
- **inset box-shadow** 不占布局(不影响行高 / 不挤压内容),与 `.active`(背景)/ `:hover`
  (背景)分层共存,无双高亮冲突。✅
- **`--accent-2`** 是既有主题 var(`index.css:22` 定义,全仓 70+ 处复用:rename input
  边框 L253、project-active name L195、terminal/popout mark 等)——与「重命名输入框边框 /
  项目选中名」同色,视觉语言一致。✅
- 不依赖原生 focus outline(现代引擎把 button focus outline 门控在 `:focus-visible`,
  鼠标点击不显),避免高亮行出现 accent 环 + focus 环双环。✅

## i18n ✅(无新增)

本次纯行为 + 视觉增强,无新增 i18n key,无 zh/en 同步问题。

## a11y / data-testid ✅(可测,无新 testid 需求)

- 高亮行复用既有 `data-testid="session-${s.id}"`,无新 testid 需求。
- 键盘 cursor 是视觉态,可经 `.kbd-active` class 断言(若后续加测试)。
- `box-shadow` 高亮对屏幕阅读器不可见,但选中 session 本就有 `aria`/active 态,键盘用户
  按 Enter 即激活——可达性不依赖纯视觉环。

## 测试覆盖(观察项,见下 #1)

无 Sidebar 键盘导航的自动化测试(grep `kbd-active|kbdSelectIdx|kbdActive` in
`*.test.*` 无命中)。功能可测(keyboard event + class 断言),但考虑该交互强依赖 WebKit
/ WebView2 的真实键盘事件分发 + scrollIntoView,mount-test(happy-dom)覆盖度有限,
桌面 app 实测(worklog「下一步」已列)更可信。**不阻塞合入**,记为覆盖缺口。

## 观察项(非阻塞 nit)

### #1 无键盘导航自动化测试(覆盖缺口)

键盘 nav 的 guard / 启动规则 / 边界夹紧 / reset 逻辑均可单测(keyboard event 模拟 +
`kbd-active` class / onSelectSession mock 断言)。当前无测试,纯靠桌面实测。建议后续补
mount-test 覆盖「↑↓ 启动 + Enter 激活 + INPUT 守卫 + 切项目 reset」四条主干,降低回归
风险。不强求本次合入前补。

### #2 索引模型在 list 内容变化(同长度)时 cursor 静默重指(固有特性)

kbdSelectIdx 是纯索引。当 selected project 内启用 search 过滤、过滤后长度恰好不变时,
idx=5 会从 session A 静默指向 session B(用户没按键,cursor「跳」了)。这是 index-model
的固有特性,worklog 也只把「list 缩到 idx 以下」列为 reset 条件(未把「内容变化」列入)。
属罕见 edge case(编码型 agent 单轮内 session 数稳定 + 用户同时用键盘 nav 与 search 过滤
的概率低),且 search input 聚焦时 nav 已被 INPUT 守卫挡住——只在「先 nav 再离框点别处
再回来」的怪路径才命中。**不阻塞**,记为 index-model 的已知 trade-off。

### #3 scrollIntoView effect 仅 dep `[kbdSelectIdx]`

list 内容变化(分页 load more / search 过滤)而 kbdSelectIdx 不变时,高亮行 DOM 位置可能
变,但 effect 不重跑 → 不会自动滚入。实际触发路径窄(需 idx 恰好保持不变 + 行移出视口),
且下一次按 ↑↓ 会立即触发 scrollIntoView 纠正。**不阻塞**。

(三项均不影响正确性 / 不阻塞合入;#1 是「建议补」,#2/#3 是 index-model 的固有 trade-off。)

## 验证(acceptance gate)

- **逐行静态复核**:`Sidebar.tsx` L132–138 / L323–395 / L472 / L485 / L492–494 / L526–527
  + `index.css` L237–239,逻辑与 worklog 设计一致。
- **kbdList 与 render loop parity**:逐字段比对同源(见上表)。
- **Enter vs click 一致性**:逐分支比对一致。
- `--accent-2` 主题 var 存在性 + 全仓复用核对通过。
- **环境限制**:`bun install` 未跑(node_modules 缺失),`bunx tsc --noEmit` / `bun test`
  报 `Cannot find module 'react'` / `react/jsx-dev-runtime` / `highlight.js` 等模块解析
  错——属环境性、非本次代码引入(worklog 已述 5 个 NewSessionModal fail 为 binding 重生成
  漂移,同源环境问题)。代码层面无 TS 类型疑点(kbdSelectIdx 类型 `number | null`、
  ref `HTMLDivElement`、handler 签名 `React.KeyboardEvent<HTMLElement>` 均自洽)。

## Verdict:APPROVE

kbdList 与 render loop 同源 parity(核心不变量)、onKeyDown guard 完备 + 启动拦截规则
(不困焦点 / 不抢原生 Enter / 不误伤 IME 与 ⌘1-9)、边界夹紧、reset-on-switch/shrink、
卸载清(state 随实例丢弃)、Enter vs click 一致、与 rename/search/popout 正交、CSS 主题
一致——全部过关。#1(无自动化测试)为覆盖缺口建议补、#2/#3 为 index-model 固有 trade-off,
均不阻塞合入。建议直接合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-review-sidebar-session-keyboard-nav.md`(本条,新增)
