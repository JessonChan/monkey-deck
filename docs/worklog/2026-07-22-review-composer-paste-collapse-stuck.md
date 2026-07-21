# 2026-07-22 Review #28 Composer 复制后无法输入端到端验收结论(PASS)

## 起因

Task #21329(Review):验收 Task #21328「Composer 复制后无法输入(根因 + 防御性修复 +
复现测试)」的两个 commit:

- `c7084d8` fix(composer): 粘贴入已展开的长草稿不再折叠打断输入
- `ace1aa3` docs(worklog): Composer 复制后无法输入根因+防御性修复+复现测试

重点不是「能否编译」,而是「代码是否真的让『粘贴入已展开长草稿』不再把 textarea 折没」——
拒收「改了签名/类型但函数体行为没变」「测试永远通过不断言真实行为」的空壳改动。

## 改动核对(不只看 diff 表面)

`Composer.tsx` 的 `onPaste` 文本路径(`529-558`),折叠条件加 `!isLong` 守卫:

```ts
// 旧(future 长就折,不看粘贴前是否已长):
if (future.split("\n").length > LONG_LINE_THRESHOLD || future.length > LONG_CHAR_THRESHOLD) {
  requestAnimationFrame(() => setCollapsed(true));
}
// 新(只在「短 → 长」过渡折):
if (!isLong && (future.split("\n").length > LONG_LINE_THRESHOLD || future.length > LONG_CHAR_THRESHOLD)) {
  requestAnimationFrame(() => setCollapsed(true));
}
```

**这是真正的行为变更,非空壳**:核对渲染逻辑 `Composer.tsx:496`
`{isLong && collapsed && preview ? (折叠预览块) : (<textarea>)}` ——
`collapsed && isLong` 时 textarea 根本不渲染。旧逻辑在聚焦编辑一段已展开的长草稿时,
粘贴任意文本(哪怕一个字符、或替换选区)`future` 仍长 → `setCollapsed(true)` → textarea
被移出 DOM → 键入无处可去 = 「复制后无法输入」。新逻辑下 `!isLong`(粘贴前已是长)为
false → 不折 → textarea 留着 → 键入正常。

`isLong`(由受控 `value` 经 `useMemo` 派生)在 onPaste 闭包里取的是**粘贴前**的 value
(此时 onChange 尚未因本次粘贴触发),语义精确对应「这次粘贴使文本从非长跨入长」。
三条折叠路径改后统一遵循同一原则(聚焦编辑中不打断):auto-collapse effect 的聚焦守卫
(`document.activeElement !== ref.current`)+ 现在的 `!isLong` 守卫 + 用户显式 toggle。

逐项推演边界(均正确):
- 短/空 + 粘贴大段文本 → `!isLong && futureIsLong` → 折(保留「首次大段粘贴紧凑预览」原意图)。
- 长(已展开编辑)+ 粘贴任意 → `!isLong` 为 false → 不折(本次修复点)。
- 长 + 全选粘贴短文本 → 不折;随后 value 变短 → `isLong` 翻 false → effect `setCollapsed(false)`。

## 复现测试的真伪核对(核心:不是恒真测试)

新增 `Composer.mount.test.tsx`(happy-dom + 真实 `ClipboardEvent`/`DataTransfer` 驱动真实
`onPaste`,mock radix/cmdk/i18next 为透传壳)。流程:挂长草稿(12 行)→ 非聚焦 auto-collapse
→ 点 `composer-collapse-toggle` 展开(expandInput 经 rAF 聚焦 textarea)→ 在 textarea 上
dispatch 短文本 paste → 断言 `composer-input` 仍在 DOM、`composer-collapse` 不在。

**最硬的验证:回退修复跑测试(复现先于修)**。把 `Composer.tsx` 临时回退到旧条件
(去掉 `!isLong &&`),只跑该测试:
```
expect(host.querySelector('[data-testid="composer-input"]')).not.toBeNull()
error: expect(received).not.toBeNull()
Received: null
(fail)
```
即旧代码下粘贴后 textarea **真的消失了**(null)。恢复修复后:**1 pass**。
→ 测试如实复现 bug,非恒真;修复真的改变行为。

## 验证(全量)

环境补齐(本 review workspace 初始缺 `node_modules` 与 `bindings/` —— bindings 被 gitignore、
需 `wails3 generate bindings` 生成;mount 测试经 Composer 间接 import bindings,缺则全挂
`Cannot find module '...chatservice'`,这正是历史上 MermaidRenderer/ModelSelect mount 测试
在本类环境报 `react/jsx-dev-runtime`/bindings 找不到的同一根因):

- `cd frontend && bun install`(298 包)。
- `wails3 generate bindings`(v3.0.0-alpha2.106,2 Services / 64 Methods / 10 Models)。
- `cd frontend && bun test`:**61 pass / 0 fail**(含新增 Composer mount 测试),与被验收方
  worklog「61 pass」一致。
- `cd frontend && npm run build`(tsc + vite production):通过(仅预存 chunk-size 警告,无关)。
- `go build ./... && go vet ./... && go test ./...`:全绿(仅预存 macOS 链接器版本 warning,无关)。

## 规约合规

- §5.3「每个 bug 修复必须配一个能复现该 bug 的测试,先复现再修」:已用回退法实证测试复现 bug。✓
- §5.3「找不变量,不堆 if」:修复是**收紧条件**(加 `!isLong`),非加分支对抗;对应「聚焦编辑中
  不打断」这一不变量,三种折叠路径收敛一致。✓
- §0.3 / §6.2:被验收方 worklog 已写、commit 原子(fix 与 docs 分两 commit)、message 说清改了什么
  + 为什么、diff 仅含 `Composer.tsx` + 新增测试文件,无夹带。✓
- §6.2 不入库:`bindings/`、`node_modules/`、`dist/` 均 gitignore,本次 review 生成的均未入库。✓

## 次要观察(不阻塞)

- **环境依赖提示(给后续 review / CI)**:mount 测试依赖 `bindings/`(wails3 生成)与已装的
  `node_modules`。bare checkout 下直接 `bun test` 会让所有 mount 测试(Composer/MermaidRenderer/
  ModelSelect)因 import 解析失败而报错,需先 `bun install` + `wails3 generate bindings`。这非本次
  改动引入,但建议在 CI 流水线里把这两步纳入「前端测试」job 的前置,以免 mount 测试在 CI 里
  长期「假绿/假红」。
- **手动复核仍建议(被验收方 worklog 下一步已列)**:`wails3 dev` 下展开长草稿后粘贴短/长文本
  均不再折叠打断、空输入框粘贴大段文本仍折叠为预览、折叠态发送仍提交全文。自动化已锁核心回归,
  手动复核真实 WebKit 行为作为最后闭环。

## 结论

**PASS**。`onPaste` 折叠条件加 `!isLong` 守卫是真正的行为变更(非签名/类型空壳),与渲染逻辑
贯通核对确认修复了「聚焦编辑长草稿时粘贴 → textarea 被折没 → 键入丢失」;复现测试经「回退即
失败」实证非恒真;`bun test` 61 pass / 0 fail、build 绿、Go 门全绿;规约合规。次要观察
(CI 前置依赖 / 手动 WebKit 复核)不阻塞,可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-composer-paste-collapse-stuck.md`(本文件)。
