# 2026-08-29 tool fallback 人话摘要 + 原始 JSON 折叠——复审返工(#109 / Task #28415)

## 起因

#28414 复审 #28413(d7d3060)判 **NEEDS_CHANGES**,对照父规格全文三处 P1:

- **P1-1**:规格点 3(fallback 复制=原始 JSON)零实现,worklog 零提及;
- **P1-2**:六类形态清单 4-6(`[{type:"text",text:…}]` content join / `{url,title,…}` / `{ok|success:bool}`)未按原文,零单测(上一卡任务文本截断,按自复原版落了别的形态,其自设仲裁规则「以原文为准补齐」被触发);
- **P1-3**:硬性测试 2 的 mount 测试零落地;
- **P2**:fallback 摘要行缺「结构化输出」i18n 标记;折叠标签用「原始数据/Raw data」而非规格的「查看原始 JSON」。

本卡(#28415)按 #28414「返工清单」逐项补齐。基线 main=eb9038f(上一卡 d7d3060 已在,本卡在其上推进)。

## 改法(逐条对返工清单)

### 1. summarizeToolPayload 补 4-6 类 + `{summary, hadStructure}` 返回(规格点 1)

返回值从 `string | null` 改为规格原文的 `{summary, hadStructure}`;`hadStructure=true` 当且仅当识别出已知形态,开放形态返 `{summary:null, hadStructure:false}` 交调用方兜底(对应「开放形态不硬翻,原样进 JSON 折叠层」)。

摘要器形态矩阵(优先级序,`frontend/src/lib/toolPayload.ts`):

| # | 形态 | 输出 | 状态 |
|---|---|---|---|
| ① | `[{type:"text",text:…}, …]` content 块数组;含 `{content:[…]}` MCP 包裹形(**置于通用数组计数分支之前**) | text join(逐块一行,all-or-nothing:混入非 text 块则整组落到 ②) | **本卡新增** |
| ② | 通用数组 | 「共 N 项」+ 前 3 项单行预览 +「…另有 X 项」 | #28413 已有 |
| ③ | 路径行数组(`/abs`、grep `file.go:12:` 形) | 原样逐行,不加计数头 | #28413 已有 |
| ④ | `{matches\|results\|…:[…]}` 主导数组字段 | 同 ②③ | #28413 已有 |
| ⑤ | `{path + content/text/…}` | 路径首行 + 正文 | #28413 已有 |
| ⑥ | `{url,title,…}` | title 行在前 + url 行在后(缺一省一) | **本卡新增** |
| ⑦ | `{ok\|success:bool}` | 经 t() 的 成功/失败 词(新 key `chat.toolSucceeded`/`chat.toolFailed`,zh+en) | **本卡新增** |
| ⑧ | 扁平/嵌套 record | key: value 行(递归扁平化,永不 JSON.stringify) | #28413 已有 |
| — | 开放形态(原始值/空形) | `{summary:null, hadStructure:false}`,formatHuman 兜底,原样进折叠层 | 语义显式化 |

新公共函数 `rawJsonText(raw)`:`JSON.stringify(raw, null, 2)`(try/catch → `String(raw)`),作为复制按钮与折叠 pre 共用的保真出口——两处不再各写一遍 stringify。

### 2. fallback 复制=原始 JSON(规格点 3 / P1-1)

- `SummaryCopyBtn` 加 `raw?: unknown` prop:`raw !== undefined` 时复制 `rawJsonText(raw)` 且 tooltip 换 `chat.copyRawJsonTip`(「复制原始 JSON」)——单点实现,五处接线;
- 五个调用点(read / search / bash / generic 头部 / edit 的 `summaryCopyText`)统一传 `raw={outputR.fallback ? item.rawOutput : undefined}`;generic 输出区内联复制按钮同样按 `outputR.fallback` 切换载荷与 tooltip;
- **input 侧维持现状**(规格原文:只改 output 侧)。

### 3. mount 测试(P1-3)

新文件 `frontend/src/components/ChatView.toolfallback.mount.test.tsx`(骨架同既有 mount 测试:happy-dom + mock bindings/i18n/tooltip,另 mock `@wailsio/runtime` 以捕获 `Clipboard.SetText`),4 例:

1. fallback 摘要行 + `generic-fallback-badge` 标记(key 断言verbatim)+ 折叠默认收起(`closest("details").open === false`)+ 摘要正文无 `{`;
2. 点开折叠 → `pre.tool-raw-pre` 内容 === `JSON.stringify(raw,null,2)` 逐字;
3. 点 `generic-summary-copy` → clipboard 写出原始 JSON(非摘要);
4. 非 fallback 字符串输出零回归:无标记、无折叠、复制=文本。

### 4. 「结构化输出」标记 + 折叠标签(P2)

- generic 输出区 head 增 `<span class="tool-badge tool-badge-structured">{t("chat.structuredOutput")}</span>`(zh「结构化输出」/en「Structured output」),显隐条件 `outputR.fallback && outputR.hadStructure`;
- 折叠标签「原始数据/Raw data」→「查看原始 JSON/View raw JSON」:key 改名 `chat.rawData` → `chat.viewRawJson`(唯一引用点 RawPayloadDisclosure,连带其内部 stringify 换用 `rawJsonText`);locales parity 测试锁两侧同步。

## UI 重排前后对比(fallback 态,generic 卡)

- **前**:输出区与正常输出同形态(`pre` 直显 + PathLinkified),无任何「这是摘要」的标识;头部/输出区复制按钮复制**摘要文本**;折叠标签「原始数据」。
- **后**:输出区 head 带「结构化输出」徽章 → 摘要 pre;复制按钮写**原始 JSON**(tooltip「复制原始 JSON」);折叠标签「查看原始 JSON」默认收起,展开为 pretty JSON 等宽 pre(不经 PathLinkified)。

## 偏差与裁决记录(对 #28414 返工清单的显式差异)

1. 摘要器仍落 `lib/toolPayload.ts` 而非 ChatView.tsx——#28413 偏差 1 已裁决接受(单测先例 + import 拖家),本卡沿用;
2. 四张专用卡本卡**只改复制接线**(规格点 3 要求覆盖五卡),未加「结构化输出」标记、未动布局——规格点 2 的 UI 重排按原文只写 GenericToolCard。四卡 fallback 摘要是否也要同款标记,OPEN 交用户裁决;
3. CSS 净 +1 行(`.tool-badge-structured` 紫 tint,复用 `.tool-badge` 基础),远低于规格 ≤10 上限;
4. content 块判定放在 record 分支的 path+body 之前:全文本块匹配器误报率低,而 `{path, content:[块]}` 走扁平化是严格更差的呈现;通用数组分支之前的次序系返工清单明文,已照办。

## 验证

- **单测**:`toolPayload.test.ts` 17 例(六类各一例 + MCP content 包裹形 + 混合块 fallthrough + url/title 缺一省一 + ok/success 锚定值 + 开放形态 `{summary:null,hadStructure:false}` + 200 字符截断);mount 4 例见上。全量 `bun run test`(`bun test --isolate`)**461 pass / 0 fail**(62 文件,7584 expects;#28413 基线 451 + 本卡单测 6 + mount 4)。
- **编译**:`npm run build:dev`(tsc + vite)过;`go build ./...` 与 `go vet ./...` 过(Go 零改动,仅 macOS ld 版本告警噪音)。
- **三端(§4.7)**:改动面 = ChatView 卡片内元素 + 1 行纯 CSS,无条件断点分支,桌面/远程浏览器/PWA 渲染同一组件树;行为验证以 mount 测试为资产(展开/收起/复制是 DOM 交互,不依赖宿主)。#28413 已做过 server 模式浏览器 E2E(含 390×844 PWA 断点),本卡系复审项补齐(复制语义/mount 资产/标记措辞),未重复浏览器 E2E——若复审要求可补跑。真机 iOS/Android 未测(与 M2 同,待用户侧)。

## 下一步

- 停 **completed-ready**,不关 issue、不 push(硬纪律),走复审流程;
- OPEN:四张专用卡的 fallback 摘要是否同款「结构化输出」标记(偏差 2);
- OPEN:`{ok:false, error:"…"}` 只显示「失败」词,error 文本仅在折叠层(规格「成功/失败词」字面执行),若要带出 error 行需用户拍板。
