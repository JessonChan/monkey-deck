# 2026-08-27 — LaTeX 公式渲染:remark-math 解析 + KaTeX 懒加载 + ChatView 三处接线(#135)(Task #24414)

## 起因

agent 回复里常见的 LaTeX 公式(`$E=mc^2$`、`$$\int_0^1 x^2 dx$$`、GitHub 风格的 ` ```math ` 围栏)在聊天气泡里一直以裸文本呈现,用户无法读到渲染后的公式形态。

## 根因

`AgentMarkdown`(ChatView.tsx)是 agent 气泡与 user markdown 唯一的 markdown 渲染入口,remark 插件只有 remark-gfm——markdown 管线根本不产公式节点,自然无处渲染。

## 技术路线(先探针后动手)

- **选型**:remark-math(解析)+ KaTeX(渲染),都是事实标准库,不自造 TeX 子集。
- **接线下沉到既有节点形状**:探针实证(node 直接跑 unified 全管线)remark-math v6 的产出——inline `$…$` → `<code class="language-math math-inline">`,display `$$块` → `<pre><code class="language-math math-display">`,` ```math ` 围栏 → `<code class="language-math">`(无 display 类)。**三种形态全部落在现有 code/pre 渲染器路径上**,故无需新增 components key,在 CodeRenderer / PreRenderer 内按 className 分流即可,```math 围栏与 $$ 块天然收敛同一条 MathBlock 路由。
- **上游坑排查(虚惊一场)**:初期探针显示多行 `$$\int_0^1 x\n$$` value 为空、结果跨进程不稳定;逐层二分(mdast vs hast、batch vs 单例、bun vs node)+ 沙箱锁版本对照后确认:**那是 fence-meta 语义**——`$$` 同行后的文字是元数据不是公式体(micromark 与 ```lang 围栏同构),真实多行块(`$$\n公式\n$$`)解析完全正常。教训记牢:**测 block 数学时公式体必须另起一行**。无上游 bug,零锁版本需求。
- **懒加载**:katex(~259KB min JS + 59 个字体资产 + CSS)不进首屏 bundle。lib 层动态 `import("katex")` + `import("katex/dist/katex.min.css")` 同 chunk 加载,Vite 注入 `<link>`;模块级单例 Promise + 失败重置可重试。CSS 动态导入 TS 解析需要 ambient 声明(`src/assets.d.ts`),Vite 侧照常 code-split。**产物实证**:主 bundle 无 katex 实现代码指纹(`htmlAndMathml`=0),`katex-*.js` 258KB×2 chunk + `katex-*.css` + 59 字体全在独立 assets;dup chunk 是 mermaid 自带的嵌套 katex@0.16(peer 版本不同不可合并),双方都懒加载,接受现状。
- **安全**:KaTeX 文档明示可安全渲染不可信输入,叠加 `trust:false`(禁 `\href`/`\includegraphics` URL 输出),输出才交给 `dangerouslySetInnerHTML`。

## 改法

1. **`frontend/src/lib/katexRenderer.ts`**(新):动态加载 + djb2 hash 缓存(同 mermaid 的 Map key 形状:`d/i:{hash}`,display 与 inline 分开);同步 cache 命中器供组件首帧直出;永不向调用方抛错(`{ok:false}`)。渲染参数:`throwOnError:false`(坏公式原样高亮)、`strict:false`、`trust:false`、`output:"html"`。
2. **`frontend/src/components/KatexRenderer.tsx`**(新):`MathInline` / `MathBlock` 共用 `useKatexHtml`;未就绪或失败时回落展示原始 LaTeX 源码(streaming 中天然友好),缓存命中则首帧直出无闪烁。**不做显式错误文案**(i18n 零新增):坏 TeX 由 KaTeX 自己 `.katex-error` 高亮标黄,加载失败属瞬态基础设施问题,静默源码回落即可——KISS。
3. **ChatView 三处接线**:
   - wiring 1/3:`AgentMarkdown` 的 `remarkPlugins={[remarkGfm, remarkMath]}`;
   - wiring 2/3:`PreRenderer` 对 `language === "math"` 走 `MathBlock`($$ 块 + ```math 围栏双形态同路由);
   - wiring 3/3:`CodeRenderer` 在通用 `isBlock` 判定**之前**拦截 `math-inline` 走 `MathInline`(其 className 也含 "language-",不先判会被当普通代码)。
   - 组件全部模块级稳定引用,遵守 streaming remount 不变量(components 身份节奏不变)。
4. **index.css**:`.md-math-block`(横向滚动,与 #136 表格 wrapper 同思路)、`.md-math-src`(源码回落,muted mono)、`.md-math-inline .katex{font-size:1.02em}`(默认 1.21em 在正文里过大)、`.katex-error` 警示色。

改的文件:
- 新增 `frontend/src/lib/katexRenderer.ts`、`frontend/src/components/KatexRenderer.tsx`、`frontend/src/assets.d.ts`、`frontend/src/components/ChatView.math.mount.test.tsx`
- 修改 `frontend/src/components/ChatView.tsx`、`frontend/src/index.css`、`frontend/package.json`(+remark-math ^6.0.0、+katex ^0.18.4)

## 验证

- 新增 mount 测试 6 条(happy-dom + 真 react-markdown 管线,mock `import("katex")`,沿用 table/virtual 测试套路):inline 直出且不落入 code-inline、$$ 块单次 display 模式调用且参数正确、```math 围栏同路由且不出 CodeBox、user markdown surface 同待遇、普通 js 围栏不越界进数学路径、无配对 `$` 金额文本保持字面(boundary)。
- `bun test --isolate`:**399 pass / 0 fail**(46 文件,含新增 6 条;worktree 缺 bindings 先补跑 `wails3 generate bindings`,惯例操作)。
- `bun run build`(tsc + vite production):通过(chunk>500kB 警告为既有状态)。产物级确认见上「技术路线·懒加载」段。
- 依赖面:bun add 重解了部分既有依赖的 lockfile 版本(@types/react 等 minor 漂移),与 #136 任务时的 bun install 刷新行为一致。
- 三端说明(§4.7/§5.6,如实记录):改动落在共享前端 bundle 的气泡内部,新增依赖为纯 CSS 驱动的 DOM 输出(KaTeX HTML+字体),无 canvas/WebGL/webview API 触碰,三端引擎原生可渲染,移动端窄屏受益于块的横向滚动容器。**桌面 webview / 远程浏览器 / PWA 三端像素级目视复核未在本机执行**(worktree 未起 wails3 dev),留待桌面侧冒烟;mock 级集成证据已覆盖结构与数据流。

## 下一步 / OPEN

- 桌面 GUI 目视过一眼实际公式观感(font-size 微调可能性:`.md-math-inline .katex` 当前钉 1.02em)。
- 二进制 math 符号与 `$` 千分位混排场景(如 "$5 and $10" 会被 remark-math 吸成 `5 and ` 公式)是 upstream 默认行为(GitHub 同病),暂接受;若实际反馈密集再评估 `singleDollarTextMath:false` 或预处理守卫,当前不加复杂度。
