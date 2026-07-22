# 2026-07-23 review:ThoughtBlock 展开内容限高滚动 + streaming 自动滚到底端到端验收(Task #22110)

> 复审对象:#22107 / #22108 commit `3aebd6c` feat(chat):ThoughtBlock 展开内容限高滚动
> + streaming 自动滚到底(已 rebase 落 main,见 #22109 worklog)。

## 结论:PASS

两条验收标准都**真改了行为**(非签名/类型补丁),gate 全绿,实现 KISS 且自洽。

## 验收标准逐条核对

### 1. 展开后内容限高滚动 ✅
- `frontend/src/index.css:602`:`.thought-text` 加 `max-height: 360px; overflow-y: auto;`,
  长思考在块内自滚动,外部对话列表不再被撑开。**真改了布局约束**,不是空补丁。
- 与折叠动画互不干扰:外层 `.collapse-body.open { max-height: 4000px }`(index.css:1216)
  负责展开/收起过渡,内层 `.thought-text` 负责自身滚动;两套 max-height 独立,
  4000 ≫ 360,cap 永不被外层动画裁切。
- 父级 `.collapse-body { overflow: hidden }`(index.css:1215)**不破坏**子级滚动——
  `.thought-text` 的 `overflow-y: auto` 建立自己的滚动上下文,内部自滚正常。
- 滚动条全局隐藏(`* { scrollbar-width: none }`,index.css:1211,macOS overlay 风格),
  trackpad/滚轮仍可滚——与本应用既有设计语言一致,非本次引入。

### 2. streaming 自动滚到底 ✅
- `frontend/src/components/ChatView.tsx:737`:`textRef` 挂到 `.thought-text`(line 756)。
- `useEffect`(740-744):仅当 `open && item.streaming` 时 `el.scrollTop = el.scrollHeight`,
  依赖 `[open, item.streaming, item.text]`——
  - 文本增长(流式追加)→ effect 重跑 → 贴底;
  - 折叠→展开瞬间(streaming 中点开)→ `open` 翻 true → effect 重跑 → 立即贴底
    (`everOpenedRef.current` 在 render 时已置 true,`.thought-text` 已挂载,ref 安全)。
  - 非流式/折叠态 early-return,零副作用。
- `useEffect`/`useRef` 已在 line 1 正确 import,无新增类型错误。
- **真改了 DOM 行为**(`scrollTop` 赋值接到了真实 ref + 真实依赖),非空补丁。

## Reject 标准核对(均未触发)
- ✅ 非签名/类型补丁:两处都是真实行为改动(CSS 约束 + DOM 滚动副作用)。
- ✅ Gate 全绿(见下)。
- ✅ 无空测试:本次未加单测——这是 CSS + DOM-scroll-effect 行为,jsdom 无法算真实
  `scrollHeight`(无真实布局),单测无意义;worklog 已正确地移交人工 E2E 实测,
  与本项目测试策略一致(逻辑走单测,UI 交互走实机/server 模式)。非 reject 项。

## Gate(本人在工作树重跑)
- `wails3 generate bindings` + `bun install` + `bun run build`(tsc + vite production)
  ✅(仅既有 chunk-size > 500kB 提示,非错误)。bindings/dist 不入库(`git status` 干净)。
- `go build ./...` ✅(仅 macOS SDK 版本号 `ld: warning`,非错误)。
- `go vet ./...` ✅(干净)。
- `go test ./...` ✅(全包绿:acp/chat/config/fsview/harness/permissions/store/terminal/titlegen/ui/update/worktree)。

## 次要备注(可选,非阻塞)
- streaming 贴底会覆盖用户在 `.thought-text` 内的手动上滚——下一段文本仍把视图拽回底端。
  对于「转瞬即逝的流式思考块」这符合显式 spec(「自动滚到底」),可接受;未来若想更精致,
  可加「仅当用户已在底部附近时才贴底」的 stick-to-bottom 守卫,但本次不要求。
- 虚拟化交互:`max-height: 360px` 反而**利好**消息列表虚拟化的高度模型——思考块对行高
  的贡献被限定上限,expand/collapse 引起的高度变化更可控,无冲突。

## 下一步
- 桌面 app 实机 E2E(streaming 中展开思考块看贴底跟随、>360px 看块内滚动、外部列表不撑开)
  仍是 worklog 既记的 OPEN,非本验收阻塞项;建议在 WebKit(Wails3 macOS)优先跑一轮。

## 改了哪些文件
- 本条 worklog(单独 docs commit,记录验收结论)。
