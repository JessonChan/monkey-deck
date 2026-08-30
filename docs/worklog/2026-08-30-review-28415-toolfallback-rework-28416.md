# Review #28415 tool fallback 复审返工——复制原始 JSON / 六类 4-6 / mount 测试(#28416)

日期:2026-08-30
被审:6a3bb00(feat 复审返工,7 文件 +450/−77)+ cdc9dd4(worklog);基线 main=17bc405(上一卡 d7d3060 已在,本卡在其上推进)
结论:**APPROVE**——#28414 三处 P1 全部补齐且逐条反向实证消费端:①复制语义经 `SummaryCopyBtn raw` 单点通道接满五卡 + generic 头部内联钮,input 侧未动;②摘要器六类 4-6 按原文落地(content join 前置 + MCP 包裹形 / title+url / t() 成败词),返回值改规格原文 `{summary, hadStructure}`;③mount 测试四例落地且全锚定值。P2(结构化输出标记 + 查看原始 JSON 措辞)同卡补齐。门禁独立重跑与声称逐字一致(461/0,62 文件,7584 expects),负向回绑实验证实 mount 测试钉住复制契约。遗留仅 P3 注释语言一处 + 两个已记录的用户裁决 OPEN。

## 复审方法

持 #28414 返工清单五条逐条对代码反向追消费端(「类型补丁」反模式检查:从字段/prop 定义点出发逐调用点确认读取/渲染/写出,不经 commit message / worklog 叙事):`SummaryCopyBtn.raw` 从定义(:1191)追到 payload 计算(:1194)、tooltip(:1207)、五个调用点(edit:1290 / read:1357 / search:1415 / generic:1500 / bash:1574)与 generic 头部内联钮(:1536-1538);`hadStructure` 从 `summarizeToolPayload` 返回值追到 `extractToolText` 两个 fallback 出口(:2032/:2044)再到徽章显隐(:1531);五枚新 i18n key 两侧逐字核对 + 全仓 grep 确认 `chat.rawData` 零残留;mount 测试四例逐断言核锚定值。本机独立重跑全部门禁(含 `bun install` 375 包 + `make bindings` alpha2.106,297 包/126 方法/26 模型,与 #28414 记录同环境)。

## 逐件验证(对 #28414 返工清单五条)

### 1. 六类 4-6 + `{summary, hadStructure}` 返回 ✅

- ① content 块:`joinTextBlocks`(toolPayload.ts:136-145)all-or-nothing(混入非 text 块返 null 落计数分支),`summarizeToolPayload` 数组分支**置于通用数组计数之前**(:161-162);MCP `{content:[…]}` 包裹形在 record 分支 :166-169(混合块 fallthrough 合理,有测)。
- ⑥ `{url,title,…}`:title 行在前 + url 行在后,缺一省一(`filter(Boolean).join("\n")`,:179-182)。
- ⑦ `{ok|success:bool}`:经 t() 的 `chat.toolSucceeded`/`chat.toolFailed`(:183-185),新 key zh(成功/失败)+ en(Succeeded/Failed)同步。
- 返回值 `{summary, hadStructure}`;开放形态统一 `NO_STRUCTURE`(:151),`{summary:null, hadStructure:false}` 整对象 `toEqual` 断言(test:132-136)。
- 单测 17 例**全锚定值**:`toBe` 精确串("Hello\nWorld"/"mcp result line"/"Example Domain\nhttps://example.com"/成功/失败)+ `not.toContain("{")` 不变量 + 200 字符截断。

### 2. fallback 复制 = 原始 JSON(P1-1)✅

- `rawJsonText`(:194-200)`JSON.stringify(raw,null,2)`(try/catch 兜 String)为复制与折叠 pre 的**共用保真出口**,两处不再各写 stringify。
- `SummaryCopyBtn` 加 `raw?: unknown`:`raw !== undefined` 时复制 `rawJsonText(raw)` 且 tooltip 换 `chat.copyRawJsonTip`——单点实现,五处调用点 + generic 头部内联钮全部按 `outputR.fallback` 接线;edit 卡 `summaryCopyText`(:1271)fallback 态同样走 rawJsonText。
- **input 侧维持现状**(规格原文):generic input 复制(:1509)仍复制 `inputR?.text`,无 raw 通道。

### 3. mount 测试(P1-3)✅

`ChatView.toolfallback.mount.test.tsx` 四例,骨架同既有 mount 测试(happy-dom + mock bindings/i18n/tooltip,另 mock `@wailsio/runtime` 捕获 `Clipboard.SetText`),**逐断言锚定值**:

| # | 断言 | 锚定方式 |
|---|---|---|
| 1 | 徽章 + 摘要 + 默认收起 | `textContent === "chat.structuredOutput"`(t() 恒等 stub,verbatim);摘要含 title/url 且 `not.toContain("{")`;`details.open === false` |
| 2 | 展开 pretty JSON | 点 summary 后 `details.open === true` 且 `pre.tool-raw-pre` textContent **逐字等于** `JSON.stringify(FALLBACK_OUTPUT,null,2)` |
| 3 | 复制写原始 JSON | `clipboardWrites` 增量 `toEqual([FALLBACK_PRETTY])`(非摘要) |
| 4 | 非 fallback 零回归 | 字符串输出:无徽章、无折叠、复制 = 原文 |

**负向回绑实验(复审自做)**:临时把 `SummaryCopyBtn` 的 payload 回绑为摘要(`const payload = text`)→ mount 例 3 **恰好 fail**(期望 FALLBACK_PRETTY,实收 "Example Domain\nhttps://example.com" 摘要,断言 diff 精确指认),`git checkout` 还原后树干净——复制契约被测试真实钉住,非字段存在性断言。

### 4. 「结构化输出」标记 + 折叠标签(P2)✅

- 徽章:generic 输出区 head `fallback && hadStructure` 显隐(:1531-1533),`data-testid="generic-fallback-badge"`,key `chat.structuredOutput`(zh「结构化输出」/en「Structured output」);外层 `{outputR && !(running && outputR.fallback)}` 守卫下直接访问安全。
- 折叠标签 `chat.rawData` → `chat.viewRawJson`(「查看原始 JSON」/「View raw JSON」),唯一引用点 RawPayloadDisclosure(:1461);全仓 grep `chat.rawData` 零残留。
- CSS 净 +1 行(`.tool-badge-structured` 紫 tint,复用 `.tool-badge` 基础,纯静态零 JS)。

### 5. worklog 偏差补记 ✅

#28414 P3 两项均已补记:四张专用卡本卡只改复制接线(偏差 2)、CSS +1 行(偏差 3);另将两个真裁决点显式 OPEN(四卡是否同款标记;`{ok:false,error}` 仅词面,error 只在折叠层)。

## 门禁独立重跑(与被审声称逐字一致)✅

复现 worktree 环境(缺 gitignore 依赖):`bun install` 375 包 + `make bindings`(alpha2.106,297 包/126 方法/26 模型)后:

- `bun run test`(`bun test --isolate`)→ **461 pass / 0 fail**,62 文件,7584 expects——与声称逐字一致(451 基线 + 单测 +6 + mount +4);minSize/maxSize React 告警为 resizable-panels mock 既有噪音(#28405/#28408/#28411/#28414 复审同判);
- `bun run build:dev`(tsc + vite)→ 过;
- `go build ./...` / `go vet ./...` → 双 exit 0(Go 零改动;ld macOS 版本告警为既有噪音)。

## Findings 汇总

- **P3** §3.7 注释语言一处漏转:`extractToolText` 头注释(ChatView.tsx:2020-2024)与 `toolPayload.test.ts:2-4` 文件头本次被改写但仍是中文(同 commit 里 edit 卡 :1268 的旧中文注释倒是正确转了英文)。行为无影响,下次触及顺带转。
- OPEN(被审已记录,留用户裁决,不阻塞):四张专用卡 fallback 摘要是否同款「结构化输出」标记;`{ok:false, error:"…"}` 是否带出 error 行。

## 下一步

本卡 **APPROVE** 收口,停 completed-ready,不关 issue、不 push(硬纪律);两个 OPEN 留用户裁决。
