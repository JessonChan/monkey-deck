# 2026-07-14 i18n 框架落地 + 主视图文案抽取(zh/en)

## 起因
Task #15099:i18n 基础落地 —— 框架 + 主视图文案抽取 + zh/en 两套 locale。
此前所有 UI 文案均为硬编码中文字面量,无法切换语言。需选型(优先已有依赖)、
搭框架(初始化 + Provider + 语言切换入口 + 持久化)、把主视图硬编码文案抽成 i18n key。

## 选型
`i18next` + `react-i18next` 已经在 `frontend/package.json` 的 dependencies 里
(v26 / v17),无需新引依赖。React 生态事实标准,轻量、可 tree-shake,符合 §5.3
成熟库优先。不再考虑其它方案。

## 框架
- `frontend/src/i18n/index.ts`:初始化 i18n 实例(`initReactI18next`),
  - resources 内联 zh/en 两套(构建期打包,免异步加载)。
  - `detectInitialLanguage()`:localStorage(`md:lang`)> navigator.language 兜底 > 默认 zh(对齐现状中文 UI)。
  - `setLanguage(lang)`:切语言 + 持久化(localStorage)。
  - 导出 `AppLanguage` / `LANGUAGES` / `initialLanguage`。
- `frontend/src/main.tsx`:`import "./i18n"`(副作用初始化,App 挂载前完成)。
- 语言切换入口:Sidebar 底部的语言选项(zh / en 两个按钮,点击 `setLanguage`),
  tooltip 用 `settings.languageTip`。切换即时生效(react-i18next 触发重渲染)。

## locale
`frontend/src/i18n/locales/{zh,en}.json`:按域分组(common / app / sidebar / newSession /
chat / composer / queue / terminal / filePanel / gitPanel / sidePanel / filePreview /
collapsibleText / settings)。两套 key 完全对齐(各 244 个),插值用 `{{name}}`。
默认 zh(对齐现状)。

## 文案抽取(主视图 + 关联组件)
把硬编码中文字面量替换为 `t("key")` / `t("key", { ... })`。涵盖:
- `App.tsx`:错误兜底 / 合并结果 / 无活动 session。
- `Sidebar.tsx`(含语言切换入口)、`NewSessionModal.tsx`。
- `ChatView.tsx`:所有 tool 卡片(edit/read/search/bash/generic)、权限裁决卡、
  执行计划时间线、思考块、消息复制、代码块复制。
  - **顺带修了一个 tsc 编译错误**:既有未提交改动把 `TOOL_STATUS_MAP` 从
    `{ label }` 改成 `{ key }`(i18n key),但 `SearchToolCard` / `GenericToolCard` /
    `BashToolCard` 三处仍读 `st.label` 且 fallback 写死 `"未知"` → tsc 报
    `Property 'label' does not exist`。统一改成 `stInfo.key ? t(stInfo.key) : ...`。
  - `PLAN_STATUS_ICON` 同理从 `label` 改 `key`。
- `Composer.tsx`:placeholder / 长文本折叠 / 斜杠命令(desc+insert 改 i18n key,
  插入时翻译)/ @ 提及菜单 / model-select 标签 / token 用量 tooltip / 各按钮 tooltip。
- `FilePanel.tsx`:工具栏 / 树操作(新建/重命名/删除)/ 预览覆盖层 / 模态框(标题+占位+按钮)/ 错误兜底。
- `GitPanel.tsx`:标题 / 提交框 / 暂存-工作区两组 / 逐文件操作 / diff 加载态 / 合并按钮 / 空态。
- `CollapsibleText.tsx`(ChatView + GitPanel 共用):行计数 / 折叠提示 / 复制 / 路径链接 tooltip。
  - `lineUnit` 改为可选,缺省取 `t("collapsibleText.lineUnit")`;调用方一律传翻译后的单位。
- `SidePanel.tsx` / `TerminalPanel.tsx` / `QueuePanel.tsx` / `FilePreviewOverlay.tsx` /
  `PathLinkified.tsx`:tab 标题、tooltip、空态、错误兜底、路径链接 tooltip。
  - TerminalPanel 右键菜单里局部变量 `t` 与 i18n `t` 同名遮蔽 → 重命名为 `tab`。

## 改了哪些文件
- 新增:`frontend/src/i18n/index.ts`、`frontend/src/i18n/locales/zh.json`、`frontend/src/i18n/locales/en.json`。
- 改:`frontend/package.json` / `bun.lock`(i18next + react-i18next 依赖)、`frontend/src/main.tsx`。
- 改组件(接 `useTranslation` + `t()`):`App.tsx`、`Sidebar.tsx`、`NewSessionModal.tsx`、
  `ChatView.tsx`、`Composer.tsx`、`FilePanel.tsx`、`GitPanel.tsx`、`CollapsibleText.tsx`、
  `SidePanel.tsx`、`TerminalPanel.tsx`、`QueuePanel.tsx`、`FilePreviewOverlay.tsx`、`PathLinkified.tsx`。

## 验证
- `cd frontend && bun run build`(tsc + vite production):通过,无类型错误。
  (需先 `wails3 generate bindings` 生成 `frontend/bindings/`,该目录不入库。)
- locale JSON:两套均为合法 JSON;key 集合完全一致(各 244 个,无单边缺失)。
- 全量扫描 `frontend/src/App.tsx` + `components/*.tsx`:无残留硬编码中文 UI 字面量
  (只剩注释 / JSDoc)。
- `go build ./...` / `go vet ./...` / `go test ./...`:全通过(本 task 仅改前端,
  Go 侧无改动;dist embed 因本地 `bun run build` 产出的 `frontend/dist` 存在而正常)。

## 下一步 / OPEN
- 语言切换入口目前只在 Sidebar 底部;后续可考虑加到正式「设置」页(当前无设置页)。
- agent 产出的内容(思考 / 回复 / 工具 I/O)是 agent 自己的语言,不归 i18n 管(只管壳)。
- 次要文案(如 CodeViewer 内部、终端 xterm 的右键菜单 unicode 等)已尽可能覆盖;
  若后续发现遗漏,按相同模式增量补 key 即可。
- 可选:`references/` 下 openwork 的 i18n 组织方式可作后续「设置页」参考(仅形态)。
