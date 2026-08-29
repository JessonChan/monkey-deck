# #149 Files 面板拖拽 → 聊天区 @mention:HTML5 通道 + appendMentionPath(卡 #28404,规格 #28403)

## 起因

Task #28404(父 issue #28403 四点拍板):FilePanel 文件行可拖出,落到聊天区即以 `@<rel> ` 追加进 composer 草稿并登记提及——补全「文件引用」的第二入口(第一入口是 composer 内 `@` 模糊搜索)。硬边界:**OS 文件拖拽的 Wails 原生通道(#24255/#83)零影响**;单文件 MVP(面板单选);coarse pointer 不启用。

## 双通道分流(核心设计)

聊天区根节点同时是两个 drop 通道的落点,判别靠 `dataTransfer.types`(dragover 期间 payload 数据受保护,types 是唯一可读信号),各认各的 MIME,互不越界:

```
drag 悬停 .chat-view
  │
  ├─ types 含 "application/x-md-panel-file"(应用内面板拖拽,#149 新通道)
  │    ├─ dragover:React onPanelDragOver → preventDefault(整个聊天区可落)+ dropEffect=copy
  │    │            + mentionDropActive=true → .chat-drop-overlay 变体(testid chat-mention-drop-overlay,文案「释放以 @引用」)
  │    └─ drop:preventDefault → parse payload{sessionId, path}
  │         ├─ sessionId ≠ 本窗口可见 session → 忽略(跨窗口防护)
  │         ├─ root(worktreePath||project.path)空 → 忽略
  │         ├─ relativeToRoot(root, root+"/"+path) 归一;null/""/含 ".." 段 → 忽略
  │         └─ composerRef.appendMentionPath(rel) → 草稿末尾追加 "@<rel> " + mentions 去重登记
  │
  └─ types 含 "Files"(OS 文件,#83 既有通道)
       ├─ dragover:@wailsio/runtime 在 documentElement 级全局 preventDefault(其原生 drop 机制,实证见下),
       │           本通道 handler 判非自有 MIME 直接 return,不设 overlay、不碰 dropEffect
       └─ drop:同 return → 原生通道照旧(backend internal/chat/drop.go → chat:files-dropped 事件)
```

实证发现(留档):`@wailsio/runtime/dist/window.js` 的 `dragover` 全局监听对 `types.includes('Files')` 的拖拽**一律 preventDefault**(注释原话 "Always prevent default to stop browser navigation")——即 OS 文件拖拽的 dragover 在生产与本测试环境中都由 runtime 层认领。因此「#83 零回归」的正确断言不是 `defaultPrevented=false`(那是 runtime 的),而是**本通道三不动**:overlay 不出现、草稿不动、mentions 不动。

## 防护矩阵

| 场景 | 判定点 | 行为 |
|---|---|---|
| OS 文件拖拽(dragover) | types 无自有 MIME | 本通道零介入,原生通道照旧 |
| OS 文件拖拽(drop) | 同上 | 不 preventDefault(本通道视角),不追加 |
| 跨窗口:payload.sessionId ≠ 落点 session | onDrop 显式比对 | preventDefault(认领)但忽略,草稿/提及不变 |
| payload JSON 损坏 / 非对象 / 空 sessionId/path | readPanelFilePayload 严格校验 | 返 null → 忽略 |
| path 归一后逃逸 root(root 本身、".." 穿越) | relativeToRoot=null/"" + ".." 段显式拒绝 | 忽略 |

".." 单独点名的理由:relativeToRoot 的前缀检查**不折叠点段**(`/root/../x` 前缀命中)——OS 通道的输入是 OS 给的绝对路径,天然无 `..`;面板 payload 是客户端自造 JSON,属不可信输入,在自己通道的边界上拒绝(共享的 relativeToRoot 不动,#83 通道行为零变化)。

## 改动文件

- `frontend/src/lib/panelDrop.ts`(新):MIME 常量 + payload 读写契约(writePanelFilePayload / hasPanelFilePayload / readPanelFilePayload),两端唯一事实来源。
- `frontend/src/components/FilePanel.tsx`:树文件行 `draggable={!coarsePointer}` + `onDragStart` 写 payload + `effectAllowed="copy"`(拖影用浏览器行快照默认值,不碰 dataTransfer 其余);`data-testid="tree-file-row"`+`data-path`(§4.2);模块级 `coarsePointer` 门(同 Composer/App 范式)。目录行不可拖(MVP 单文件)。
- `frontend/src/components/Composer.tsx`:转 `forwardRef`,导出 `ComposerHandle.appendMentionPath(rel, name?)`——pickMention(:490)同款语义但锚定草稿末尾:分隔空格(草稿非空白结尾时)+ `@<rel> ` 追加 + mentions 按 path 去重 + `cursorRef` 同步防 @ 面板重开 + 解折叠 + rAF 聚焦落 caret。
- `frontend/src/components/ChatView.tsx`:根节点 `onDragOver/onDragLeave/onDrop`(dragleave 用 relatedTarget contains 判真离开);`mentionDropActive` overlay 变体(FileText 图标 + `chat.dropMentionTitle`,与原生 overlay 互斥——一次拖拽只能携带一种 MIME);`composerRef` 挂到 Composer。
- `frontend/src/i18n/locales/{zh,en}.json`:`chat.dropMentionTitle`(zh「释放以 @引用」/ en "Release to @mention")。
- `frontend/src/i18n/locales.test.ts`:新增文案钉死断言(键值双语各一刀)。
- `frontend/src/components/PanelDrag.mount.test.tsx`(新)+ `frontend/src/components/FilePanel.coarse.mount.test.tsx`(新):规格硬测试四条,见下。

## 验证

- **规格硬测试(mount 四条)**:①dragstart payload(JSON 逐字节比对 + effectAllowed=copy)+ overlay 变体出现 + drop 追加 `@README.md ` 与登记;同文件二拖 → token 再追加、登记去重。②payload sessionId 不匹配 → 草稿/提及零变化。③OS Files 拖拽 overlay 不现、草稿不动;坏 JSON / ".." 穿越认领但忽略。④coarse 指针(matchMedia 先置后 import,模块级常量只在 import 时求值)文件行 `draggable="false"`,目录行两态都无 draggable。
- **全量**:`bun test --isolate` → **435 pass / 0 fail**(60.7s;含 dropFiles.test.ts(#83 既有用例)零回归)。
- **构建**:`npm run build:dev`(tsc + vite)通过。
- **三端**(§4.7,验证边界留档):逻辑层由上述 mount 测试锁定(happy-dom + 真 React 树;DataTransfer 以真实接口面 fake——React 只读 nativeEvent.dataTransfer,对 handler 不可区分);i18n 双语由 locales.test 钉死。**桌面 GUI 实机拖拽手感(拖影观感/overlay 视觉/WebKit DnD 事件时序)与 PWA/远程浏览器实机回归未在本环境执行**,overlay 复用既有 .chat-drop-overlay/.chat-drop-card 样式(pointer-events:none、z-index 50 不变),远程浏览器端 `isRemoteClient()` 守卫未被触碰——留待 fe-review/真机实测确认。
- 环境注:worktree 缺生成物 `frontend/bindings/`(不入库),已 `wails3 generate bindings` 补齐后全量测试方可绿(6 个直连 bindings 的既有测试此前的失败与本次改动无关)。
- Go 侧零改动,Go 门不受影响。

## 下一步 / OPEN

- **不 push**,停在 completed-ready 等 fe-review(硬纪律)。
- 显式非目标(规格 MVP 边界):目录行不可拖出;搜索结果行(file-search-item)未挂 draggable;多选拖拽待面板多选能力;远程客户端(非浏览器宿主)拖拽通道不在本次范围。
- 若未来 sender 需要发绝对路径(如从别处拖入),readPanelFilePayload 契约不用动,接收端 relativeToRoot 归一已兼容。
