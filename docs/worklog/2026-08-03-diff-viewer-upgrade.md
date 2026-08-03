# diff 渲染升级:react-diff-viewer-continued 取代手写 +/- 染色

**起因**:用户问「原型 demo 里还有代码比对,这一版是故意不做的吗?」。
澄清事实后(原型 demo 里其实没有 diff 视图,只有只读代码预览 + 行高亮——与
editor-tabs 那版实现一致),用户确认要把 diff 也升级。这是独立于 editor-tabs 的
一个工作项。

**根因(旧实现的局限)**:`lib/diff.ts` 只有 23 行的 `diffLineCls`——
**按首字符 `+/-/@@` 给 CSS class,没有真正的 diff 算法**。没有行对齐、
没有 word-diff、没有 split/unified 切换、没有虚拟化。git 大文件 diff 会卡,
apply_patch 的增删也没法呈现「真对比」。这是最该上成熟库的地方。

**调研结论(§5.3 成熟库优先 + §4.6 轻量/跨平台一致)**:

| 能力 | 选型 | 理由 |
|---|---|---|
| 只读语法高亮 | **highlight.js 11.11(保留)** | 事实标准(周下载 918 万),已在用,纯 JS 无 WASM |
| **差异对比** | **`react-diff-viewer-continued`(新增)** | 真 LCS diff、split/unified、word-diff、内置虚拟化(`infiniteLoading`)、可选 Web Worker、JSON/YAML 结构化 diff、`highlightLanguage` 懒加载 Prism 语法高亮。~50KB gz,纯 DOM 无 canvas/WASM |

排除项:Monaco(2.4-5MB,可编辑引擎对只读场景是杀鸡用牛刀,违反 §4.6)、
CodeMirror(同上)、Shiki(慢 7x + 拖 WASM)、diff2html(非 React 原生、无虚拟化)、
react-diff-view(太底层要自己写渲染)。

**不引入编辑功能**:用户明确「暂时不引入编辑功能」。monkey-deck 定位是驱动
agent 改代码(走 ACP),不是替用户在 GUI 里手敲——GUI 内置编辑器违反 §0 定位 +
§1.1 纯 ACP + §1.4 worktree 隔离。

**改法**:

1. **新组件 `frontend/src/components/DiffView.tsx`**:封装
   `react-diff-viewer-continued`。props:`{ oldStr, newStr, filename, defaultSplit, ... }`。
   工具条:split/unified 切换 + 复制新内容。`highlightLanguage` 接
   `detectDiffLanguage`(`lib/lang.ts`,把 highlight.js 语言名映射到 refractor 支持集)。
   `disableWorker:false`(主路径);若 Wails3 webview 下 Worker 加载失败,降级开关已有。

2. **新 lib `frontend/src/lib/unified.ts`**:用 `diff` 包的 `parsePatch` 把
   unified diff 文本还原成 old/new 两段字符串喂给 DiffView。重建规则:
   context 行 → 两侧都有;`-` 行 → old;`+` 行 → new。单文件多 hunk 按序合并。
   不填 hunk 外的行(DiffView 的 `showDiffOnly` 已折叠未改动上下文,只显示改动区是
   诚实表示)。

3. **新 lib `frontend/src/lib/lang.ts`**:`detectDiffLanguage(filename)`——
   highlight.js 语言名 → refractor canonical key 映射(如 `dockerfile→bash`、
   `tsx→typescript`、不支持的语言返 undefined,DiffView 退纯 diff 无语法高亮)。

4. **GitPanel 接线**:`GitPanel.tsx` 文件 diff 展开(`GitFileDiffBody`)从
   `CollapsibleText + diffLineCls` 染色改为 `DiffView`(unified→split 还原)。
   `+N -M` 徽标保留(用 `countDiffLines` 统计)。解析失败/二进制 → 回退原始文本。

5. **ChatView 编辑卡片接线**:`extractEditParts` 重构——不再自构
   `buildPlusMinusDiff` 文本,直接返回 `{ oldStr, newStr, kind }`:
   - edit(old_string→new_string):直接喂两段给 DiffView 做 LCS diff。
   - apply_patch(patch):`unifiedToOldNew` 还原 old/new。
   - write_file(只有 content):纯内容展示(无 diff)。
   `EditToolCard` 的 diff 区块用 `DiffView`(`defaultSplit=false`,编辑卡片默认
   unified 视图更紧凑)。

6. **删代码(净减,§5.3 Less is More)**:
   - `lib/diff.ts` 删 `diffLineCls`(按行染色,已无调用方);保留 `countDiffLines`
     (统计 +N/-M 用)。
   - `ChatView.tsx` 删 `buildPlusMinusDiff`(自构 -/+ 文本,被 DiffView 取代)。
   - GitPanel/ChatView 的 `CollapsibleText + diffLineCls` diff 渲染全删。

7. **CSS(`index.css`)**:新增 `.diff-view/.diff-view-bar/.diff-view-btn/.diff-view-body`
   + `.git-diff-body/.git-diff-stat-row`;`.diff-view-body pre` 字号对齐 app 代码密度。
   删旧 `.git-diff-pre` 注释里「CollapsibleText 染色」描述。

8. **i18n**:新增 `diff.{split,unified,switchToSplit,switchToUnified,copy,copied,copyNew}`
   (en + zh)。

9. **协议署名(§0.4)**:`THIRD_PARTY_LICENSES.md` 新增 §3.1「前端关键依赖(npm)」,
   登记 `react-diff-viewer-continued`(MIT)+ `diff`(BSD-3-Clause,传递依赖,直接 import
   `parsePatch`)。

**改了哪些文件**:

- 新增:`frontend/src/components/DiffView.tsx`
- 新增:`frontend/src/components/DiffView.test.tsx`(7 测试:unifiedToOldNew 5 +
  DiffView mount 2)
- 新增:`frontend/src/lib/unified.ts`
- 新增:`frontend/src/lib/lang.ts`
- 改:`frontend/src/components/GitPanel.tsx`(CollapsibleText→DiffView + 新 GitFileDiffBody)
- 改:`frontend/src/components/ChatView.tsx`(extractEditParts 重构 + EditToolCard 用 DiffView
  + 删 buildPlusMinusDiff + import 调整)
- 改:`frontend/src/lib/diff.ts`(删 diffLineCls,保留 countDiffLines;注释转英文 §3.7)
- 改:`frontend/src/index.css`(新增 .diff-view* + .git-diff-body*;更新 .git-diff-pre 注释)
- 改:`frontend/src/i18n/locales/{en,zh}.json`(新增 diff 命名空间)
- 改:`frontend/package.json`(新增 react-diff-viewer-continued 依赖)
- 改:`THIRD_PARTY_LICENSES.md`(§3.1 前端依赖登记)

**验证**:

- `npx tsc --noEmit`:通过(0 错误)。
- `bun run build:dev`:构建成功(943ms)。
- `bun test src/components/DiffView.test.tsx`:7/7 通过。
- `bun test`(全量):140 pass / 29 fail——**29 个 fail 全部是 pre-existing**
  (stash 基线确认:未改动分支同样 169 测试 / 29 fail,分布在 ChatView.virtual /
  HarnessPane / NewSessionModal / QueuePanel / msg-meta 等与本改动无关的模块)。
  pass 数 133→140 仅因新增的 7 个 DiffView 测试。**零回归**。

**下一步 / 风险点(实现时盯,非阻塞)**:

1. **Web Worker 在 Wails3 webview + Vite 下的加载**:本次 `disableWorker:false`
   走主路径,尚未在 dev 桌面实测 Worker 是否正常加载。若不行,改 `disableWorker:true`
   退同步(库已提供开关,降级路径明确,§5.3)。**dev 起来后优先验证这点**。
2. **大 diff 虚拟化实测**:`infiniteLoading` 的 `containerHeight: '100%'` 在 flex
   父容器里要确认高度链通到组件。`.diff-view-body` 已设 `overflow:auto`,应在
   GitPanel/ChatView 的实际容器里实测大文件(如 5000+ 行 diff)不卡。
3. **Prism 语法高亮 vs highlight.js 一致性**:两套高亮引擎共存(highlight.js 给
   CodeViewer 普通预览,Prism 给 DiffView diff 预览)。同文件在两种视图下配色可能
   略有差异——可接受(两者都是成熟主题),长期若视觉割裂明显,可统一到一套
   (届时评估 Shiki 或 renderContent 接 highlight.js)。
4. **未做的 sessionDiff 全量视图**:ChatView 的 `sessionDiff` prop 当前**未被渲染**
   (全量 session diff 走 GitPanel 按文件分开展示)。本次未处理这个 dead prop——
   超出 diff 升级范围,留作独立清理项。
