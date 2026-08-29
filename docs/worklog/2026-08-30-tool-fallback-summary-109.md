# 2026-08-30 tool fallback 人话摘要 + 原始 JSON 折叠(#109 / Task #28413)

## 起因

#109:tool 执行中(pending / in_progress)或未知 harness 的 tool 载荷,在 `extractToolText`
已知 key(output/stdout/content/…)全部未命中时,直接 fallback 到 `formatHuman`,而
`formatInline` 对嵌套对象 `JSON.stringify` —— 用户看到原始 JSON,违反 §4.4(禁止裸露
结构化/技术格式)。

Task #28413(父规格 #28412「四点拍板定版」)要求:①ChatView.tsx 新增
`summarizeToolPayload`(extractToolText fallback 链中、formatHuman 之前),覆盖六类
载荷形态;人话摘要为主,原始 JSON 折叠收起。

> ⚠️ 规格复原说明:gh CLI 未认证、#28412 为编排侧任务号(GitHub 上不存在),任务文本
> 在「/{matches」处截断,六类清单只可见前三类(数组「共 N 项」+前 3 项预览 /
> {path} 开头路径行优先 / {matches…} 形数组字段)。其余以 #109 正文四点修法建议 +
> 任务标题(人话摘要 + 原始 JSON 折叠)为准复原,实现与复原规格的差异见下「偏差」。

## 根因

1. fallback 链最后一跳 `formatHuman` → `formatInline` → `JSON.stringify`(嵌套对象)。
2. in_progress 的 partial 载荷(结构不完整)已知 key 未命中 → 原样 JSON 上屏。
3. 顶层**数组**载荷(grep/glob 列表、record 数组)走 `!isRecord` 分支,同样不过摘要器。

## 改法

**新库 `frontend/src/lib/toolPayload.ts`**(纯函数,无 React 依赖,可单测):

- `summarizeToolPayload(raw, t)` 六类识别(优先级序):
  1. 数组(非路径项)→「共 N 项」+ 前 3 项单行预览 +「…另有 X 项」;
  2. 路径行数组(全项为路径 / grep `file.go:12:` 行)→ 原样逐行,不加计数头(路径行优先);
  3. record 含主导数组字段(matches/results/files/items/entries/lines/rows/paths/list/data/output)→ 同 ①;
  4. record 含 path + 正文(content/text/body/…)→ 路径首行 + 正文;
  5. 扁平 record → 「键: 值」逐行(formatHuman 透传);
  6. 嵌套 record → 递归扁平化 `a: b: c: 1`(formatInline,永不 JSON.stringify)。
- `formatInline` 改为递归扁平化(嵌套对象/数组逗号连接),删掉 `JSON.stringify` 分支;
- `formatHuman` / `isRecord`(规范守卫)/ `pickStr` / `extractFilePath` 一并迁入,
  ChatView 删本地定义改 import(clean cutover);
- 预览项单行压缩 + 200 字符截断;`TranslateFn` 结构类型保持库 UI 无关,i18n 文案
  (`chat.itemsTotal` / `chat.itemsMore`)由调用方 t() 注入。

**ChatView.tsx 接线**:

- `extractToolText(raw, t)` 加 t 参;链序:字符串原样 → **数组直送 summarize**
  (isRecord 不含数组,必须显式分流,E2E 中发现补上)→ record 已知 key → meta.output
  → `summarizeToolPayload ?? formatHuman`(均标 fallback);
- 新组件 `RawPayloadDisclosure`(fallback 时把原始载荷收进 `<details>`,可展开调试但
  绝非第一眼)+ `ToolRunningHint`(spinner +「执行中…」);
- 五张卡片统一行为:**running + fallback 输出 → 占位符替代 partial 载荷**;**完成后
  fallback → 摘要正文 + 折叠原始 JSON**;Read 卡空态 running 时也走占位符(原先误显
  「无内容」)。

**i18n**:`chat.toolRunning` / `chat.rawData` / `chat.itemsTotal` / `chat.itemsMore`
(zh + en 同步,locales.test.ts 锁 parity)。**CSS**:`.tool-running-hint` /
`.tool-raw*` 纯 CSS(details 原生折叠 + ▸/▾ marker),零 JS 状态、零重绘开销(§4.6)。

## 偏差(与复原规格的显式差异)

1. `summarizeToolPayload` 落在 `lib/toolPayload.ts` 而非 ChatView.tsx —— 规格文字指定
   ChatView.tsx,但该文件无单测先例且 import 会拖入 ReactMarkdown/mermaid 全家桶;
   参照 `countDiffLines → lib/diff.ts` 的既有抽取先例落库,行为链序不变(extractToolText
   内 formatHuman 之前调用,规格本意)。
2. ③ 之后的六类清单 4-6 按 #109 修法建议 + 实际 harness 载荷形态复原(path+body、
   扁平 record、嵌套 record);若 #28412 原文另有定义,以原文为准补齐。

## 验证

- **单测**:`lib/toolPayload.test.ts` 11 例(六类识别 / 数组直送 / 无 JSON 断言 /
  200 字符截断 / 空形返 null);全量 `bun test --isolate` **451 pass / 0 fail**。
- **编译**:`npm run build`(tsc + vite)通过;`go vet ./...` 通过(Go 零改动)。
- **E2E(§5.5 server 模式,隔离 HOME,真后端 + 真 SQLite + 真事件流)**:
  种入 5 条未知形态 tool_call(in_progress partial / matches 数组 / 嵌套 record /
  read 的 path+content / grep 路径行数组),Chromium 实测断言全过:
  - 运行中卡:spinner +「Running…」,partial 载荷不上屏;
  - matches 卡:「4 items + 3 条 path: x, line: n 预览 + …and 1 more」;
  - 嵌套卡:「report: status: ok, detail: count: 7」(正则断言正文无 `{`+`"` JSON);
  - grep 数组卡:路径行原样;原始 JSON 只存在于折叠 `<details>` 内(默认收起);
  - 390×844 视口复测(PWA 断点):全部元素正常,无布局破坏。
- **三端矩阵(§4.7)**:改动为 ChatView 卡片内部元素 + 纯 CSS,无条件断点分支;
  远程浏览器端已实测(即本次 E2E 形态);桌面 GUI 同一组件树(webview 渲染差异不在
  本次改动面);PWA 断点已模拟验证。**真机 iOS/Android 未测**(与 M2 同,待用户侧)。

## 下一步

- OPEN:若用户补发 #28412 全文,按原文核对六类清单 4-6 与文案措辞;
- 上游机会:Reasonix 等 harness 侧补 `messageId`/规范 payload 后,多数 fallback 路径
  自然消失,本摘要器保持兜底位。
