# #154 二期:重命名标识状态分型——idle 尾位 / prompting 前位(任务 #28431)

日期:2026-08-30 · 基线:rak main=431105b

## 起因

父 issue #28430 四点拍板定版:#154 一期把重命名 Pencil 常驻标题前,但 prompting(turn 进行中)时标题前方正是视线焦点区,低对比铅笔常驻前位反而与状态语义争位;拍板改为**状态分型**:idle 时标识退到标题尾部(meta 簇前),prompting 时保持标题前位常驻(一期现状)。四点:

1. idle 定义 = `statusBySession[s.id] !== "prompting"`(数据现成:Sidebar props `statusBySession` / 行渲染 `const st = props.statusBySession[s.id]`);不随选中态翻转(遵守 must-not-flip-with-selection 先例——判定纯派生自 statusBySession,与 `selectedSessionId` 无关)。
2. idle:Pencil 移标题尾部(meta 簇前),10px / `var(--text-3)` / tooltip `sidebar.renamedTip` 全不变。
3. prompting:保持标题前位常驻(一期现状零改动)。
4. 移动端同规则:状态驱动条件渲染,≤768px 无任何特殊化分支。

## 改法

### 状态分型(frontend/src/components/Sidebar.tsx)

- **单一元素、两个互斥槽位**:`renamedMark` 常量(`labelTip` 旁)按 `s.customTitle` 条件构造一次;prompting 槽 `{active && renamedMark}`(label 前),idle 槽 `{!active && renamedMark}`(label 后、popout/harness/pin/terminal 等元簇前)。同一 React element 描述符复用,节点/size/色/tooltip 两态字面同一,不造第二套表示(§5.3 把多套表示收敛成一套)。
- `active = st === "prompting"` 是既有常量,与拍板 idle 定义恒等(`st !== "prompting"` ⇔ `!active`),undefined / error / reconnecting 全归 idle;零新增状态源、零新分支启发式。
- `renamingId === s.id` 整行换输入框的既有早退路径不受影响(该分支不渲染任何标识)。

### 位置矩阵

| 状态 | 判定 | Pencil 位置 | 行内 DOM 序 | 视觉 |
|---|---|---|---|---|
| prompting | `st === "prompting"` | 标题前(常驻,一期现状) | dot → **pencil** → label → meta 簇 | 10px / `--text-3` / `renamedTip`(不变) |
| idle(含 undefined / error / reconnecting) | `st !== "prompting"` | 标题尾、meta 簇前 | dot → label → **pencil** → popout/harness/pin/terminal/… | 同上,全不变 |

- 尾位落点天然成立:label `flex:1` 撑满主轴,pencil 紧贴 meta 簇左缘,与 pin/terminal 同族同间距(行 gap 7px),**零新增 CSS 声明**——index.css 仅更新 `.session-renamed` 注释块 documenting 状态分型;「全不变」由测试钉死(CSS 契约三声明原样断言)。
- 移动端:纯 DOM 序条件渲染,无断点分支、无 `isRemoteClient()` 分支,≤768px 与桌面同规则(四点之 4 天然满足,无特殊化代码)。

### 测试(frontend/src/components/Sidebar.renamed.mount.test.tsx,3 → 4 条)

1. **idle 尾位 DOM 序钉死**:无 status 条目 → `label.nextElementSibling === mark`;tooltip `md-tip` + `sidebar.renamedTip` + zh/en 真实文案(「用户重命名」/"Renamed by user")照旧。
2. **prompting 前位**:`statusBySession: { s1: "prompting" }` → `label.previousElementSibling === mark`,tooltip 同。
3. **无 custom_title 两态均零节点**:idle / prompting 各 mount 一遍,无 `renamed-<id>`、无 `.session-renamed`。
4. **行高不变两态各验**:renamed+pinned vs 素行 `offsetHeight` 相等(idle 尾位、prompting 前位各一组)+ CSS 家族契约三声明(`flex-shrink: 0` / `display: inline-flex` / `color: var(--text-3)`)钉死。

## 改了哪些文件

- `frontend/src/components/Sidebar.tsx` —— `renamedMark` 单元素 + 双槽位条件渲染(原前位块换位)
- `frontend/src/index.css` —— `.session-renamed` 注释块更新(声明行零改动)
- `frontend/src/components/Sidebar.renamed.mount.test.tsx` —— 4 断言(2 改 1 增 1 扩)
- `docs/worklog/2026-08-30-renamed-state-split-154-2.md` —— 本条

## 验证

- `bun test --isolate`(frontend 全量):**481 pass / 0 fail**(基线 480 + 本套件 +1;本套件 4 条全绿,`locales.test.ts` zh/en parity 不变量保持)。stderr 的 React `maxSize`/`minSize` DOM warning 为 resizable 系组件既有噪音,与本改动无关。
- `bun run build:dev`(tsc + vite development):零错误,✓ built in 372ms。
- Go gate(零 Go 改动,惯例复核):`go build ./...` rc=0、`go vet ./...` rc=0(ld 的 macOS 版本 warning 为本机工具链噪音)。
- 环境前置(同 #154 一期 worklog 所记):新 worktree 需 `bun install`(375 包)+ 仓库根 `wails3 generate bindings`;注意**须在仓库根执行**——在 `frontend/` 子目录里跑会生成到 `frontend/frontend/bindings`(本次实测踩到,已清理重生成)。
- 三端说明(§4.7):纯渲染侧 DOM 序小改,无样式新增、无断点敏感结构、无 `isRemoteClient()` 守卫分支、零后端面;行为面以 mount 四条覆盖。本沙箱无法起 Wails GUI,三端实机冒烟留人工复核(同 #150/#154/#155 先例,见下一步)。

## OPEN / 下一步

- 桌面 GUI(macOS WebKit)目验一次:重命名 session idle 时 Pencil 于标题尾部(meta 簇前)、prompting turn 中回标题前、两态行高与素行一致;远程浏览器 / PWA ≤768px 抽检同规则(预期零分化点)。issue 侧按硬纪律停 completed-ready,不自行关闭。
