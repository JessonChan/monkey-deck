# 2026-07-14 ChatView 用户长消息气泡折叠 + 内容类型区分

## 起因
ChatView 里用户发的长消息(粘贴的日志 / 代码 / 大段文本)直接以 `.bubble-user` 单段
`pre-wrap` 文本铺开,长内容撑爆对话区、挤掉上下文;且代码 / 日志 / 散文无差别渲染,
代码没有等宽块感、日志也没有紧凑观感。需要:长文本默认折叠(首尾若干行 + 中间省略)、
区分内容类型(代码块等宽 + 现成高亮感、纯日志/文本可读换行、避免无差别 `<pre>` 横向溢出)、
折叠态限高 / 展开可滚动、保持用户与 agent 气泡视觉区分。仅前端,不引新依赖。

## 设计取舍
- **复用 Composer 长文本折叠形态**(已验证的交互):阈值双重判定(`行>8 || 字符>480`)、
  折叠预览 = 首 4 行 + 「⋯ N 行已折叠(点击展开)⋯」分隔条 + 末 2 行(行多);
  行少但字符超长 → 全部行逐行 ellipsis + 「X 字符 · 长行已截断」。预览块整体可点 + 分隔条可点
  + 顶部 meta row 的「展开/收起」toggle(ChevronDown/ChevronUp)三处都能展开/收起。
- **长文本默认折叠**(`useState(isLong)` 初值);每条用户消息独立折叠态(ChatRow 按 `item.id`
  键控,UserBubble 随消息挂载/卸载,状态互不污染)。短文本无折叠态,行为不变。
- **内容类型三分**(`renderKind`),不靠无差别 `<pre>` 横向溢出:
  1. `markdown`:文本含 ``` 围栏 → 走 ReactMarkdown,复用 agent 气泡的 `CodeRenderer/PreRenderer`
     → `CodeBox`(等宽 + 深色块 + 语言标签,「现成方案」,块内 `overflow-x:auto` 局部横向滚动,
     不撑爆气泡)。即「代码块等宽字体 + 基础高亮感」。
  2. `mono`:无围栏但具备代码/日志特征(`looksLikeCodeOrLog` 启发式)→ `.bubble-user-mono`,
     `white-space: pre-wrap; word-break: break-word` + 等宽字体,**换行不横向溢出**。
  3. `prose`:普通散文 → `.bubble-user-prose`,`pre-wrap` 可读换行,与原行为一致。
- **折叠预览统一用等宽紧凑块**(不分 renderKind):预览本质是 TUI 风格「窥视」,等宽 + 逐行
  ellipsis 最紧凑;展开后才按 renderKind 渲染真实内容。这样折叠/展开间没有割裂感(预览恒等宽)。
- **展开限高可滚动**:`.bubble-user-long.is-expanded .bubble-user-body { max-height:400px;
  overflow-y:auto; overscroll-behavior:contain }` —— 展开后不撑爆对话区且可滚;折叠态预览本就紧凑。
- **视觉区分保留**:用户气泡仍是 `--sel-accent` 蓝底右对齐 + 异形圆角;agent 气泡不动。
- **可测试性**(§4.2):meta row / toggle / preview 各带 `data-testid`(`user-msg-meta`/
  `user-msg-toggle`/`user-msg-preview`);preview 块 `role=button` + 键盘 Enter/Space 可展开。
- **tooltip**(§4.5):toggle 用 `react-tooltip`(`data-tooltip-id="md-tip"`),不用原生 title。
- `looksLikeCodeOrLog` 启发式偏保守:非空行里缩进行 / 日志时间戳行 / 代码关键字行 / 超长无标点行
  占比 ≥ 40% 才判技术文本;判定错也无害(仅字体差异)。行 < 4 直接 false。

## 改了哪些文件
- `frontend/src/components/ChatView.tsx`:
  - import 补 `useMemo`(及 lucide 的 `ChevronDown`/`ChevronUp`)。
  - `ChatRow` 的 user 分支:把 `<div className="bubble-user">{item.text}</div>` 换成 `<UserBubble text={item.text} />`。
  - 新增 `UserBubble` 组件 + 阈值常量(`USER_LONG_LINES/CHARS/HEAD/TAIL`)、`looksLikeCodeOrLog`
    启发式。复用既有 `ReactMarkdown`/`CodeRenderer`/`PreRenderer`。
- `frontend/src/index.css`:`.bubble-user-long` / `-meta` / `-count` / `-toggle` / `-preview`(pre/line/divider)
  / `-body` / `-markdown` / `-mono` / `-prose` 样式;`.bubble-user-long.is-expanded .bubble-user-body`
  限高滚动。预览块用蓝调虚线边框(贴合用户气泡 accent),区别于 Composer 的中性虚线。

## 验证
- `wails3 generate bindings`(bindings 不入库)后 `cd frontend && bun run build`(tsc + vite production)通过,
  无类型/编译错误(无 lint 脚本,build 即 TS 门)。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿(无 Go 改动,纯回归;
  `ld: warning` 为 macOS SDK 版本链接警告,与本次改动无关)。
- `git status`:仅 `ChatView.tsx` / `index.css` 两个源文件;bindings/dist/node_modules 均被 gitignore;
  AGENTS.md / RAK 运行时文件未动;误产出的 `frontend/frontend/` 临时目录已清理。

## 下一步
- 手动在 wails3 dev 验证:粘贴长日志/代码立即折叠预览;展开限高可滚;短代码围栏走 CodeBox;
  散文长文本折叠/展开;toggle + 分隔条 + 整块点击均可展开;用户/agent 气泡视觉区分不变。
- 可选增强:`looksLikeCodeOrLog` 阈值/规则按实际误判调;折叠阈值提到配置;折叠态支持复制全文
  (现 MessageActions 已复制全文,折叠态也可见)。
