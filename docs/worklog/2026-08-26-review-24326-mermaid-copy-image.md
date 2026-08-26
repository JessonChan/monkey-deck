# 2026-08-26 Review #24326:#86 Mermaid 复制为图片 — REQUEST_CHANGES(1 项,修复路径已给出)

Task #24327 / review 对象 commit `53115d1`(feat)+ `81e7f51`(实现方 worklog)。

## 结论

**REQUEST_CHANGES**。四项硬门槛(样式内联不丢色 / blob·Image 资源泄漏 / ClipboardItem
降级链路 / i18n zh+en)全部核实通过;但「18 例新测试」实际为 **17 例**(12 lib + 5 mount),
commit message 与实现方 worklog 均误记「12+6」;且缺失的那例恰好对应**唯一零覆盖的
busy 态**(`disabled={imageState === "busy"}` 防双击守卫无测试背书)。补 1 例即闭环,
其余全部放行。

## 审查方法(反向追踪,不信叙述)

按「类型补丁」反模式 playbook,从每个新增导出/字段定义点出发逐个确认运行时消费:

1. **tri-state 全消费核实**:`ImageCopyOutcome`(copied/downloaded/failed)→
   `CopyImageButton` label 四分支 + icon 四分支(MermaidRenderer.tsx:159-169)→
   `data-tooltip-content` + i18n 四键(zh/en 各 4,逐键对读)→ mount 测试断言 tooltip
   **精确串值**(`toBe("chat.mermaidImageCopied")` 等)——锚定值,非字段存在。✓
2. **样式内联不丢色**(硬门槛):
   - 藏匿挂载用 `position:fixed; left:-99999px; opacity:0`,**非** `display:none`
     (mermaidExport.ts:125-143)——computed 值不会被清空,核实正确。
   - holder 挂 `.mermaid-svg-host` class 复现页面 CSS 上下文;核 index.css:628-634
     该类为 `display:flex`(非 none)、对 svg 只有 `max-width/height` 布局约束
     (不在绘画属性白名单内,且 buildStandaloneSvg 事后剥除),**不影响取色**。✓
   - 白名单 23 项覆盖 fill/stroke/font-*/text-anchor/dominant-baseline 等 mermaid
     实际使用的绘画属性;`cloneNode(true)` 保留 mermaid 内嵌 `<style>`,内联样式叠加
     其上,双保险。✓
   - 单测 patch `getComputedStyle` 断言 `fill: rgb(64,64,68)` / `font-family` 内联
     进序列化输出——锚定值。✓
3. **blob URL / Image 资源泄漏**(硬门槛):
   - `rasterizeSvgToPng`:blob URL 在 `try/finally` 中 revoke(mermaidExport.ts:199-216),
     decode 失败路径也覆盖。✓
   - `downloadBlob`:`setTimeout(0)` revoke(既有模式复用);藏匿 holder 在 finally
     removeChild。✓
   - ClipboardItem 成功路径不产生 object URL(canvas.toBlob 直出 Blob),无泄漏点。✓
4. **ClipboardItem 降级下载链路**(硬门槛):6 分支测试全数核实——copied(断言
   ClipboardItem 收到 **promise 本体**(`.then` defined),Safari 手势形态)/ write 拒→
   下载(断言 blob 同一性 + `mermaid-\d{8}-\d{6}\.png` 文件名锚定)/ 无 API→下载 /
   promise 拒→failed / 双拒→failed / 裸 Blob 兼容。
   - **手势窗口链路逐跳核实**:`onClick → copyImage → await copyMermaidImage(...)` 的
     `copyMermaidImage(svg)` 同步求值 → `copyImageWithClipboardFallback(rasterizeSvgToPng(svg))`
     参数同步求值 → async 函数体首个 await 之前同步执行 `new ClipboardItem` + `write`
     ——`new ClipboardItem` 确在用户手势栈内,无隐藏 await。✓
   - promise 拒绝无 unhandled 分支:write 拒→catch 落到 `await png`;write 成功→浏览器
     消费 promise;无 API→`await png`。逐路径推演无遗漏。✓
5. **i18n zh+en**(硬门槛):四键两文件同步(对读 + 全量套件内 locales.test 键集
   不变量绿)。✓
6. **组件接线**:inline(非 viewSource 时)与 fullscreen 各一枚 `CopyImageButton`,
   独立 hook 实例,测试断言互不串扰;`useMermaidImageCopy` timer 在 unmount cleanup
   清理;`data-testid` 两实例唯一(`mermaid-copy-image` / `mermaid-fs-copy-image`);
   tooltip 走 `md-tip`(§4.5 react-tooltip,非原生 title)。✓
7. **download.ts 重构**:`downloadBlob` 抽取,`downloadText` 薄封装,既有调用点语义
   不变(diff 核实仅封装移动)。✓
8. **themeBackground 同源性**:dark 值直接引用 `darkThemeVariables.background`
   (mermaidRenderer.ts:111-114),防漂移设计核实。✓

## 独立复跑验证(worktree 重建环境)

- `bun install`(369 packages)+ `wails3 generate bindings -ts`(298/3/132)。
- 定向两文件:`bun test --isolate src/lib/mermaidExport.test.ts
  src/components/MermaidRenderer.mount.test.tsx` → **38 pass / 0 fail**,与 worklog
  声明一致。
- 全量 `bun run test` → **349 pass / 0 fail**(39 files),与 worklog 声明一致。
- `bun run build`(tsc + vite)→ 通过,仅既有 chunk>500kB warning。✓

## 阻塞项(REQUEST_CHANGES 原因)

**测试计数与覆盖缺口:17 ≠ 18,且缺的正是 busy 态**

- `git diff 53115d1^ 53115d1` 实测:mermaidExport.test.ts 新增 12 例
  (svgNaturalSize 3 + buildStandaloneSvg 3 + copyImageWithClipboardFallback 6)✓;
  mount 测试新增 **5 例**(grep `^+.*test(` = 5),合计 **17**,硬门槛要求 18。
- commit message「新增 12+6 例单测」与实现方 worklog「+6 例(流式不显示/…)」
  均为误记:worklog 自列的行为清单点数也是 5(流式隐藏 / 点击传 SVG+copied /
  downloaded / failed / fullscreen 独立实例)。
- 五态机 idle/busy/copied/downloaded/failed 中,**busy 唯一零覆盖**:
  `disabled={imageState === "busy"}`(MermaidRenderer.tsx:174)是防双击双光栅化的
  唯一守卫,无任何测试背书——双击会在手势窗口内并发两次 clipboard.write,
  行为未验证。另 mount 首例标题声称「visible in success view」但该测试只断言
  streaming 隐藏半边(visible 半边由第二例顺带覆盖)。
- **修复路径(最小)**:mount 测试补 1 例「pending promise → 按钮 disabled(busy)
  → resolve 后恢复 + tooltip 翻转」,即补齐 18 例并覆盖 busy 守卫;worklog 顺手
  改正「6 例」为实际数(commit message 不可变,本 review worklog 已记录勘误)。

## P3 观察(不阻塞,记录备查)

1. **decodeImage 无超时**:SVG blob 解码若在某引擎既不 onload 也不 onerror(理论
   边缘),busy 永久卡死且该次 blob URL 不释放。实践中 decode 必然终结,可接受;
   若真机实测发现卡死再补超时兜底。
2. **MAX_BASE_SIDE=8192 × 2x = 16384/边**:恰为 Chromium canvas 最大面积
   (268M px)边界;正方形超大图可能 canvas 分配失败 → toBlob null → "failed"
   反馈(非静默),可接受。
3. **真机待办**:WKWebView/Chromium/iOS PWA 实测落在 copied 还是 downloaded 分支,
   实现方 worklog 已显式标注,口径诚实。testid 已备好可直接锚定。

## 下一步

- 打回 coder 补 1 例 busy 测试(修复路径见上)后,二轮复核即可 APPROVE——其余
  全部门槛已在本轮核实通过,二轮只需验新增一例 + worklog 勘误。
