# Composer 复制后无法输入(根因定位 + 防御性修复 + 复现测试)

## 起因 / 现象
用户反馈:在 Composer(输入框)粘贴文本后,输入框变得「无法输入」—— 键盘敲字没反应。
即 Task #21328「Composer 复制后无法输入」。

## 根因定位
定位到 `frontend/src/components/Composer.tsx` 的 `onPaste` 处理器(`529-557` 旧版)。

长文本折叠特性(`docs/worklog/2026-07-14-composer-long-text-collapse.md`):当 `value` 超阈值
(`>8 行 || >480 字符`)即判定为「长」,`isLong && collapsed` 时 textarea **不渲染**、改渲染只读预览块。
两种折叠触发路径:
1. **auto-collapse effect**(只依赖 `isLong` 变化):`document.activeElement !== ref.current` 时才折 ——
   有「聚焦中不打断」守卫。
2. **`onPaste` 显式折叠**:粘贴后 `requestAnimationFrame(() => setCollapsed(true))`。

问题出在 #2。旧逻辑:
```ts
const future = value.slice(0, selStart) + pasted + value.slice(selEnd);
if (future.split("\n").length > LONG_LINE_THRESHOLD || future.length > LONG_CHAR_THRESHOLD) {
  requestAnimationFrame(() => setCollapsed(true));
}
```
**只看「粘贴后的结果(future)是否长」,不看「粘贴前是否已经长」**。

→ 失败场景(本次 bug):用户有一段长草稿(已手动展开 / 聚焦编辑中),在其中粘贴任意文本
(哪怕一个字符、或替换一段选区),`future` 仍长 → `setCollapsed(true)` → **textarea 被从 DOM 移除**、
换成只读预览块 → 用户继续敲键盘,键入无处可去 = **「复制后无法输入」**。

这与 #1 的聚焦守卫自相矛盾,也违反了该特性自己的设计原则「手打跨越阈值时聚焦中 → 不折,不打断输入」
(`docs/worklog/2026-07-14-composer-long-text-collapse.md`)。`onPaste` 是唯一会「在聚焦态强制折叠」的路径,
因此所有「聚焦编辑长文本时粘贴」都会踩中。

## 改法(防御性修复)
`onPaste` 的强制折叠**只覆盖「短 → 长」这一种过渡** —— 即粘贴前不是长文本(`!isLong`),粘贴使之变长。
粘贴前已是长文本(用户多半已展开在编辑)时不再折叠,尊重用户的展开/编辑态:

```ts
if (!isLong && (future.split("\n").length > LONG_LINE_THRESHOLD || future.length > LONG_CHAR_THRESHOLD)) {
  requestAnimationFrame(() => setCollapsed(true));
}
```

为什么是 `!isLong` 而不是「不聚焦才折」:`!isLong` 精确对应「这次粘贴使文本从非长跨入长」的过渡,
恰好是原设计想要的「粘贴大段文本 → 显示紧凑预览」语义(对空/短输入框的首次大段粘贴仍折叠);
而「聚焦编辑中的长文本」(long→long)不再被打断。三种折叠路径改后全部遵循同一原则:
聚焦编辑中不打断 —— auto-collapse effect 的聚焦守卫 + 现在的 `!isLong` 守卫 + 用户显式 toggle。

边界正确性(逐项推演):
- 短 + 粘贴长文本 → `!isLong && futureIsLong` → 折(保留原意图)。
- 长(已展开编辑)+ 粘贴任意 → `!isLong` 为 false → 不折(修复点)。
- 长 + 全选粘贴短文本 → 不折;随后 `value` 变短 → `isLong` 翻 false → effect `setCollapsed(false)`。正确。

## 复现测试
新增 `frontend/src/components/Composer.mount.test.tsx`(happy-dom + React mount,参考 `ModelSelect.mount.test.tsx`
的 mock 模式:thin pass-through radix/cmdk/i18n)。用**真实原生 paste 事件**(`ClipboardEvent + DataTransfer`)
驱动真实 `onPaste`,非手搓:

1. 挂载长草稿(12 行)→ 非聚焦 → auto-collapse → 预览块在、textarea 不在。
2. 点顶部展开 toggle(`composer-collapse-toggle`)→ `expandInput` 经 rAF 聚焦 textarea → textarea 回来。
3. 在 textarea 上 dispatch paste(带短文本)→ flush(等 rAF)。
4. 断言:textarea(`composer-input`)仍在 DOM、预览块不在。

验证「先复现再修」:把 `Composer.tsx` 回退到旧版(stash),该测试**失败**(`expect(...).not.toBeNull()`
Received: null —— textarea 在粘贴后消失);恢复修复后**通过**。这确认测试如实复现了 bug。
全套 `bun test`:`61 pass / 0 fail`(新增 1 条)。

## 改了哪些文件
- `frontend/src/components/Composer.tsx`:`onPaste` 折叠条件加 `!isLong` 守卫 + 更新注释说明原因。
- `frontend/src/components/Composer.mount.test.tsx`(新增):paste-into-long 回归测试。

## 验证
- `cd frontend && bun test`:61 pass / 0 fail(含新增回归测试;旧版复现失败、新版通过)。
- `cd frontend && npm run build`(tsc + vite production):通过,无类型/编译错误。
- Go acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿(无 Go 改动,仅回归)。
- `git status` 仅上述两个前端源文件;bindings(`frontend/bindings/`,本地 `wails3 generate bindings` 生成)/
  dist / node_modules 均 gitignore,未入库。

## 下一步
- 手动 `wails3 dev` 复核:展开长草稿后粘贴短/长文本均不再折叠打断;空输入框粘贴大段文本仍折叠为预览;
  折叠态点发送仍提交全文;toggle/分隔条/预览块均可展开。
- 可选:后续可评估是否把「首次大段粘贴折叠」也改为「失焦才折」,进一步贴近「聚焦中永不打断」,
  但当前 `!isLong` 已足够修掉本次「无法输入」,且保留了大段粘贴即时紧凑预览的体验,本次不动。
