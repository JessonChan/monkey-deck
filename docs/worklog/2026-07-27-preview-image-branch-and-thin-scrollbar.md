# 2026-07-27 前端文件预览图片分流(<img>)+ CodeViewer/图片容器细滚动条

## 起因

Task #23445。Task #23444 已在后端落地 `SessionReadImage`(返回 `ImageData{DataURL, Extension}`),
回 `data:<mime>;base64,<b64>` 直接喂 `<img src>`。前端两处文件预览入口
(`FilePreviewOverlay` 对话路径点击 / `FilePanel` 文件树点击)此前一律走 `SessionReadFile` +
`CodeViewer` 文本管线 —— 对图片就是「二进制 base64 当文本展 / 行号对图片无意义」。
需要分流:图片走 `<img>`,文本仍走 `CodeViewer`;同时这两类长内容容器的滚动条
此前被全局 `* { scrollbar-width: none }` 隐掉(macOS overlay 风格),阅读场景缺方位感。

## 设计

### 1. 图片分流

- **判定:`isImageFile(name)`(utils.ts)** 按扩展名白名单(`png/jpg/jpeg/gif/webp/bmp/svg/ico`),
  与后端 `fsview.extToImageMime` 对齐 —— 后端只对这些扩展名 / 嗅探出 image/* 才会成功,
  前端只对这些走图片分支,其他一律文本(避免后端报「不是图片」白多一次往返)。大小写不敏感。
- **加载分支**:
  - `FilePreviewOverlay`:在 `useEffect(target)` 里按 `isImageFile(target.path)` 二选一
    调 `SessionReadImage`(拿 `dataUrl`)/ `SessionReadFile`(拿文本),分别存进
    `imgUrl` / `content` 两态。
  - `FilePanel.openFile`:把 preview 态改成判别联合 `Preview = { kind: "text" | "image", ... }`,
    按节点名分流 `SessionReadImage` / `SessionReadFile`,失败时退化成 text(显示 readFailed 文案)。
- **渲染分流**:`.preview-card` 主体区,图片渲染 `preview-img-scroll > img.preview-img`,
  文本仍 `<CodeViewer>`。图片隐藏「复制内容」按钮(复制 dataURL 无意义;`FilePreviewOverlay`
  的复制按钮同隐藏)。
- **图片容器 `.preview-img-scroll`**:`flex:1` 占主体,大图居中 + 可滚,深底棋盘格背景
  (透明 PNG / SVG 可见透明区),`img.preview-img` 走 `object-fit: contain` 适配卡片尺寸。

### 2. 细滚动条

- **作用域**:`.cv-scroll`(CodeViewer)+ `.preview-img-scroll`(图片容器)两类长内容阅读区。
  其余面板(树 / 列表 / 设置 / 输入框)仍维持全局隐滚动条,不回归。
- **实现**:类选择器特异性覆盖全局 `*` 与裸 `::-webkit-scrollbar`:
  - `scrollbar-width: thin`(Firefox / 新规范);
  - `::-webkit-scrollbar { width: 8px; height: 8px; display: block }`(WebKit / WebView2),
    `display:block` 显式覆盖全局 `display:none`;
  - thumb 用 `--sep-strong`(半透明白),`border:2px transparent + background-clip:padding-box`
    让 thumb 比 track 窄、留视觉呼吸;hover 加深到 `--text-3`;track 透明不抢对比度。

## 改了哪些文件

- `frontend/src/utils.ts`
  - 新增 `isImageFile(name)` + `IMAGE_EXTS` 集合(白名单与后端对齐)。
- `frontend/src/components/FilePreviewOverlay.tsx`
  - 新增 `imgUrl` 态;加载 `useEffect` 按 `isImageFile` 二选一调 `SessionReadImage` / `SessionReadFile`。
  - 渲染分流:图片走 `.preview-img-scroll > img.preview-img`,并隐藏复制按钮(dataURL 复制无意义)。
- `frontend/src/components/FilePanel.tsx`
  - preview 态改为判别联合 `{ kind: "text" | "image" }`;`openFile` 按节点名分流加载。
  - 预览 modal 渲染分流:`image` 走 `<img>`,`text` 仍 `CodeViewer`;image 隐藏复制按钮。
- `frontend/src/index.css`
  - 新增 `.preview-img-scroll` / `.preview-img` 样式(占主体、棋盘格底、居中、阴影)。
  - 新增 `.cv-scroll, .preview-img-scroll` 的细滚动条规则块(thin / 8px / hover 加深 / display:block
    显式覆盖全局隐滚动条)。
- `docs/worklog/2026-07-27-preview-image-branch-and-thin-scrollbar.md`:本条。

## 验证

```
# 1. bindings 是 wails3 gen bindings 生成的中间产物(gitignored),先重生成
#    以拿到 SessionReadImage + ImageData 的 JS 绑定(.js,无 .d.ts,wails3 alpha 现状)
wails3 generate bindings          # → 2 Services, 73 Methods, 12 Models

# 2. 前端类型 + 构建(本仓库 TS gate 不在 verify cmd 里,需自行跑)
cd frontend && bun install && bun run build    # ✓ built in 751ms,无类型错误

# 3. 现有挂载测试回归
cd frontend && bun run test      # 139 pass / 0 fail,6377 expect() calls

# 4. Go 无改动,无关
```

## 下一步

- 实机抽验(`wails3 dev`,macOS WebKit / Win WebView2):
  - 点开一张透明 PNG / SVG,确认棋盘格背景显出透明区、`<img>` 居中、细滚动条在大图时可见可拖;
  - 切回文本文件,确认 `CodeViewer` 行号 / 高亮 / 虚拟化不回归,细滚动条可见;
  - 非 git / 非 worktree 的纯目录 session 同样适用(cwd 钉在项目目录,SessionReadImage 一致)。
- 若实际使用发现棋盘格在浅色 / 自定义主题下对比不足,可换成更柔和的渐变灰。
- 若遇到 SVG 因 webview 的 CSP / data: 大小限制渲染异常,再单独评估(目前 dataURL 同于 `<img src>` 的常规路径)。
