# 2026-08-26 Review #24328:Mermaid busy 态补例 — APPROVE(#24327 缺口真实闭合)

Task #24329 / 快审对象 commit `39fe2d1`(busy 补例)+ `39bedf1`(worklog 勘误)。
范围纪律:按 #24327 承诺「二轮只验新增一例 + worklog 勘误」,四硬门槛首轮已核实,
本轮不重复。

## 结论

**APPROVE,issue 关闭**。唯一阻塞项(busy 态零覆盖 + 计数 17≠18)两项均真实闭合。

## 核对(反向追踪 + 独立复跑,不信叙述)

1. **busy 例逐断言核对**(对照 review 给定的最小修复路径):
   - gate(pending promise)把 mock 停在 busy 中途 → `disabled === true`——锚定
     属性值(`toBe(true)`),非字段存在;✓
   - busy 中再点 → `copyImageCalls.length` 仍 1;✓
   - `release()` → `disabled === false` + tooltip 翻**精确串**
     `chat.mermaidImageCopied`;✓
   - `finally` 清 gate,异常路径不污染后续用例;gate 默认 null,既有 5 例不受影响
     (复跑证实)。✓
2. **「再点不触发」断言的行为前提独立实证**:组件 onClick 无 busy 早退
     (`onClick={() => void copyImage(svg)}`,MermaidRenderer.tsx:175),
     `disabled={imageState === "busy"}`(:174)确为唯一守卫——断言完全押在
     「happy-dom `click()` 对 disabled 表单控件按 spec 短路」上。自行写最小探针
     (enabled click 派发 1 次 → disabled 后 click 仍 1 次)在 frontend 依赖树内
     实跑:**1 pass / 2 expects,短路成立**——断言非空转,worklog「探针先行」
     声明属实。
3. **计数勘误核对**:`git diff 53115d1^ 39fe2d1` mount 文件 `grep -c '^+.*test('`
   = **6**(原 5),lib = 12,合计 **18** ✓;实现方 worklog mount 一条改为真实
   6 例清单 + 勘误注记(原 17),pass 数 38→39 / 349→350 均标注保留原值——
   历史透明,非静默改史。✓
4. **独立复跑**(worktree 重建:bun install 369 + `wails3 generate bindings -ts`
   298/3/132;bindings 不入库,缺它时 8 个 mount 文件因模块缺失整文件红,属
   环境前提非代码回归):
   - 探针:`1 pass / 0 fail`。✓
   - 定向两文件:`39 pass / 0 fail`(111 expects)。✓
   - 全量 `bun run test`:**350 pass / 0 fail**(39 文件)。✓
   - `bun run build`(tsc + vite):通过,仅既有 chunk>500kB warning。✓
5. **范围纪律**:两 commit 恰为 +1 test(38 行)+ 2 个 worklog 文件,零产品代码
   变化,三端无回归面;review「另」注的 mount 首例标题措辞未动(不属阻塞项,
   #24328 worklog 已声明)。✓

## 下一步

- #86 遗留真机清单不变(WKWebView/Chromium/iOS PWA 实测 copied/downloaded 分支,
  testid 已备)。
