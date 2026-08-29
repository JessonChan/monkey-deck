# Review #28413 tool fallback 人话摘要 + JSON 折叠前端面复审(#28414)

日期:2026-08-30
被审:d7d3060(feat summarizeToolPayload + fallback UI,6 文件 +305/−60)+ 41e3978(worklog);基线 main=eb9038f
结论:**NEEDS_CHANGES(返工)**——实现的部分质量扎实(gate 451/0 与声称逐字一致、负向实验证实套件钉行为、单测全锚定值),但**对照父规格全文有三处 P1 硬缺口**:①规格点 3(fallback 复制=原始 JSON)完全未实现且 worklog 未提;②六类形态清单的 4-6 类(content join / url+title / 布尔成败)未按原文实现(被审任务文本截断,按自复原版落地);③硬性测试 2 的 mount 测试零落地。被审 worklog 自设的仲裁规则「若 #28412 原文另有定义,以原文为准补齐」被触发——原文确有另定义。

## 复审方法

持父规格**全文**(六类清单 + 四点拍板 + 四条硬性测试)逐条对代码反向追消费端,不经 commit message / worklog 叙事;copy 链路从 `SummaryCopyBtn` 定义点(:1184-1204)追到五个调用点逐一核对复制内容;测试逐条核对断言锚定值;「mount 测试存在与否」全仓 grep `raw-output|tool-running-hint|RawPayloadDisclosure` 于 `*.test.tsx`(零命中,仅源码/CSS/locales 命中)。本机独立重跑全部门禁。

## 逐件验证(规格四点 + 四条硬性测试)

### 规格点 1 摘要器:位置与链序 ✅,六类清单 3/6 ❌(P1-2)

- 链序正确:`extractToolText`(ChatView.tsx:2016-2030)字符串原样 → 已知 key → meta.output → `summarizeToolPayload ?? formatHuman`(fallback 标记保持);**数组显式分流**(:2018-2019)是被审自己发现的真实漏路由(isRecord 不含数组),修得对。
- 已实现的形态与单测一一对应、**全锚定值**(`toBe` 精确串 + `not.toContain("{")`,非字段存在性):数组计数+3 预览+more 尾 / 路径行原样(含 grep `file.go:12:` 形)/ matches 类数组字段 / path+body / 扁平 record / 嵌套递归扁平化(toolPayload.test.ts 11 例)。
- **缺口**:规格 4-6 类未见——
  - `[{type:"text",text:…}]` content 块 → 现走计数+预览,产出 `- type: text, text: …` 碎片,非 text join;
  - `{url,title,…}` → 落扁平 record 兜底,产出 `url: …\ntitle: …` 键值行,非「title + url」;
  - `{ok|success:bool}` → 产出 `ok: true`,非成功/失败词(无对应 i18n key)。
  三类均无单测。被审 worklog「偏差 2」已如实记录按复原规格实现并声明以原文为准——原文即本规格,须补齐。

### 规格点 2 fallback UI 重排:折叠本体 ✅,「结构化输出」标记 ❌(P2)

- `RawPayloadDisclosure`(:1452-1461):`<details>` 无 open 属性 = 默认收起 ✅;展开渲染 `JSON.stringify(raw,null,2)` 等宽 pre(`.tool-raw-pre`)、**不经 PathLinkified** ✅;五卡接入点一致(edit:1324 / read:1375 / search:1439 / generic in:1516 out:1538 / bash:1601)。
- `ToolRunningHint`(:1468-1476)+ generic/bash 的 `running && fallback` 分支(:1519-1520/:1588-1589)以占位符替代 partial 载荷,分支逻辑核对无漏(`!(running && outputR.fallback)` 恰为补集);read 卡 running 空态从误显「无内容」改占位符,属顺手修的真改善。
- **缺口**:摘要行无「结构化输出」标记(规格点 2 明确要求 i18n 标记);折叠标签用「原始数据/Raw data」而非规格的「查看原始 JSON」。worklog 偏差节**未**记录此项。

### 规格点 3 复制语义:完全未实现 ❌(P1-1)

fallback 态复制按钮仍是**摘要文本**:`SummaryCopyBtn text={outputR.text}`(generic:1497 / read:1352 / search:1410 / bash:1566)+ edit 的 `summaryCopyText`(:1285 复制 outputR.text);generic 头部 copy 复制 `outputR.text`(:1528)。规格要求 fallback 态复制 `JSON.stringify(raw,null,2)` 保真原始 JSON。代码零实现,worklog 零提及——典型的「规格点整点静默丢失」。

### 规格点 4 范围:被审超版但无害(P3)

- 摘要器落 `lib/toolPayload.ts` 而非规格的 ChatView.tsx:**已记录**偏差,理由成立(该文件无单测先例、import 拖 ReactMarkdown/mermaid 全家桶;有 countDiffLines→lib 先例),接受。
- 四张专用卡被改动(规格要求「不动」):改动全部 fallback 门控,非 fallback 路径行为零变化——由 451/0 全量含既有四卡用例证实;属**未记录**的轻微超版,返工时在 worklog 补记即可。
- CSS +20 行 vs 规格 ≤10:超一倍但均为纯静态规则(§4.6 零 JS 状态),P3 记录。
- formatHuman/formatInline 保留供非 fallback 路径 ✅(迁 lib 后 formatInline 反而补硬:渲染路径已无任何 JSON.stringify)。

### 硬性测试逐条

| # | 规格 | 判定 |
|---|---|---|
| 1 | 摘要器六类各一例 + 开放形态走折叠 | **部分**:实现版六类有测;规格 4-6 类(content join/url+title/布尔成败)零实现零测试 |
| 2 | mount:摘要行+默认收起+展开 pretty JSON+复制原始 JSON | **缺**:无任何 mount 测试触及新 UI;worklog E2E 是临时浏览器验证,不构成回归资产 |
| 3 | 非 fallback 零回归 | **过**:全量 451 pass / 0 fail(61 文件,7554 expects) |
| 4 | i18n zh/en 同步 | **部分**:4 新 key 两侧同步、locales.test parity 锁在套件内;但规格点名的「结构化输出」「查看原始 JSON」措辞/key 未按原文落地 |

## 门禁独立重跑(与被审声称一致)✅

复现 #28411 复审记录的同一环境坑(worktree 缺 gitignore 依赖):`bun install` 375 包 + `make bindings`(alpha2.106,297 包/126 方法/26 模型)后:

- `bun run test`(= `bun test --isolate`)→ **451 pass / 0 fail**,与声称一致(maxSize React 告警为 resizable-panels mock 既有噪音,#28405/#28408/#28411 复审同判);
- `bun run build:dev`(tsc + vite)→ 零类型错误,构建通过。

**负向敏感性实验(复审自做)**:临时把 `formatInline` 回绑 `JSON.stringify` 兜底分支 → `toolPayload.test.ts` 恰好 **3 fail**(两条 `not.toContain("{")` + formatHuman 无花括号例),`git checkout` 还原后 11/0——套件钉的是「fallback 链无 JSON」不变量,非文本巧合。

## Findings 汇总

- **P1-1** fallback 复制语义未实现(规格点 3 整点缺失,全代码零落地、worklog 零提及)。
- **P1-2** 六类清单 4-6 未按原文实现(content join / title+url / 成功失败词),无单测;按被审自设仲裁规则须以原文补齐。
- **P1-3** 硬性测试 2 的 mount 测试缺失(默认收起/展开 pretty JSON/复制原始 JSON 三断言均无回归防线)。
- **P2** fallback 摘要行缺「结构化输出」标记;折叠标签措辞与规格不符且偏差未记录。
- **P3**(不阻塞,返工时顺手):五卡超版与 CSS 超行补记 worklog 偏差节。

## 返工清单(给实现侧)

1. `summarizeToolPayload` 补 4-6 类:content 块数组([…{type:"text",text:…}])text join(须置于通用数组计数分支之前);`{url,title,…}` → title 优先 + url;`{ok|success:bool}` → 经 t() 的成功/失败词(新 i18n key,zh+en);各配锚定值单测。
2. 五卡 output 侧 fallback 态复制改为 `JSON.stringify(raw,null,2)`(input 侧维持现状,规格原文);通用做法可给 SummaryCopyBtn 加 `text` 之外的原载荷通道或新 prop,勿散弹改五处。
3. 补 mount 测试:夹具 fallback 载荷 → 断言摘要行 + `details:not([open])` 默认收起 + 展开后 pre 内 pretty JSON + 复制按钮写出原始 JSON。
4. 补「结构化输出」摘要行标记(key zh+en),折叠标签对齐「查看原始 JSON」或把措辞偏差记入 worklog 偏差节交用户裁决。
5. worklog 偏差节补记:五卡接入范围、CSS 行数、标记/措辞;返工后重跑 `bun run test` + `build:dev`。

## 下一步

本卡 **NEEDS_CHANGES** 收口,停 completed-ready,不关 issue、不 push(硬纪律);返工完成后按流程走复审。
