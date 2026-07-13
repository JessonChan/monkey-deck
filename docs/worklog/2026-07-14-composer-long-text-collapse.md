# Composer 长文本折叠为 TUI 风格紧凑块

## 起因
输入框(Composer)粘贴大段文本 / 恢复长草稿时,textarea 自动撑高(`max-height:220px`)
仍占用过多纵向空间,挤压对话视图。希望长文本默认折叠成 TUI 风格紧凑块(首尾若干行 +
中间省略),需要时再展开查看/编辑全文,提交内容不受影响。

## 设计取舍
- **折叠仅为展示态,提交内容不变**:`value` 由父组件持有,折叠时 textarea 不渲染、
  改渲染只读预览;`submit()` 始终用完整 `value`,折叠态点发送照常提交全文。
- **阈值双重判定**:`行数 > 8 || 字符 > 480` 即判定为长文本。行数覆盖「多行代码/日志」,
  字符覆盖「单/双行长文本」(行少但超长)。
- **预览分两种形态**(`preview` useMemo):
  1. 行多(`> HEAD+TAIL=6`):首 4 行 + 「⋯ N 行已折叠 ⋯」分隔条 + 末 2 行。
  2. 行少但字符超长:展示全部(≤6)行,每行 CSS `text-overflow:ellipsis` 截断,分隔条提示
     「{len} 字符 · 长行已截断」。
- **何时自动折叠**(避免打扰手打):
  - 长文本 + textarea 非聚焦(草稿恢复 / 外部回填)→ effect 自动折。
  - **粘贴**:聚焦态下 effect 不会折(聚焦中),故 `onPaste` 显式计算粘贴后文本长度,
    超阈值则 `rAF` 后折叠(覆盖「粘贴」需求)。
  - 手打跨越阈值时聚焦中 → 不折,不打断输入。
- **展开/收起交互**:
  - 折叠块整体可点 + 中间分隔条可点 → 展开(展开后 `rAF` 聚焦 textarea、光标置尾、autoGrow)。
  - 输入区顶部 `.composer-meta-row`(仅长文本出现):左侧「{行} 行 · {字符} 字符」计数,
    右侧「展开/收起」toggle(`ChevronDown/ChevronUp`)。
  - toggle 与分隔条均 `onMouseDown preventDefault`,防点击时 textarea 失焦抖动。
- **展开可滚动**:展开后即原 textarea(`max-height:220px`、原生滚动),满足「展开可滚动查看全文」。
- 不引入新依赖,纯 React + CSS。

## 改了哪些文件
- `frontend/src/components/Composer.tsx`:
  - 新增阈值常量 `LONG_LINE_THRESHOLD/LONG_CHAR_THRESHOLD/COLLAPSE_HEAD_LINES/COLLAPSE_TAIL_LINES`。
  - `isLong`(useMemo)、`collapsed`(useState)、`preview`(useMemo)。
  - 自动折叠 effect(`isLong` 变化时);`expandInput/collapseInput`;textarea `onPaste` 显式折叠。
  - `autoGrow` effect deps 加 `collapsed`(展开挂载后重新计高)。
  - 渲染:长文本时多出 `.composer-meta-row`;`isLong && collapsed && preview` 时渲染
    `.composer-collapse`(首尾 pre + 可点分隔条)替代 textarea,否则渲染 textarea。
  - import 补 `ChevronUp`。
- `frontend/src/index.css`:`.composer-meta-row/-count/-toggle`、`.composer-collapse/-pre/-line/-divider`
  样式(虚线边框、mono 字体、分隔条 hover 高亮,贴近 TUI 块观感)。

## 验证
- `wails3 generate bindings`(bindings 不入库)后 `cd frontend && bun run build`(tsc + vite production)通过,
  无类型/编译错误。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿(无 Go 改动,仅回归)。
- `git status` 仅 `Composer.tsx` / `index.css` 两个源文件改动;bindings/dist/node_modules 均被 gitignore;
  AGENTS.md / RAK 运行时文件未动。

## 下一步
- 手动在 wails3 dev 验证:粘贴长文本立即折叠;草稿恢复折叠;展开聚焦可编辑、可滚动;
  折叠态点发送提交全文;toggle 与分隔条均可展开;单/双行长文本预览不重复。
- 可选增强:阈值/首尾行数提到配置;折叠态支持 ↑↓ 翻历史(目前折叠需先展开)。
