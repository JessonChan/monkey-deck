# 2026-08-30 formatHuman 递归 └─ 层级树渲染(#169 / Task #28434)

## 起因

#169:tool fallback 链最后一跳 `formatHuman`(#109 落地)对嵌套 record/数组仍是
「压平成 `a: b: c: 1` 单行」——结构一深就连成一行长串,层级关系不可读。Task #28434
拍板规格 D1-D8:把 `formatHuman` 升级为**递归层级树**(纯文本,零新组件),
ChatView 零改动(函数签名/调用点不变),①-⑦ 摘要命中路径与 preview 语义不动。

## 改法(frontend/src/lib/toolPayload.ts,单文件核心)

- **D1 树化范围**:`formatHuman` 本体重写为树渲染(summarize ⑧ 分支即调它);
  `summarizeArray`/`joinTextBlocks`/①-⑦ 各命中分支零改动,preview 仍单行压平
  (`formatInline(item)` 调用点原样)。`summarizeToolPayload` ⑧ 改传
  `formatHuman(raw, t)`。
- **D2 树形**:每层 2 空格缩进 + `└─ ` 前缀,record 子键逐行;容器键渲染
  `key:` 头行 + 子块。**level-0 行不带前缀**(根 record 键、根数组项),因此
  扁平 record 的输出与旧实现逐字节一致(`status: ok\ncount: 3`),既有 ⑧-flat
  用例零改动。渲染容器仍是既有 `.tool-pre`(white-space:pre-wrap),纯字符串返回。
- **D3 深度上限 4**:超过的子树整体 `formatInline` 压平成单行,不省略;
  **该行刻意不参与 D5 截断**——D3 明写「不截断」,为 D5 的显式豁免特例。
- **D4 数组**:≤8 项逐项树化;>8 前 `PREVIEW_ITEMS`(3) 项 + 独立
  `t(chat.itemsMore)` 尾行(新常量 `TREE_ARRAY_MAX=8`)。数组项落在数组自身
  level(容器下钻才加一层 `└─`,数组「节点身份」不加层),根数组项因此保持裸行。
- **D5 行宽**:新 `clipLine()`(`PREVIEW_LINE_MAX=200` + 省略号),preview 与
  树内叶行**同源共享**同一常量;summarizeArray 原内联三元替换为 `clipLine`
  (语义逐字节不变)。
- **D6 防环**:`formatHuman`/`formatInline` 各持 WeakSet **路径** seen-set
  (进入 add / 退出 delete——只有真祖先环触发 ↻,DAG 复用同对象不误伤);
  遇环渲染 `↻`(纯符号常量 `CYCLE_MARK`,不加 i18n 键)。`formatInline` 的
  seen 参数可选,公开单参调用点语义不变。
- **D7 空形态**:嵌套空值节点(null/`""`/`{}`/`[]`)渲染 `key: (空)`;
  新 i18n 键 `chat.emptyValue`(zh=`(空)`/en=`(empty)`),两语言文件同步。
  **顶层 `{}`/`[]` 仍返回 `""`**——summarizer 的 NO_STRUCTURE 开放形态门
  依赖 falsy 结果,既有「primitives / empty shapes」用例原样通过。
- **签名策略**:`formatHuman(v, t?)` 可选参——ChatView 三个调用点
  (`s.summary ?? formatHuman(raw)` ×2、`!isRecord(raw)` ×1)零改动;生产路径中
  数组在 `extractToolText` 已直送 summarize(L2052),无 t 调用点只可能见到
  空/标量根,**不可能产出带 i18n 的树行**,⑧ 分支则持真 t 全量覆盖。

## 改了哪些文件

- `frontend/src/lib/toolPayload.ts` —— formatHuman/formatInline 重写 + 树常量
  (`TREE_INDENT`/`TREE_PREFIX`/`TREE_DEPTH_MAX`/`TREE_ARRAY_MAX`/`CYCLE_MARK`)
  + `clipLine`/`emptyValueLabel`/`flattenTree` 私有助手;注释英文(§3.7)。
- `frontend/src/lib/toolPayload.test.ts` —— ⑧ nested 与 formatHuman 括号两例
  期望串更新为树形(no-JSON-braces 断言保留并加强);新增五组:#169 深嵌套(>4
  层压平单行)/循环引用(↻ 不死循环,record+array+formatInline 三态)/超长串
  (叶行恰 200 字符截断、根字符串不截断)/大数组(>8 前 3+more、根裸行与
  键下缩进双形态)/空节点(`chat.emptyValue` 渲染 + 顶层空容器仍 "")。
- `frontend/src/i18n/locales/zh.json` / `en.json` —— `chat.emptyValue` 各一条
  (紧跟 `itemsMore`),locales.test.ts parity 不破。
- **零改动红线核验**:`ChatView.tsx` 无 diff(git status 仅 4 文件);
  `RawPayloadDisclosure`/`rawJsonText`(复制契约)零波及。

## 验证

- **单测**:`bun test --isolate` 全量 **486 pass / 0 fail**(65 文件;既有
  no-JSON-braces 断言与扁平 record 精确串原样通过)。
- **类型/构建**:`bunx tsc` 干净;`npm run build`(tsc + vite)通过。
- **Go 门**:`go build ./...` + `go vet ./...` 干净(Go 零改动)。
- **三端矩阵(§4.7)**:本次改动是纯字符串层(同一 `.tool-pre`/pre-wrap 容器、
  零 CSS/组件/断点变更、ChatView 无 diff),三端渲染路径逐字节同源,桌面/移动
  差异零新增由构造保证;三端通道无任何改动面,故未另做端上 E2E(与 #109 落地
  时「卡片内部元素」不同,本次连卡片 DOM 都不动)。
- **worktree 环境坑**:新 worktree 缺 `node_modules` 与 `frontend/bindings`
  (Wails3 生成物不入库),首跑 7 个失败全是 `Cannot find module '../bindings/…'`;
  `bun install` + `wails3 generate bindings`(注意:本版 CLI 是 `generate bindings`
  子命令,不是 `gen bindings`)后全绿,与本次改动无关。

## 下一步

- 无(任务即终:不派 review、不 push、不关 issue)。
