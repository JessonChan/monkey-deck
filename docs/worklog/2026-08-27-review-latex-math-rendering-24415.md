# 2026-08-27 — Review #24414:#135 LaTeX 公式渲染落地(Task #24415)

## 起因

复审 coder Task #24414(commit 7133553 实现 + 9413766 worklog):remark-math 解析 + KaTeX 懒加载 + ChatView 三处接线(#135)。重点按「类型补丁」反模式做消费端全链路追踪——tsc 绿 ≠ 行为通电,逐个确认新增字段/class/export 真的被读取、渲染、消费。

## 结论:**APPROVE(P3×2 非阻塞)**

### A.【三处接线消费链】→ **PASS,无缺口**

反向逐点确认(每条都有运行时证据,非仅存在性):

1. **wiring 1/3** `remarkPlugins={[remarkGfm, remarkMath]}`(ChatView.tsx:1779):真实 react-markdown 管线 mount 测试实证 inline `$…$`、`$$` 块、```math 围栏三种形态均产节点并被下游捕获(`katexCalls` 精确相等断言,含 `src` 与 `displayMode` 锚定值);
2. **wiring 2/3** PreRenderer 的 `language === "math"` 分支(:1727):`extractCodeChild` 正则 `/language-(\w[\w+-]*)/` 对 `language-math math-display` 复合类名正确截出 `math`;$$ 块与 ```math 围栏双形态收敛同一路由,test #2/#3 断言 marker + 非 CodeBox;
3. **wiring 3/3** CodeRenderer 在通用 `isBlock` 判定**之前**拦截 `math-inline`(:1822):其 className 含 `language-`,不先判必被当普通代码——顺序正确,test #1 断言「marker 直出 + `.md-math-src` 清空 + 未落入 `.code-inline`」三连;
4. **双面覆盖**:user markdown 面走同一 `AgentMarkdown`(ChatView.tsx:1008),test #4 以 `.bubble-user-markdown` 锚定;
5. **负路径**:普通 js 围栏零 katex 调用(test #5)、无配对 `$` 金额文本保持字面(test #6)。测试断言全部锚定具体输出值(marker 字符串、调用日志等值比较、textContent 包含),符合断言规范。

CSS 侧:`.md-math-block/.md-math-src/.md-math-inline .katex/.katex-error` 规则齐备(index.css:635-651),类名与组件发射的 className 一一对应(见 D 的例外)。

### B.【streaming remount 不变量】→ **PASS**

`MathInline`/`MathBlock` 为模块顶层稳定引用;`useKatexHtml` deps `[source, displayMode]` 完整,cleanup 置 `alive=false` 丢弃 stale 解析(streaming 中源码增长不串台);缓存命中首帧同步直出。`pre` 内联箭头函数身份漂移是本文件既有且有意的设计(mermaid 同款),非本次引入。

### C.【懒加载 / 安全 / 缓存一致性】→ **PASS**

- 动态 import 将 JS+CSS 切独立 chunk,失败重置单例可重试(katexRenderer.ts:38-46);worklog 已给产物级证据(主 bundle 无 katex 指纹、dup chunk 系 mermaid 内嵌 katex@0.16,不可合并属预期);
- 渲染参数 `throwOnError:false / strict:false / trust:false / output:"html"`(:86-92):KaTeX 文档明示可安全渲染不可信输入,叠加 trust:false 禁 URL 输出后 `dangerouslySetInnerHTML` 边界成立;output:"html" 单输出避免 MathML 双份不可见文本;
- 缓存键 `d/i:{hash(trimmed source)}` 与实际渲染 `source.trim()` 一致(:61 vs :86),inline/display 分桶正确;djb2 截断碰撞风险与 mermaid 缓存同级,接受。
- `KatexRenderResult.error` 生产端构造、组件端故意不展示(静默源码回落,组件头注释明说)——非类型补丁,行为契约自洽。

### D.【P3 发现 ×2,非阻塞】

- **P3-1**:KatexRenderer.tsx:60 发射 `is-source` 变体类,但 index.css 与全仓无任何规则/消费者引用它(data-testid 已足测试锚定)——死钩子。建议:删掉,或补一条真正用得上的规则(如源码态限高滚动)后再留。
- **P3-2**:katexRenderer.ts:101 `__resetKatexCacheForTest` 导出后全仓零 import——unused export。要么在测试里真用它隔离模块级缓存状态,要么删除(Less-is-More)。

### E.【i18n / a11y】

- i18n:零新增用户可见文案(回落=原始源码、坏公式由 KaTeX 自身高亮),zh/en 键无需动;
- data-testid 三件套(math-inline/math-block/math-body)齐备且被断言;无新弹窗,Esc 约束 N/A。

### F.【三端矩阵(§4.7)】

改动落在共享前端气泡内部,KaTeX 输出为纯 CSS+DOM(无 canvas/WebGL/webview API),理论三端原生可渲染;mock 级集成证据覆盖结构与数据流。coder worklog 已如实标注「桌面 webview / 远程浏览器 / PWA 像素级目视未执行」,与 #136 表格评审同类,**记为既有 OPEN 不阻塞**,随桌面侧冒烟一并处理。

## 本任务改动

无代码修正(两处 P3 均为 weightless 级别,留给实现侧顺手收)。本条 worklog。

验证(本机实跑):
```
bun install + wails3 generate bindings   # worktree 中间产物补齐(惯例)
bun test ChatView.math.mount.test.tsx    # 6 pass / 0 fail
bun test --isolate                       # 399 pass / 0 fail(46 文件)
bunx tsc --noEmit                        # exit 0
```

## 下一步 / OPEN

- 桌面 GUI 目视复核公式观感(inline 1.02em 是否合适,worklog 既列);
- P3-1/P3-2 两处死代码顺手清;
- 「桌面零修改」无关——本改动跨三端生效,三端冒烟结论回写实现侧 worklog 即可闭环。
