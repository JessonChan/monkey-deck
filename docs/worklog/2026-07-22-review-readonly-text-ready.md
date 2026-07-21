# 2026-07-22 Review #36 readonly 文案改就绪/Ready 端到端验收结论(PASS)

## 起因

Task #21302(Review):验收 Task #21301「readonly 状态文案改就绪/Ready」的 commit
`e418fa9`(fix(i18n): 改 readonly 状态文案为就绪/Ready)。

重点不是「能否编译」,而是「代码是否真的让 UI 展示出变更后的文案」——拒收
「改了 JSON 但 key 没被引用 / 渲染处没走该 key」的空壳改动。

## 改动核对(commit `e418fa9`)

仅 2 行,纯 i18n 文本值变更:

- `frontend/src/i18n/locales/zh.json:134`:`"readonly": "只读"` → `"就绪"`。
- `frontend/src/i18n/locales/en.json:134`:`"readonly": "Read-only"` → `"Ready"`。
- 其余键(`ready`/`idle`/`readonlyHint` 等)未动。

## 端到端贯通核对(不只看 diff 表面)

确认 key `chat.status.readonly` 真的被渲染、且渲染处用的是这个 key:

1. `ChatView.tsx:64-71` `STATUS_MAP`:`readonly: { key: "chat.status.readonly", cls: "st-readonly" }`
   —— readonly 状态绑定到 `chat.status.readonly`。✓
2. `ChatView.tsx:72-82` `statusInfo()`:status 非 `prompting` 时回退到 `STATUS_MAP[status]`,
   readonly 落到上一步的映射。✓
3. `ChatView.tsx:388`:`const s = statusInfo(props.status, props.activity);`
   → `ChatView.tsx:405`:`{s.key && <span className={`status-badge ${s.cls}`}>{t(s.key)}</span>}`
   —— 状态徽标实际 `t("chat.status.readonly")` 解析,即新文案「就绪 / Ready」。✓
4. 全仓 grep `status.readonly` / `readonly` 确认无其它旁路渲染(无 hardcoded「只读」
   /「Read-only」字面量进状态徽标)。✓

结论:文本值变更真正传导到状态徽标渲染,非空壳。

## 规约合规

- §4.4:本改动不涉及新增裸露结构化格式;状态徽标一直走 i18n,文案为人话。✓
- §0.3 / §6.2:被验收方 worklog 已写、commit 原子(单 commit 仅 2 行 i18n + 一个文档
  不在此 commit),message 说清改了什么 + 为什么(与 ready 语义统一为更中性「就绪」)。✓
- §6.2 不夹带:diff 仅含 en.json/zh.json 两文件,无无关改动。✓

## 次要观察(不阻塞)

- **`chat.readonlyHint`(zh/en line 98)未改**,仍为「只读 — 发消息以继续」/
  「Read-only — send a message to continue」,渲染于 `readonly-banner`
  (`ChatView.tsx:428`)。本次任务范围仅状态徽标文案,提示横幅不在内,
  且「状态=就绪 / 横幅=只读,发消息继续」语义自洽(状态表达可交互性,横幅表达
  当前会话只读、需续接),保留合理。若产品后续希望横幅也统一「就绪」措辞,可再开任务。
- **无自动化测试断言状态徽标文案**:现有测试集(`streamMerge`/`scrollAnchor`/
  `modelPricing`/`filePath`/`sessionDrop`/`MermaidRenderer`/`ModelSelect`)均不覆盖
  ChatView 状态徽标。本改动为极简 i18n 文本值变更(无逻辑分支),以「key 贯通核对
  + build/test 绿」作验收,与前序 Review 同基线(可接受);若日后 ChatView 状态徽标
  抽出为可测单元,建议补「status=readonly → 徽标文本=就绪」断言以锁回归。

## 验证

- `bunx tsc --noEmit`:报错均为环境缺 `node_modules` 类型(react/lucide-react/
  i18next/mermaid/xterm 等 `Cannot find module`),与本改动无关;exit 0。✓
- `bun test`:48 pass / 2 fail。2 fail 为 `MermaidRenderer.mount.test.tsx` /
  `ModelSelect.mount.test.tsx`,报 `Cannot find module 'react/jsx-dev-runtime'`
  (环境模块解析问题)。**已在父 commit `5968587` 还原 i18n 后复跑,同样 48 pass / 2 fail
  / 同样两条 jsx-dev-runtime 报错** → 2 fail 为**预先存在、与本 i18n 改动无关**。✓
- 改动本身仅 2 个 JSON 字符串值,无类型/逻辑变更,不可能引入新失败。

## 结论

**PASS**。`chat.status.readonly` 文案 zh/en 各改 1 行(只读→就绪 / Read-only→Ready),
经 `STATUS_MAP` → `statusInfo()` → `t(s.key)` 真正渲染到状态徽标,端到端贯通、非空壳;
build/test 无新增失败(2 项 fail 为环境预先存在、无关);规约合规。次要观察(提示横幅
措辞 / 缺徽标文案测试)均不阻塞,可合入。

## 改了哪些文件

- `docs/worklog/2026-07-22-review-readonly-text-ready.md`(本文件)。
