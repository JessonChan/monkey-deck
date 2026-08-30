# 复审 #28442 文件面板搜索历史前端面(Task #28443,#167)

- 日期:2026-08-31
- 结论:**APPROVE**(含一项复审中发现并当场修复的跨平台缺陷 + 机制锚定测试;D1-D8 反向实证全通)
- 独立复跑 gate:`bun test --isolate`(frontend 全量)**510 pass / 0 fail**、`bunx tsc` 0 错、`bun run build` 过(chunk >500kB 警告为既有)——与 coder 声称逐字一致(含修复后同数)。

## 起因

Review Task #28442(coder 实现 #167 文件面板搜索历史,commit bf0121f + worklog bace513)。流程 coder→fe-reviewer→APPROVE。

## D1-D8 反向实证(从定义点追到消费端,不顺着 commit message 走)

- **D1 存储** ✓:`filePanelCache.ts` 前移去重写入 / cap12 自淘汰 / try-catch 防腐 + 非串过滤,形态确系 Composer `md:recent-models` 先例。键域两变体有单测锚定(`md:recent-file-searches:/repo` 与 `...:s1` 字面值)。
- **D2 状态保持** ✓:`FilePanelSnapshot` 增 `searchOpen`/`query`,懒初始化恢复 + snapRef 卸载快照;`results` 确不缓存——重挂测试锚定 `fuzzyFind` 被再次调用(参数逐字断言),证明走的是既有 debounce effect 重跑,无第二套缓存/重跑机制。
- **D3 命中即退出** ✓:历史写入挂 `pickResult` 入口、`exitSearch()` 原样(与 #132 语义解耦);目录命中测试断言 localStorage 写入 + `listDir("s1","src")`(reveal 仍跑)+ `opened` 空(不误开编辑器)三点齐。
- **D4 历史下拉** ✓(修复后):聚焦+空 query+非空历史才渲染;回填走 DOM value(非受控约束保持)立即搜;单删 ✕ 见下节缺陷;零新组件/零新 CSS 属实(`.file-search-history` 容器无规则,复用 `tree-body` 内 `tree-row` 体系)。
- **D5 Esc** ✓:diff 实证 key listener 链逐字未动,`exitSearch` 体内仅增 `setSearchFocused(false)`(关闭态清理,不在链上)。
- **D6 非受控 input** ✓:input/keydown/composition 原生监听链原样;focus/blur/hydration 独立成 effect,物理不碰原链。
- **D7 清理边界** ✓:全 src grep 无任何 `localStorage.clear`/`removeItem` 调用点;`removeRecentFileSearch` 唯一消费点是 ✕ 的 `deleteHistory`;closeTab 只 `deleteFilePanelState`(进程内 Map)。
- **D8 测试** ✓:11 store 测 + 9 mount 测,断言锚定值(JSON 串字面、fuzzyFind 参数、`data-query` 序),非字段存在性。

## 复审缺陷(已修复):✕ 单删在 Chromium 系引擎必失效

**根因**:行级 `onMouseDown preventDefault` 保焦点的经典防坑,被 ✕ 自己的 `onMouseDown stopPropagation` 挡掉了——Chromium 系引擎(Windows WebView2 桌面端、远程浏览器 Chrome/Edge、Firefox 部分平台)button mousedown 会**夺焦点** → input `blur` → `setSearchFocused(false)` → `showHistory` 翻 false → 下拉在 mouseup/click 之前卸载 → **`deleteHistory` 永不触发**。macOS WebKit 的 button mousedown 不夺焦点,故桌面 GUI 上此路是通的——恰好构成「我在的那端好的」跨平台假象。

**为什么 coder 的测试没拦住**:mount 测试只派发裸 `click()`(mousedown 序列缺席),happy-dom 也不模拟 mousedown 夺焦——单删路径在测试里从未走过真实引擎的事件序列。这正是「类型补丁/逐路径验证运行时消费」的形态:tsc 绿 + 测试绿 ≠ 行为通电。

**修法**(本卡当场修,commit 见下):`FilePanel.tsx` ✕ 的 `onMouseDown` 补 `e.preventDefault()`(与行级同范式;mousedown 默认行为只有夺焦/起选,不影响 click 派发,WebKit 下行为不变)。测试在回填用例与单删用例各加 cancelable mousedown 派发并断言 `defaultPrevented === true`——机制锚定,无修复必红,防回退。

## 测试基建澄清(供后续 agent 参考)

- 项目规范 gate 是 **`bun test --isolate`**(每文件独立进程)。裸 `bun test` 下 68 个文件共享进程,各文件自建 happy-dom Window + 改写 `globalThis`/模块级常量(如 coarse 测试要求 matchMedia 覆盖先于 FilePanel import)→ 16 个跨文件污染型假失败(clipboard/App/ErrorCard/coarse 等);单文件复跑即绿,与本次 diff 无关。
- 本 worktree 冷启动需先 `bun install` + `make bindings`(`frontend/bindings` gitignored 不随 checkout,见 coder worklog OPEN #4)。

## 键域 OPEN 维持(非阻塞,待拍板)

App.tsx:2494 传下的 rootPath 对 git 项目实为 per-session worktree 目录 → 「项目级共享」只在非 git 项目成立(git 项目退化为 per-worktree 键)。coder 已如实记 OPEN;维持不扩面:改传 `selectedProject.path` 需动 App/SidePanel,且 `rootPath` 同时供 ctx-menu `absPath`(复制/Reveal 指向 worktree 真实文件)复用,语义不能盲换,需拆独立 prop——留待用户拍板后另立任务。

## 三端说明(§4.7)

- **桌面 GUI(macOS WebKit)**:修复前 ✕ 本就可用(WebKit 不夺焦点),修复后 `preventDefault` 无副作用;`bun test --isolate` 510/0 覆盖组件行为面。
- **远程浏览器(Chromium 系)**:修复前 ✕ 必坏(本卡修复的主目标);修复后 mousedown 默认被取消、焦点留在 input、click 正常落地。
- **PWA(≤768/触屏)**:✕ 经既有 `.tree-acts{opacity:.6}`(index.css:3170)常显可点,`stopPropagation` 防误回填;触屏 tap 不夺焦点,无 blur 路径;历史行无 draggable、无 hover 依赖交互。
- 后端/binding 零改动,无统一验证项。真 webview 视觉冒烟维持 coder 构造论证 + merge 前 §5.6 常规冒烟建议。

## 改动文件(本卡复审产出)

| 文件 | 内容 |
|---|---|
| `frontend/src/components/FilePanel.tsx` | ✕ `onMouseDown` 补 `preventDefault` + 注释更新(唯一代码改动) |
| `frontend/src/components/FilePanel.search-history.mount.test.tsx` | 回填/单删两用例加 cancelable mousedown `defaultPrevented` 机制断言 |
| `docs/worklog/2026-08-31-review-28442-file-search-history-167.md` | 本条 |

## OPEN / 下一步

1. git 项目键域 per-worktree(见上,待拍板另立任务)。
2. merge 前按 §5.6 跑一轮三端常规冒烟(真 webview 视觉面)。
