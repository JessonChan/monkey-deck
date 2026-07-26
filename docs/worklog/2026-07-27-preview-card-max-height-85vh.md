# 2026-07-27 .preview-card 加回 max-height: 85vh

## 起因

Task #23432。Task #23063 曾把 `.preview-card`(`frontend/src/index.css`)的
`max-width/max-height` 全部去掉,本意是「让用户能把卡片拖大到接近视口,由
`.preview-overlay` 的 `padding:40px` 自然兜底」。但去掉 `max-height` 后用户可把卡片
拖得**高于视口**:`.preview-overlay` 是 `display:flex; align-items:center` 且**没有
`overflow:hidden`**,卡片高度超过「视口 − padding」时居中布局会把卡片顶部顶出可视区,
`.preview-head`(含关闭按钮)随之不可见 —— 用户拖太大后**找不到关闭按钮**,只能靠点
遮罩关闭,体验回退。

## 改法

加回**只针对高度**的上限 `max-height: 85vh`,宽度仍不限:

- `85vh < 100vh − 80px(padding)` 要求视口高 ≥ ~533px,桌面环境均满足 → 卡片始终落在
  padding 内,顶部 `.preview-head` + 关闭按钮始终可见(本任务核心目标)。
- `resize: both`、`min-width:360px`、`min-height:220px` 全部保留(Task #23063 的可拖大
  与最小尺寸约束不回归);正常视口下 min 值远小于 85vh,不溢出窗口。
- 宽度不加 `max-width`:横向不会顶出关闭按钮(head 在顶部、横向居中),由 padding 自然兜底。

## 改了哪些文件

- `frontend/src/index.css`:`.preview-card` 末尾追加 `max-height: 85vh`;头部注释改写,
  说明为何只限高不限宽 + 关闭按钮可见性结论。
- `docs/worklog/2026-07-27-preview-card-max-height-85vh.md`:本条。

## 验证

- 纯 CSS 单属性追加,无 TS/JSX 改动;worktree 无 `node_modules`,`npm run build` 跑不了,
  但改动不涉类型/编译。
- `go build ./...` / `go vet ./...`:无 Go 改动,无关。

## 下一步

- 实机抽验(`wails3 dev`,macOS WebKit / Win WebView2):把预览卡片往下拖到极限,
  确认 (a) 高度停在 ~85vh、(b) 顶部关闭按钮始终可见、(c) `resize:both` 把手仍可继续
  调整宽高(宽度可继续拖宽)。
