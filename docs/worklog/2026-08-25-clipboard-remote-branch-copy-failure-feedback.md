# 2026-08-25 #129 copyText 远程分流 + execCommandCopy(iOS 配方/零 await)+ boolean 返回 + 调用点失败反馈

## 起因

Task #24277 / issue #129:远程浏览器端(手机/PWA,§1.8)点「复制」拿到的是空剪贴板,而 UI 照样显示「已复制」。

## 根因(两层)

1. **通道错位**:`copyText` 首选 Wails3 `Clipboard.SetText`。该调用在远程浏览器端经 `/wails/runtime` transport 走到**桌面进程**,写的是**桌面的**剪贴板——手机本地剪贴板没有任何内容,复制「成功」却无处可贴。
2. **iOS Safari 的通道缺失**:手机直连的常见形态是明文 HTTP 局域网(公网须 TLS 反代,§1.8),非 secure context 下 `navigator.clipboard` **不存在**;而旧 execCommand fallback 是「Wails3 await 失败 → navigator await 失败 → execCommand」的链式 await,iOS 只在手势存续期内认可 `execCommand("copy")`,前两跳 await 已把手势烧掉,fallback 必然失败。
3. (反馈缺失)旧模式 `await copyText(x); setCopied(true)` 无视返回值,失败也亮 Check——假的「已复制」。

## 改法

**`frontend/src/lib/clipboard.ts`(核心)**:

- **isRemoteClient 分流**:`__mdRemote`(custom.js 注入)为 true 时**跳过 Wails3 通道**,只走浏览器本地通道——远程端要的是手机自己的剪贴板,桌面的剪贴板永远不对。分流在第一个 await **之前**完成,保证手势路径不被异步跳拖慢。
- **`execCommandCopy(text): boolean` 提取为同步导出函数**,iOS 配方:Range/Selection 选区(`selectNodeContents` + `getSelection().addRange`)+ `contentEditable=true/readonly=false` 翻转 + `setSelectionRange`,**无条件应用不做 UA 嗅探**(§5.3:桌面浏览器上这套是安全超集,iPad-as-Mac 之类的 UA 谎报也不怕)。函数体**零 await**;关键路径(远程 + 明文 HTTP → `navigator.clipboard` 不存在)从点击处理器**同步直达**(async 函数体在首个 await 前同步执行),手势存活。
- **boolean 契约**:`copyText` 返回 `Promise<boolean>`(任一通道成功与否),永不 throw。通道序:桌面(非远程)Wails3 SetText → navigator.clipboard(secure context)→ execCommandCopy。
- **`copyTextQuiet`**:无反馈面调用点(右键菜单点击即关、选区工具栏 run 后即散)的 fire-and-forget 变体,失败打 `console.warn`(对用户静默,对开发者可观测)。

**调用点失败反馈**:

- 新 hook `frontend/src/hooks/useCopyFeedback.ts`:`{ copied, failed, copy }` 瞬态(1200/1500ms 自复位,单定时器 + 卸载清理),取代各组件手写的 `setCopied + setTimeout` 样板。
- **有反馈面的 10 处全部接入**(失败 = X 图标 + `common.copyFailed` 文案,en/zh 已加):CopyIconButton(另挂 `data-copy-failed` 供测试)、ChatView 的 MessageActions/SummaryCopyBtn/GenericToolCard I/O/BashToolCard 命令/CodeBox、DiffView、CollapsibleText、MermaidRenderer(MermaidHeader 加 `failed` prop)、EditorPane。
- RemoteSettingsPane(桌面专属 pane)的 token/配对链接/URL 复制失败路由到既有 `setError` 槽。
- 无反馈面 5 处(Sidebar×3、FilePanel×1、ChatView copyPath + 选区工具栏 copy)换 `copyTextQuiet`。
- 顺带补齐 GenericToolCard I/O 复制按钮与 CodeBox 的 §4.5 tooltip(此前裸图标/无 tooltip)。

## 改动文件

- `frontend/src/lib/clipboard.ts`(核心:分流 + execCommandCopy + boolean + quiet)
- `frontend/src/lib/clipboard.test.ts`(新增:8 测试,锁死远程不触 SetText / boolean 契约 / 同步清理 / quiet 告警)
- `frontend/src/hooks/useCopyFeedback.ts`(新增)
- `frontend/src/components/`:CopyIconButton(+mount 测试)、ChatView、CollapsibleText、DiffView、EditorPane(+edit.mount 测试兼容 .js bindings)、MermaidRenderer、RemoteSettingsPane、Sidebar、FilePanel
- `frontend/src/i18n/locales/{en,zh}.json`(`common.copyFailed`)

## 验证

- `bunx tsc --noEmit` 干净;`bun run build` 过(chunk 体积 warning 存量)。
- `bun test --isolate`:264 个测试,259 过;fail 5 个**全部**是既有 NewSessionModal fixture 漂移(onConfirm 新增 `mcpServerIDs` 期望未更新,stash 干净树复跑同样失败,与本改动无关)。新增 10 个测试(clipboard 8 + CopyIconButton 2)全绿。
- 顺带修:EditorPane.edit.mount.test.tsx 硬编码 `chatservice.ts`,本机 wails3 beta.3 只出 `.js` → ENOENT 整文件 error;改为 .ts 优先 .js 兜底(该文件 5 测试恢复运行,全过)。
- **三端矩阵(§4.7/§5.6)**:改动全部是通道选择/交互反馈逻辑,零布局/断点/样式变更。桌面 GUI——Wails3 通道仍是第一优先,行为不变(单测锁死);复制按钮新增的失败分支在桌面不可达(SetText 稳定成功),渲染输出与改前一致。远程浏览器——分流主战场,`__mdRemote → 跳过 SetText` 由单测锁死。PWA/iOS——execCommand 配方 + 零 await 手势保活;**真实 iOS 设备上的 execCommand 复制(明文 HTTP 直连)需真机实测**才能最终确认(仿真环境无法验证手势存续,沿用 M2「待真机」convention)。后端零改动。

## 下一步

- 真机(iOS Safari / Android Chrome,明文 HTTP LAN + PWA standalone)实测:对话/代码块/工具卡复制是否落入手机剪贴板。
- NewSessionModal 测试 fixture 的 `mcpServerIDs` 漂移与本任务无关,留给对应 owner 修。
