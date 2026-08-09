# 2026-08-10 Review #83 拖拽文件到聊天区 前端 (APPROVE, Task #24256)

**起因**:Task #24256 对 #24255 / issue #83(3 commit:`bf952b3` 后端桥接 +
`cdc4da5` 前端分流/高亮 + `2cf791d` worklog)的前端部分做 Frontend Reviewer
端到端验收。本审只评前端(`frontend/src/`)——后端 `drop.go`/`desktop.go`/
`window.go`(Go,只转发不路由)交后端 reviewer。

## 复审范围

- `lib/dropFiles.ts`(新):`relativeToRoot` + `routeDroppedFiles`(纯路由,readImage 注入)。
- `lib/dropFiles.test.ts`(新):16 用例。
- `components/ChatView.tsx`:`data-file-drop-target` + `data-md-session` + MutationObserver
  镜像 `file-drop-target-active` class → dropActive state → `.chat-drop-overlay`。
- `App.tsx`:订阅 `chat:files-dropped`,按 session cwd/imageSupport 路由,应用 per-session
  mentions/draft/attachments/images;窗口作用域(popout 只收自己 / main 跳过 popped-out)。
- `index.css`:`.chat-view` 加 `position: relative` + `.chat-drop-overlay/.chat-drop-card`。
- `i18n/locales/{en,zh}.json`:`chat.dropTitle` / `chat.dropHint`。

## 正确性 ✅

### Wails3 class / attribute 名(关键怀疑点,已证清白)

初审时在 Go module 缓存的一个**陈旧独立测试 bundle**(`test/dnd-npm-runtime/.../index-*.js`,
minified)里看到 `w="n"` + `classList.add(w)`,一度怀疑运行时加的 class 是 `"n"` 而非
`file-drop-target-active`——若真则 dropActive 永不 true、overlay 永不渲染(致命)。

**核对权威源** `@wailsio/runtime/src/window.ts:15-16`(Wails 实际注入的运行时):
```
const DROP_TARGET_ATTRIBUTE = 'data-file-drop-target';
const DROP_TARGET_ACTIVE_CLASS = 'file-drop-target-active';
```
`handleDragOver`(`window.ts:144`)+ HTML5 `dragover`(`window.ts:718`/`762`)两路都
`classList.add(DROP_TARGET_ACTIVE_CLASS)`。**ChatView 用 `file-drop-target-active` 正确**,
那个 minified bundle 是旧 standalone 测试,非生产运行时。✅

### MutationObserver 镜像方案 ✅
- `className="chat-view"` 是常量 prop,React reconciler 不重写 className → Wails 加的 class
  跨重渲染存活。注释已述此点,推理正确。✅
- `typeof MutationObserver === "undefined"` 守卫(happy-dom 无 MO)→ 测试环境 overlay 不渲染,
  合理降级(测试不验 drop)。✅
- effect 依赖 `[]`(mount 一次),`viewRef.current` 稳定,observer cleanup `disconnect` 到位。✅

### `data-md-session` 回传链路 ✅
React 渲染 `data-md-session={props.sessionId}` 为真实 DOM 属性 → 运行时 `HandlePlatformFileDrop`
序列化目标元素**全部 attributes**(`window.ts` 里 `elementDetails.attributes[name]=value`)
→ Go `event.Context().DropTargetDetails().Attributes["data-md-session"]`(`drop.go`)→ emit
回前端 `sessionId` 字段。全链路对齐。sessionId 为 undefined 时 React 省略属性 → 后端 sid=""
→ 前端 `if (!sid) return` 静默,无选中会话时 drop 惰性。✅

### `relativeToRoot` 路径边界 ✅
- **整段前缀匹配**(`al.startsWith(rl + "/")`):拒绝 sibling 前缀(`/Users/me/proj-evil`
  不是 `/Users/me/proj` 的子项)+ 拒绝 `../` 逃逸。专项测试覆盖(`proj-evil` 用例)。✅
- 大小写不敏感(容忍 Windows 盘符 / HFS+),返回值保留原 casing。✅
- 分隔符归一(`\` → `/`、collapse repeat、strip trailing slash)。✅
- root 本身 → `""`(dropFiles 里跳过,不出无意义 `@.`)。✅

### `routeDroppedFiles` 三路分流 + best-effort 退化 ✅
- worktree 外 → paperclip 附件(绝对路径,与 `PickFiles` 一致)。✅
- worktree 内非图片 / 目录 → `@mention`(相对 cwd,agent 自读)。✅
- worktree 内 ACP 图片(png/jpg/jpeg/webp/gif)+ imageSupported → 内联图片(`readImage`
  注入,生产 = `ChatService.SessionReadImage`)。✅
- 图片读失败 / agent 不支持 image / 非 ACP 图片扩展名(bmp/svg/ico)→ **退化为 @mention**,
  绝不静默丢文件(best-effort,与 paste 同风格)。9 个路由用例覆盖全部分支。✅

### mention token 与 Composer submit 过滤对齐 ✅(关键消费端)
`dropFiles.ts:140` 生成 `"@" + rel + " "`(尾随空格)。Composer submit 过滤
(`Composer.tsx:341-347`):`token = "@" + m.path` → `t.indexOf(token)` → 判 `after` 处
`/\s/` 或 EOF。drop 产出的 token(带尾随空格 / 在末尾)必命中边界 → mention 被 submit 保留。
若不带尾随空格,当 token 后紧跟其它非空白时会被误判删除——**尾随空格是必要的,实现正确**。✅

### cwd root 与后端对齐 + 双层路径 containment ✅
`App.tsx:693` `root = sess.worktreePath || proj?.path || ""` 镜像后端 `cwdOf`。
`relativeToRoot` 算出的 `rel` 喂 `SessionReadImage`(`chat.go:1267`)→ 后端 `fsview.ReadImage`
用 `safeJoin(root, rel)` 再防一层 `../`/symlink 越界。前端整段前缀匹配(防逃逸)+ 后端
safeJoin(防符号链接)= 两层 containment,与 §5.3「尊重数据源」契合。`SessionReadImage` 返回
`{dataUrl, extension}`(json tag),前端 `readImageForDrop` 只读 `dataUrl`,shape 对齐。✅

### 窗口作用域 + effect 依赖 ✅
- popout 仅处理自己的 session(`sid !== popoutMode` → return);main 跳过已 popped-out 的
  session(`poppedSessionIdsRef.current.has(sid)` → return)。一 drop 只被显示该 session 的
  窗口处理。✅
- effect deps `[refreshProjects, applyEvent, refreshSessions, drainSession, isPopout, popoutMode]`:
  handler 直接捕获 `isPopout`/`popoutMode`(非 ref),进 deps 正确(变化重订阅);其余查表用
  ref(`projectsRef`/`imageSupportedBySessionRef`/`sessionsByProjectRef`/`poppedSessionIdsRef`)
  不进 deps,避免无谓重订阅。✅
- state 更新全用 functional updater(`prev => ...`),并发 drop / 与其它 setState 竞态安全。✅

### i18n / CSS / data-testid ✅
- en + zh 均有 `chat.dropTitle` / `chat.dropHint`(`locales.test.ts` 2/2 pass,leaf key 集合一致)。✅
- CSS 主题变量全存在(`--elev-2` / `--accent` / `--accent-2` / `--text-3` 均见 `index.css` 顶);
  `.chat-view` 加 `position: relative` 给 `position:absolute; inset:0` overlay 做包含块;
  `pointer-events:none` 非交互(不打扰 drag / 下层 UI);z-index 50。✅
- `data-testid="chat-drop-overlay"`(§4.2)。✅

## 无回归 onPaste / @me ✅
Task 标题特别声明「无回归 onPaste/@me」。核对:drop 流程**只新增** `chat:files-dropped`
订阅 + 在既有 per-session state 上 append(mentions/draft/attachments/images),**不触碰**
paste 路径(`Composer.addImageFiles` / `IMAGE_MIME_ALLOWED`)与 @mention 自动补全
(`pickMention` / `drillMention`)。图片分流复用同一 `imagesBySession` state 但经独立
`routeDroppedFiles` 计算,与 paste 入口互不干扰。@mention token 格式与 autocomplete 一致。
**无回归**。✅

## 观察项(非阻塞 nit,不改)

### #1 drop 追加 mention 不去重
`App.tsx:698` `[...(prev[sid] ?? []), ...r.mentions]` 直接 append;而 autocomplete
`pickMention`(`Composer.tsx:411`)有 `if (!mentions.some((x) => x.path === node.path))` 去重。
若用户**重复拖同一文件**(或拖一个已 @mention 过的文件),mentions 数组出现重复 path 条目 →
submit 时两条都通过 token 过滤 → 发出重复 `ResourceLink`。影响小(agent 看到同一文件两次),
agent 侧通常无害。建议后续在 drop append 前 dedup(对齐 pickMention)。**不阻塞**。

### #2 无真机跨平台拖拽实测
worklog「下一步」已列:未在 macOS WebKit + Win WebView2 实测(本环境无 GUI)。形态与 Wails3
官方 `examples/drag-n-drop` 一致,但 §4.6 跨平台一致性仍需桌面实测确认高亮渲染 / 分流。预期可
能的差异点:Win WebView2 与 macOS WebKit 的 overlay 背景半透明 / dashed border 渲染细节。**记 OPEN,
非本审阻塞项**。

## 验证(acceptance gate)

1. `cd frontend && bun install` → 364 packages。
2. **`cd frontend && bun test src/lib/dropFiles.test.ts`**:**16/16 pass**(34 expect calls)。
   覆盖:relativeToRoot 边界(inside/nested/root/escape/backslash/case)+ 三路分流(external/
   internal-non-image/internal-image/imageSupported-fallback/read-fail/non-acp-ext/root-skip/
   mixed-batch/order)。
3. **`cd frontend && bun x tsc --noEmit`**:App.tsx / ChatView.tsx 的报错**仅**为既有
   `Cannot find module '../bindings/...'`(worktree 缺 `wails3 gen bindings` 产物),**无** dropFiles
   / drop 相关类型错。dropFiles.ts 0 错。
4. **`cd frontend && bun test`(全量)**:184 pass / 31 fail / 9 errors。与改前(父 commit
   `1787ab9` 同环境跑)**完全一致 31 fail / 9 error**(均为既有失败:ChatView 虚拟化 / mermaid /
   harness 升级开关 / queue countdown / new-session-modal / msg-meta duration,缺 bindings 所致,
   与本改动无关)。**无新增失败 = 无回归**。✅
5. i18n parity:`locales.test.ts` 2/2 pass。

## Verdict:APPROVE

dropFiles.ts 路由纯函数完备(相对路径边界 + 三路分流 + best-effort 退化,16 测试覆盖)、
ChatView MutationObserver 镜像方案正确(Wails3 `file-drop-target-active` class 名经权威源
`window.ts` 核实,React 不覆盖 Wails 加的 class)、`data-md-session` 回传全链路对齐、mention
token 与 Composer submit 过滤边界一致、cwd root 镜像后端 cwdOf 且 SessionReadImage 双层
containment、窗口作用域与 effect 依赖正确、i18n zh/en 同步、CSS 主题变量齐全且 pointer-events
非交互、无 onPaste/@me 回归——全部过关。两项观察 item(drop mention 不去重 / 无真机实测)均非
阻塞,记为后续可选。建议合入。

## 改了哪些文件

- `docs/worklog/2026-08-10-review-drag-drop-files-frontend.md`(本条,新增)。
