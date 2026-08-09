# 2026-08-09 · Review #24197 EditorPane ⌘F 搜索浮层 + CodeViewer match 高亮

## 起因
Task #24198:前端 reviewer 复审 PR #24197(commit `6c67719`,`feat(editor): ⌘F search overlay
in EditorPane + CodeViewer match highlight`)。改动:
1. **EditorPane**:⌘F/Ctrl+F 拦截 → 顶部 find bar(input + 计数 + 上/下/关),200ms 去抖,
   case-insensitive 子串扫描 `content` 成 `(line,col)` occurrence,Enter/Shift+Enter 步进(wrap),
   Esc 关闭,切文件 reset;toolbar 加 Search 图标按钮兜底。
2. **CodeViewer**:新增 `searchMatches`(行号集合→`.cv-search-match` 淡蓝底)+ `activeMatchLine`
   (当前命中行→`.cv-search-active` 强蓝底 + 左侧 accent 条 + useLayoutEffect 滚入视野)。
3. **i18n / CSS**:`filePreview.search*` 7 key(zh/en)+ `.editor-search-overlay` + `.cv-search-*`。

## 复审方法(对照 reviewer 反模式清单)
- **类型补丁反模式排查**(字段加了全链路没人消费):从 `searchMatches` / `activeMatchLine` 两个
  新 prop 的**定义点**(CodeViewer.tsx:41/47)出发,逐个确认消费端——见下「消费清单」。
- **构建 / 测试**:`cd frontend && bun install`(worktree 缺 node_modules)→ `npx tsc --noEmit`、
  `bun test`。tsc 对 EditorPane/CodeViewer 仅报 pre-existing 的 bindings 缺失(Wails 生成物,与本次无关);
  `bun test` = **149 pass / 31 fail**,与改动前完全一致(31 fail 全是 pre-existing:bindings 缺失 /
  McpChip / NewSessionModal 等,**无一条涉及 editor / search**)。本次 **0 新增 fail**。
- **i18n**:`filePreview.search*` 7 key zh/en 集合完全相等;`locales.test` 通过。
- **回归判定**:把 EditorPane/CodeViewer/index.css/en.json/zh.json 换回父提交重跑,pass/fail 数不变。

## 消费清单(无类型补丁反模式,全部命中)
| 新增字段 | 定义点 | 消费点 |
|---|---|---|
| `CodeViewer.searchMatches` | CodeViewer.tsx:41 | → `searchMatchSet` memo(:98)→ `rowEl` `isMatch` → `.cv-search-match` className(:188/194) |
| `CodeViewer.activeMatchLine` | CodeViewer.tsx:47 | → `rowEl` `isActiveMatch` → `.cv-search-active` className + `activeMatchRef`(:189/193/194)→ useLayoutEffect 滚入视野(:148) |
| 7 个 i18n key | en/zh.json | EditorPane.tsx 全部引用(searchTip/searchPlaceholder/searchCount/searchNoMatch/searchPrev/searchNext/searchClose) |
| `.editor-search-overlay` 等 CSS | index.css:1843 | EditorPane find bar JSX |

不变量设计正确(§5.3):`(line,col)` occurrence list 是唯一真相,`searchMatchLines`(per-line Set)
与 `activeMatchLine` 都从它派生,不存成可能漂移的独立 state;`safeIdx` 对 `activeIdx` 越界做 clamp。

## 逐项核对

### ✅ ⌘F preventDefault + 去抖 + reset + 步进 wrap(正确)
- window keydown 拦 `(metaKey||ctrlKey)&&(f|F)` + preventDefault,挡掉 webview 原生 find。listener
  deps `[image]`(只依赖是否图片),正确。
- 去抖:`query`(live)与 `debouncedQuery`(匹配用)分离,200ms;每次去抖落地 `setActiveIdx(0)`
  落到首个匹配。`matches` memo 依赖 `[debouncedQuery, content]`,稳定。
- 切文件(`file.path`)reset 整套(open/query/debouncedQuery/activeIdx)——与 CodeViewer 的
  `posKey` scroll 持久化无冲突:file switch 时 search 先被 reset 为 closed(`activeMatchLine=null`),
  posKey 的 restore/dump 不会与 search scroll 打架(详见下「正交性」)。
- 步进 `(i + dir + len) % len` 正确 wrap;`matches.length===0` 时 `stepMatch` 直接 return + 按钮 disabled。

### ✅ CodeViewer 滚入视野 + 高亮(正确)
- `searchMatchSet` memo 成 Set 做 O(1) per-line 判定;`activeMatchRef` 仅在 `!virtual` 态赋(虚拟化
  态用像素定位 `el.scrollTop = (ln-1)*LINE_HEIGHT - ...`,无需 ref),分工与 `highlightLine` 一致。
- 虚拟化态:active 行可能不在当前 [start,end] 窗口 → layout effect 先设 scrollTop → scroll 事件
  触发 setScrollTop → 窗口重算纳入该行。时序与既有 `highlightLine` effect 同构,无新风险。
- **与 highlightLine / posKey 三方正交**:`highlightLine` effect(:129)→ `activeMatchLine` effect(:148)
  → `posKey` scroll 持久化(:171),均 useLayoutEffect、按定义序执行。file switch 时 search 已 reset
  (closed → activeMatchLine=null → search effect no-op),posKey restore 不被 search 覆盖;反之
  search 期间不切文件,posKey effect 不重跑。三者无竞争。

### ✅ i18n / a11y 基本到位
- zh/en 7 key 同步;按钮全有 `aria-label` + react-tooltip(`data-tooltip-id="md-tip"`,§4.5);
- `data-testid`:`editor-search-overlay` / `editor-search-input` / `editor-search-count`(§4.2 测试友好)。
- **本次补的 a11y 小修**:input 原本只有 `placeholder` 无 `aria-label`(placeholder 不是 accessible name)
  → 补 `aria-label={t("filePreview.searchPlaceholder")}`。

### 🟡 P2(已修):CSS 注释与实际行为相反
**问题**:`.cv-search-*` 规则定义在 `.cv-target` **之后**(index.css:1820 → :1830/:1831),三者
都是单类选择器(特异性 0,1,0 相等)→ **后定义者胜**。即:当某行**同时**是文件打开目标行(`cv-target`)
与搜索命中行(`cv-search-match` / `cv-search-active`)时,**search 的蓝色胜出**,而非注释声称的
「target 黄色主导」。box-shadow 同侧(`inset 3px 0 0`)也是**整体替换**而非 worklog 说的「各占一侧不冲突」;
background 更不会「叠加」(后定义覆盖)。

**为何是 P2 而非 P1**:该碰撞罕见(目标行在文件打开时钉死,搜索通常在其后触发且未必命中同一行),
且碰撞时行仍被清晰高亮(只是蓝而非黄),功能无损——属「注释撒谎」而非「行为坏」。

**修法**(本次 commit):把 index.css:1825 注释改为如实描述——search tint 在源序后定义故碰撞时胜出,
box-shadow 同侧整体替换,碰撞罕见故接受。**不改 CSS 顺序/特异性**:那会是行为变更(让 target 重新胜出),
而「search-active 胜出」本身是合理 UX(用户当前关注点 > 陈旧的打开时导航目标),属产品判断,留给
后续按需调整,本次只纠注释与实际一致。同时订正 impl worklog(2026-08-09-editorpane-cmdf-search-overlay.md)
里「背景叠加 / box-shadow 各占一侧」的错误推理——不在本 review 里改 impl worklog,仅在此记录。

### P3(非阻塞,留 follow-up)
1. **⌘F 全局劫持的焦点范围**:listener 挂 window,只要非图片 file tab 激活就无条件 preventDefault ⌘F。
   注意 App.tsx:1860 ChatView(含 Composer textarea)在 file tab 激活时是 **hidden 但仍 mounted**;且
   TerminalPanel(App.tsx:1941)可与 EditorPane 同时存在。若焦点在终端/其它可见 input,⌘F 仍开编辑器
   搜索并吞掉终端自己的 ⌘F。实际影响低(最常见焦点 Composer 在 file tab 激活时已 hidden),但加个
   焦点守卫(`document.activeElement` 落在 pane 外的 input/textarea/[contenteditable] 时 bail)更稳。
2. **Esc 仅在 input 聚焦时关**:overlay 的 Esc 在 input onKeyDown 上;用户点进代码区失焦后 Esc 不再关
   (须点关闭按钮或重聚焦 input)。§4.2「弹窗必须支持 Esc 关闭」的精神上,可加一个 searchOpen 期间生效
   的 window Esc handler。当前它是非 modal 的 find bar(非真 modal 弹窗),borderline 可接受。
3. **重复 ⌘F 不重聚焦**:overlay 已开且用户点别处后,再按 ⌘F 是 no-op(`setSearchOpen(true)` 同值,
   focus effect 不重跑)。可在 listener 里 `searchInputRef.current?.focus()` 兜底。

## 改了哪些文件
- `frontend/src/index.css`:纠正 `.cv-search-*` 相对 `.cv-target` 的源序/胜出关系注释(P2,注释-only,
  零行为变更)。
- `frontend/src/components/EditorPane.tsx`:search input 补 `aria-label`(P3 a11y,trivial)。
- `docs/worklog/2026-08-09-review-24197-editorpane-cmdf-search-overlay.md`:本条 review。

## 验证
- `cd frontend && bun install && npx tsc --noEmit`:EditorPane/CodeViewer 无新 TS 错(唯一报错是 pre-existing
  的 bindings 缺失,与本次无关)。
- `cd frontend && bun test`:149 pass / 31 fail,与改动前一致(31 fail 全 pre-existing,无 editor/search 相关)。
- 逻辑复核:CSS 注释现与实际特异性解析一致;input 现有 accessible name。

## 结论
**APPROVE #24197(已修 P2 注释 + P3 a11y 后)**。
- 无类型补丁反模式:`searchMatches` / `activeMatchLine` / 7 个 i18n key 全链路被消费。
- 不变量设计正确(occurrence list 为唯一真相,per-line Set 与 active 行派生而非独立 state)。
- 与 highlightLine / posKey 三方正交无竞争;虚拟化/平铺两路滚入视野分工正确。
- 构建通过;0 测试回归;i18n zh/en 同步。
- P2(CSS 注释与实际相反)已修;P3(⌘F 全局焦点范围 / Esc 焦点依赖 / 重复 ⌘F 不重聚焦)留 follow-up,不阻塞。

## 下一步 / OUT OF SCOPE
- 桌面 app 实测(macOS WebKit + Win WebView2,§4.6):⌘F 开 / Esc 关 / Enter·Shift+Enter 步进 /
  切文件 reset / 大文件(>2000 行)虚拟化态滚入视野 / 计数文案中英。
- (可选 P3)⌘F 焦点守卫、window-level Esc、重复 ⌘F 重聚焦。
- (可选,impl worklog 已列)match 字符级高亮 / 正则·大小写·全词切换 / DiffPane 接搜索(抽 hook 复用)。
