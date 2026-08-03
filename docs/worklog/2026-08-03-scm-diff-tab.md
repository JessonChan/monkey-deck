# Source Control 文件点击从下拉展开改为中间列 diff tab

**起因**:用户反馈两个问题——
1. 「打开一个文件看不到 diff」;
2. 要把 source control(GitPanel)里点文件,从原来的「下拉内联展开」改成
   像 EditToolCard 那样在中间列用 tab 打开 diff。

**根因(为什么打开文件看不到 diff)**:从文件树 / 工具卡片点路径 →
`App.openFileTab(path)` → 中间列渲染 `EditorPane`,而 EditorPane 只加载文件
**完整内容**(`SessionReadFile` + CodeViewer 语法高亮),它根本不是 diff 视图。
真正的 diff 只存在于两处——GitPanel 里那个局促的**内联下拉展开**(`GitFileDiffBody`),
和对话流里 EditToolCard 的内嵌 DiffView。所以「打开文件」(看内容)和「看 diff」
是两条互不相通的路径。用户点文件树看到的是纯内容,自然「看不到 diff」。

**改法**:把 GitPanel 的内联下拉展开废掉,点文件 → 在中间列开一个 **diff tab**,
复用 `DiffView`(react-diff-viewer-continued 真 LCS diff,同 EditToolCard),获得
完整中间列宽度。文件树点文件**仍走内容 tab**——对齐 VS Code:资源管理器看内容、
SCM 看改动。

核心是给文件 tab 系统引入「内容 / diff」两类身份:

1. **`FileTab` 类型扩展**(`components/FileTabBar.tsx`):加 `kind: "file" | "diff"`
   + `staged?: boolean`(diff 专用)。新增 export `tabKey(tab)` —— tab 的唯一身份:
   file → `file:<path>`、diff → `diff:s:<path>` / `diff:u:<path>`。**同一 path
   可同时作为内容 tab + staged diff + unstaged diff 三个独立 tab 共存**(§5.3 找
   不变量:身份靠稳定 key 而非 path)。diff tab 用 GitCompare 图标,staged 绿 /
   unstaged 灰区分。

2. **新组件 `components/DiffPane.tsx`**:中间列 diff tab 的内容。加载
   `SessionFileDiff(sessionId, path, staged)`(返回 unified patch)→ `unifiedToOldNew`
   还原 old/new → `DiffView` 渲染。toolbar 复用 `.editor-toolbar`:GitCompare 图标 +
   路径 + staged/unstaged 徽标 + +N/−N 统计 + 关闭按钮。loading/error/empty 三态
   对齐 EditorPane。

3. **`GitPanel.tsx` 瘦身**:删除内联 diff 全套(`diffKey`/`diffText`/`diffLoading`
   state、`toggleDiff`、`GitFileDiffBody`、`DiffView`/`countDiffLines`/
   `unifiedToOldNew` import)。`onDiff` prop 换成 `onOpenDiff(path, staged)`。文件名
   按钮 onClick → `onOpenDiff(f.path, f.staged)`,不再就地展开。净删约 60 行。

4. **`SidePanel.tsx`**:`onDiff` 透传换成 `onOpenDiff`。

5. **`App.tsx` 接线**:
   - `openFileTab`:创建 tab 标 `kind:"file"`;existing 判断从 `t.path===path` 改为
     `t.kind==="file" && t.path===path`(不误命中 diff tab)。
   - 新增 `openDiffTab(sessionId, path, staged)`:建 `kind:"diff"` tab + 激活;已存在
     则仅激活(去重)。
   - `closeFileTab`:参数语义从 `path` 改为 `key`(按 `tabKey(t)` 过滤)。
   - 中间列渲染:从 `activeFileTab !== "chat" → EditorPane` 改为 IIFE 查 active tab
     对象,`kind==="diff"` 渲染 `DiffPane`,否则 `EditorPane`。
   - SidePanel 调用:`onDiff={fileDiff}` → `onOpenDiff={(path,staged) => ...openDiffTab}`。
   - 删除已无引用的 `fileDiff` callback(原仅传给 GitPanel.onDiff)。

6. **CSS**(`index.css`):新增 `.diff-pane*`(镜像 `.editor-pane` 高度链:flex 列 +
   toolbar 固定 + `.diff-pane-body` flex 填充) + `.diff-pane-scope` 徽标配色;
   `.diff-pane-body .diff-view*` 去掉 DiffView 卡片边框/背景并让滚动区跟 flex 高度
   (内联 maxHeight 用 `!important` 覆盖)。diff tab 图标按 scope 着色。

7. **i18n**:新增 `diffPane.{staged,unstaged}`(en + zh)。

**改了哪些文件**:

- 改:`frontend/src/components/FileTabBar.tsx`(FileTab 加 kind/staged + tabKey + diff tab 渲染)
- 新增:`frontend/src/components/DiffPane.tsx`
- 改:`frontend/src/components/GitPanel.tsx`(删内联 diff,onDiff→onOpenDiff)
- 改:`frontend/src/components/SidePanel.tsx`(透传 onOpenDiff)
- 改:`frontend/src/App.tsx`(openFileTab/openDiffTab/closeFileTab + 中间列渲染 + 删 fileDiff)
- 改:`frontend/src/index.css`(.diff-pane* + diff-tab 图标)
- 改:`frontend/src/i18n/locales/{en,zh}.json`(diffPane 命名空间)
- 改:`frontend/src/components/FileTabBar.test.tsx`(适配 kind/tabKey/testid + 新增 diff tab
  distinct-identity 测试)

**验证**:

- `npx tsc --noEmit`:0 错误。
- `bun test src/components/FileTabBar.test.tsx src/components/DiffView.test.tsx`:12/12 通过。
- `bun test`(全量):170 pass-equiv / **29 fail 全部 pre-existing**(stash 基线确认:
  改动前 169 测试 / 29 fail,分布 ChatView.virtual / HarnessPane / SettingsPanel /
  NewSessionModal / QueuePanel / msg-meta,与本改动无关)。pass 140→141(+1 diff tab
  测试)。**零回归**。
- `bun run build:dev`:构建成功(311ms)。

**下一步 / 风险点**:

1. **DiffPane 高度链 dev 实测**:`.diff-pane-body .diff-view-body { max-height: none
   !important }` + flex 链是否在 macOS WebKit 下让 DiffView 撑满中间列(虚拟化
   `infiniteLoading.containerHeight:"100%"` 依赖父链确定高度)。CSS 用标准 flex +
   !important,风险低,但 dev 起来需一眼确认大 diff 不塌缩。
2. **Web Worker**:延续 diff-viewer-upgrade 的风险点,DDiffView `disableWorker:false`
   尚未在 Wails3 webview 实测;若 Worker 加载失败需 `disableWorker:true` 降级。
3. **未清理的 `sessionDiff` dead prop**:ChatView 的 `sessionDiff` 仍空挂(全量 session
   diff 拆按文件走 GitPanel/现在 diff tab),本次未处理,超出范围。

---

## 代码审查修复(4 路 reviewer 并行审查后)

对全部未提交改动(diff-viewer-upgrade + editor-tabs + scm-diff-tab 三批叠加)做 4 路并行
审查,verdict 汇总后修复以下问题:

**bug 级(必修)**:
1. **[major] `lib/unified.ts` 把 `\ No newline at end of file` 当上下文**:jsdiff parsePatch
   把该标记原样留在 hunk.lines,else 分支 push 到 old+new 两侧 → 无尾换行文件(极常见)的
   diff 多一行假文本。修:mark=0x5c(`\`)时 continue 跳过。配回归测试。
2. **[major] `lib/lang.ts` passthrough 写反 → go/py/rust/js/ts 全无高亮**:`return mapped`
   对未列入 HLJS_TO_REFRACTOR 的语言返 undefined(仅 dockerfile/xml/tsx/jsx/sass 5 种生效)。
   修:`hl in HLJS_TO_REFRACTOR` 显式映射/drop,否则 passthrough hljs 名。配 lang.test.ts。
3. **[major] ChatView `apply_patch` 非 unified 格式(`*** Begin Patch`)静默空白**:parsePatch
   对 `***` 格式返空 hunks → recon 空 → 卡片体空白(连 patch 原文都不展示)。修:recon 空时
   把 patch 原文当 plain 兜底展示。
4. **[major] `diff` 包未显式声明**:unified.ts 直接 import parsePatch from "diff",但
   package.json 无 `diff`(仅 rdc 传递依赖)→ 升级即断。修:`bun add diff@^9.0.0`。
5. **[minor] EditorPane 初始 loading=false 闪烁空 viewer**:首帧渲染空 CodeViewer 再翻
   Loading。修:useState(true)(对齐 DiffPane)。

**清理**:
6. **[minor] 死 CSS**:`.git-diff-body`/`.git-diff-stat-row`/`.git-file-diff-wrap`/
   `.git-file-diff-msg`(GitFileDiffBody/inline-diff 删除后无引用)→ 删。
7. **[minor] `lib/unified.ts` isCreate/isDelete 恒 undefined**:jsdiff StructuredPatch 无
   此字段,误导契约,无 caller → 删接口字段 + return。
8. **[nit] GitPanel.row keyPrefix 冗余**:inline-diff 删后 key 只作 React key,staged/unstaged
   分属不同 Group(兄弟列表不冲突)→ 简化为 key={f.path}。
9. **[nit] 注释**:App activeFileTab 注释(现在是 tabKey)、EditorPane 缓存机制注释(无 cache,
   靠 mounted + effect deps)、ChatView extractEditParts 中文转英文(§3.7)、onCloseFile 参数名。

**审查排除的假警报(已验证安全)**:DiffView `disableWorker:false`(Blob URL 内联 WORKER_CODE +
4 层 sync fallback,Wails3 安全);`!important` 不泄漏(后代选择器,ChatView 的 DiffView 不在
.diff-pane-body 内);FilePreviewOverlay 删除零残留;协议署名(rdc MIT + diff BSD-3)已登记。

**验证**:tsc 0 错误;全量 `bun test` 174 测试 / 29 pre-existing fail / **零新增失败**
(pass 141→145);`build:dev` 成功。
