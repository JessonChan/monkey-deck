# 文件 / diff 阅读器升级(语法高亮 + 行号 + 彩色 diff + 大文件虚拟化)

## 起因
Task #15088。`FilePanel.openFile` 的预览仍是纯 `<pre>`(无高亮、无行号);
`FilePreviewOverlay` 虽有行号但无高亮;`GitPanel` 的 diff 也是纯 `<pre>`(无染色、
长 diff 不折叠)。三者阅读体验都停留在「等宽裸文本」,与 §4.4(不裸露技术格式 /
给用户可读呈现)及参考形态(openwork)差距明显。

## 设计取舍
- **高亮库:highlight.js(`lib/common`,~40 常用语言)**。项目原本无任何高亮库
  (react-markdown 的 CodeBox 也是纯 `<pre><code>`)。按 §5.3「成熟库优先」+ §4.6
  「轻量 / 跨平台一致」选 highlight.js:纯 JS、同步、无 canvas/GPU 开销,只读高亮的
  事实标准,跨 Win/macOS/Linux webview 渲染一致。`lib/common` 比 full 小很多,够用。
  配色用自带 `github-dark.css`,并在 `hljs-theme.css` 里覆盖 `.hljs` 的块级
  background/padding(它是为独立 `<pre>` 设计,我们按行渲染不需要)。
- **跨行 token 正确性(不变量)**:块注释 / 模板字符串 / 三引号会跨行。若逐行单独
  `highlight` 会断裂(后半段全变注释色)。解法:先对**整段**高亮,再把结果 HTML 按
  `\n` 切成多段,切分时「收口未闭合 span → 推入本行 → 下一行重开同样的 span 栈」,
  保证每行片段都是平衡嵌套(`lib/highlight.ts` `splitHtmlByLine`)。这样多行 token
  颜色在每行正确延续,且行号槽 / 目标行高亮可继续用「逐行 div」的简单结构。
- **行号对齐**:沿用「行号 + 内容同行 flex、共用一个滚动容器」的既有形态
  (与原 `.preview-line` 一致),天然对齐 + 同步滚动,无需 sticky/绝对定位的取巧。
- **大文件虚拟化**:行数 > 2000 时切换为「定高(19px,与 CSS line-height 严格一致)
  + 按 scrollTop 只渲染可视窗口 + 上下 overscan 12 行」,外层用
  `position:relative; height=total*19` 撑出真实滚动条,内层 `position:absolute; top`
  定位窗口。行数少时直接平铺(简单可靠,目标行走 scrollIntoView)。桌面长期驻留,
  避免万行文件一次性渲染卡顿(§4.6)。目标行滚入视野:虚拟化态用像素定位
  `scrollTop=(line-1)*19 - clientH/2`,平铺态用 `scrollIntoView({block:center})`。
- **diff 阅读器复用 CollapsibleText**:把 ChatView 里既有的 `diffLineCls` /
  `countDiffLines` 抽到 `lib/diff.ts`,GitPanel diff 改用 `CollapsibleText` +
  `lineClassName={diffLineCls}` —— 逐行 +/- 染色(+绿 / −红 / @@蓝,与编辑工具卡同套)
  + 长 diff 默认折叠(首尾 + 省略条,复用 J1 折叠件)+ 头部 `+N / −M` 统计。
  「复用已有折叠组件」零新代码路径(§5.3)。
- **统一阅读器组件 `CodeViewer`**:FilePanel 与 FilePreviewOverlay 共用一个
  `CodeViewer`(props:content / filename / language / highlightLine / maxHeight),
  消除两处重复的逐行渲染。FilePreviewOverlay 从「自带逐行 + scrollIntoView」瘦身为
  「加载 + 外壳」,高亮 / 行号 / 目标行 / 虚拟化全交 CodeViewer。
- **零新 Go 改动**:纯前端。语言检测纯前端(扩展名表 + highlightAuto 兜底)。

## 改了哪些文件
- `frontend/package.json` / `frontend/bun.lock`:新增依赖 `highlight.js@^11.11.1`。
- `frontend/src/lib/highlight.ts`(新):`detectLanguage`(扩展名→语言表)、
  `highlightToLines`(整段高亮 + 按行切分平衡 span)、`splitHtmlByLine`、安全降级(失败
  时逐行 HTML 转义,绝不抛错打断渲染)。
- `frontend/src/lib/diff.ts`(新):从 ChatView 抽出的 `diffLineCls` / `countDiffLines`,
  供 ChatView 编辑卡 + GitPanel diff 共用。
- `frontend/src/components/CodeViewer.tsx`(新):语法高亮 + 行号 + 目标行 + 大文件虚拟化
  的统一阅读器。
- `frontend/src/hljs-theme.css`(新):引入 github-dark 配色 + 覆盖 `.hljs` 块级外观。
- `frontend/src/components/FilePanel.tsx`:`openFile` 预览的 `<pre>` 换成 `<CodeViewer>`。
- `frontend/src/components/FilePreviewOverlay.tsx`:逐行渲染 + scrollIntoView 换成
  `<CodeViewer highlightLine={lineNum}>`;删除 targetLineRef 与对应 effect(由 CodeViewer 接管)。
- `frontend/src/components/GitPanel.tsx`:diff 的 `<pre className=git-file-diff>` 换成
  `CollapsibleText` + `diffLineCls` + `+N/−M` 统计 extra。
- `frontend/src/components/ChatView.tsx`:删除本地 `diffLineCls`/`countDiffLines`,
  改 `import from "../lib/diff"`(纯重构,行为不变)。
- `frontend/src/index.css`:
  - 新增 `.cv / .cv-lang / .cv-scroll / .cv-body / .cv-line / .cv-no / .cv-code / .cv-target`
    (CodeViewer;line-height 19px 与虚拟化常量严格一致)。
  - `.git-diff-pre`(放宽 max-height)/ `.git-file-diff-wrap / -msg / .git-diff-stat`;
    删除旧 `.git-file-diff` 块与旧 `.git-diff-pre`(pre-wrap/cursor/click-to-expand,
    为已移除的旧模式服务)。

## 验证
- `make bindings`(bindings 不入库,dev/build 前生成)。
- `cd frontend && bun run build`(tsc + vite production)通过,无类型/编译错误
  (仅预存在 chunk>500kB 警告;highlight.js 令 bundle 略增,桌面应用非网络加载,可接受)。
- `cd frontend && bun run test`:27 pass / 0 fail(streamMerge + filePath 回归)。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./internal/...` 全绿
  (acp/chat/config/fsview/harness/store/terminal/titlegen/ui/update/worktree 全 ok;
  本 task 无 Go 改动,仅回归;`main` 包需 `frontend/dist` 存在,已放 stub,.gitignore 排除)。
- `git status`:仅前端源 + package.json/bun.lock;bindings/dist/node_modules 均被 gitignore;
  AGENTS.md / RAK 运行时文件未动。

## 下一步
- 手动在 wails3 dev 验证:
  - FilePanel 点文件:按扩展名高亮(ts/go/py/json/…)+ 行号对齐 + 横向滚动;
    超大文件(>2000 行)滚动流畅、不卡。
  - 对话里点 `path:line`:FilePreviewOverlay 高亮目标行并滚到视野中央。
  - GitPanel 点文件:diff +/- 染色 + `+N/−M` 统计 + 长 diff 折叠/展开/预览三态一致。
  - 跨平台 webview(macOS WebKit / Win WebView2)下 github-dark 配色一致(§4.6)。
- 后续可选:虚拟化态下「跳转行号」输入框;diff 的双列(老/新)行号对齐(目前单栏 +
  `@@` hunk 头已含行号,够用);CodeBox(对话内代码块)也接入 highlight.js(本次未动,
  避免扩大范围)。
