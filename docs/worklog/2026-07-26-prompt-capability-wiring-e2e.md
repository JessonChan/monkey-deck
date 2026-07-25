# 2026-07-26 prompt 能力链路收尾:App.tsx 三发送路径统一 buildAttachments,files 显式带 Kind

**类型**:refactor(chat) / feat(chat)

## 起因

Task #23078(#66 收尾)。前两步已就位:
- #23076(后端):`Attachment.Kind` + `buildPromptBlocks` 的 `attachmentBlock` switch(image/audio/resource/default)+ `SupportsAudio`/`SupportsEmbeddedContext` accessor + `SessionEvent` 透出三能力。
- #23077(前端):types 加 `audioSupported`/`embeddedContextSupported`/`AudioAttachment`;App.tsx 按能力读 image/audio 事件 + per-session state;Composer 加音频入口;`onSend`/`onEnqueue` 签名加 `audios?`。

收尾缺口:App.tsx 三处发送路径(`sendMessage` / `drainSession` / `interruptQueue`)各自**手写同一段** attachments 构造,且 mentions / 回形针文件**不带 Kind**(裸 `{path,name}`,靠后端 `attachmentBlock` 的 default 分支兜底为 ResourceLink)。这与 image/audio 显式带 Kind 不一致,且三份副本易漂移。

## 改法

### 1. 抽 `buildAttachments(mentions?, imgs?, aus?)` 模块级 helper(App.tsx)

把三处副本收敛成一处,显式带 Kind(对齐后端 `Attachment.Kind` / `attachmentBlock` switch):

- mentions / 回形针文件 → `kind:"file"` → `ContentBlock::ResourceLink`(协议 baseline,所有 agent MUST support)
- images → `kind:"image"` → `ContentBlock::Image`(需 image 能力)
- audios → `kind:"audio"` → `ContentBlock::Audio`(需 audio 能力)

mentions 与回形针文件在 `Composer.submit` 已合并进同一个 mentions 数组(两者协议上都 → ResourceLink,无差别),此处统一带 `kind:"file"`。

### 2. 三处发送路径改调 helper

- `sendMessage`:`await ChatService.SendMessage(selectedSessionId, text, buildAttachments(mentions, imgs, aus))`(删掉局部 `const attachments`)。
- `drainSession`:`await ChatService.SendMessage(sid, next.text, buildAttachments(next.mentions, next.images, next.audios))`。
- `interruptQueue`:`await ChatService.InterruptAndSend(sid, item.text, buildAttachments(item.mentions, item.images, item.audios))`。

### 3. 注释同步

`sendMessage` doc 注明 mentions 含回形针文件、attachments 由 buildAttachments 构造显式带 Kind。

## 端到端链路确认(#66)

三类 prompt 能力的完整链路(image / audio 已端到端,e2e 通):

| 能力 | 后端 emit | App.tsx 读事件 | Composer 入口 | Attachment Kind | backend block |
|---|---|---|---|---|---|
| image  | `imageSupported`         | ✅ `imageSupportedBySession`  | ✅ ImageIcon 按钮(`imageSupported` 门控)| `kind:"image"` | ImageBlock |
| audio  | `audioSupported`         | ✅ `audioSupportedBySession`  | ✅ Mic 按钮(`audioSupported` 门控)     | `kind:"audio"` | AudioBlock |
| file(baseline)| —(MUST support,无能力位)| — | ✅ Paperclip(恒显,baseline) | `kind:"file"` | ResourceLinkBlock |
| embeddedContext | `embeddedContextSupported` | ⚠ types 有字段,**state/入口仍 deferred** | ❌ 暂无入口 | (待定 `kind:"resource"`)| ResourceBlock(后端已就绪) |

`embeddedContextSupported` 在 types(#23077)已对齐字段,但其 state / 入口门控**仍未接线**——原因:ContentBlock::Resource 需内联文件**内容**(Text/Blob),前端目前不读文件内容,无内容则 `buildEmbeddedResource` 只能产出空 blob(无用)。该能力的「读事件 → 门控入口 → 构造 Resource 块」整链需要「文件内容读取(File API / 后端 fs 读)+ 文本 vs 二进制分流 + chip UI + 与回形针 ResourceLink 的关系」一并设计,范围显著大于「接线收尾」,故仍显式推迟到独立任务。本任务不动它的 state(避免无 consumer 的死代码,`noUnusedLocals` 下无法空挂)。

## 改了哪些文件

- `frontend/src/App.tsx`:加模块级 `buildAttachments` helper(显式 Kind);`sendMessage`/`drainSession`/`interruptQueue` 三处改调 helper,删重复副本;`sendMessage` doc 同步。

## 验证

- `wails3 generate bindings`:clean(bindings 不入库,本任务未改 Go 签名,生成仅为前端 tsc 能 resolve)。
- `cd frontend && bun run build`(=`tsc && vite build`):clean,无 TS 错误。
- `cd frontend && bun run test`:130 pass / 0 fail(含 Composer / ChatView mount-test)。
- `go build ./...` / `go vet ./...`:clean(本任务未改 Go,确认无回归)。
- `go test ./internal/acp/... ./internal/chat/...`:全过(后端 Attachment Kind / buildPromptBlocks 行为不变——`kind:"file"` 与 `kind:""` 在 `attachmentBlock` default 分支等价,无回归)。

## 下一步 / OPEN

- **embeddedContext 的内联附件入口(独立任务)**:state + 事件消费 + 文件内容读取(File API 客户端读,或后端 fs 读后回传)+ TextResourceContents / BlobResourceContents 分流 + chip UI + 决定「新增内联入口」还是「回形针在 embeddedContext=true 时升级为 Resource」。后端 `buildEmbeddedResource` 已就绪。
- 音频录入(MediaRecorder / Mic 长按)入口仍是增强项(#23077 OPEN)。
