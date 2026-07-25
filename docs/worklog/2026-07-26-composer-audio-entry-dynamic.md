# 2026-07-26 前端 Composer 音频入口 + 能力门控 + state 隔离 + onSend 签名扩展

**类型**:feat(composer)

## 起因

后端 Task #23076 已透出 `audioSupported` / `embeddedContextSupported` 两项 prompt 能力(随 `config_option` 事件下发),并扩展 `Attachment.Kind` 支持构造 `ContentBlock::Audio` / `ContentBlock::Resource`。前端需消费这些字段、按能力动态显示音频输入入口、并把音频附件按 `Kind="audio"` 透传到后端 `SendMessage`。

Task #23077:types 扩展(audioSupported/embeddedContextSupported + AudioAttachment)+ Composer 按 `audioSupported` 动态显示音频入口 + per-session state 隔离 + `onSend`/`onEnqueue` 签名扩展加 `audios?` 参数。

## 改法

### 1. types 扩展(`types.ts`)

- `SessionEvent` 在 `imageSupported` 旁加 `audioSupported?: boolean` 与 `embeddedContextSupported?: boolean`(随 config_option 事件下发,对齐后端 `SupportsAudio`/`SupportsEmbeddedContext`)。
- 新增 `AudioAttachment` 接口(与 `ImageAttachment` 平行:`{ name, data(base64), mimeType }`),对应后端 `Attachment` 的 `Data`/`MimeType` + `Kind="audio"`。
- `QueueItem` 加 `audios?: AudioAttachment[]`(排队 / 入队消息携带音频,与 `images?` 平行)。

### 2. App 持有 per-session state(`App.tsx`)

镜像 image 的处理:

- `audiosBySession` / `audioSupportedBySession`:per-session 隔离(切走保留,§状态隔离)。
- `applyEvent` 的 `config_option` 分支:除既有的 `setImageSupportedBySession`,加 `setAudioSupportedBySession`(仅在值变化时更新,防无谓重渲染)。
- 派生 `audios` / `audioSupported`(选中 session 的切片)+ `onAudiosChange` callback(按 `selectedSessionIdRef` 写入对应 session)。
- `removeSession` 的 `drop` 清理集合同步加 `audiosBySession` / `audioSupportedBySession`。

**embeddedContextSupported**:types 已对齐字段;但其 state / 入口门控逻辑留给后续任务(内联附件 UI 涉及文件内容读取 + Resource 块构造,范围更大)。本任务的事件消费注释里显式说明此暂缓。

### 3. onSend / onEnqueue 签名扩展(`App.tsx` / `ChatView.tsx` / `Composer.tsx`)

签名从 `(text, mentions, images?)` 扩展为 `(text, mentions, images?, audios?)`。三处链路同步:

- `sendMessage` / `enqueueMessage`(App)新增 `aus?: AudioAttachment[]` 参数;`drainSession` / `interruptQueue` 从 `QueueItem.audios` 取出透传。
- 构造后端 attachments 时,images / audios **显式带 `Kind`**(`kind: "image"` / `kind: "audio"`)与后端 `Attachment.Kind` 对齐。旧路径 `Kind=="" && Data!="" → image` 兜底仍在(后端 `attachmentBlock`),但显式 Kind 更清晰、与新 model 一致。

### 4. Composer 音频入口(`Composer.tsx`)

镜像 image 入口的范式(能力门控 + mime 白名单 + 大小上限 + base64 编码):

- `AUDIO_MIME_ALLOWED`:`audio/wav|x-wav|mpeg|mp3|webm|ogg|x-m4a|m4a`(ACP ContentBlock::Audio 常见类型 + 后端 `attachmentBlock` audio 兜底 `audio/wav`)。
- `AUDIO_MAX_BYTES`:25MB(音频比图片体积更大,但仍控量防爆上下文)。
- `addAudioFiles(files)`:能力门控(`!audioSupported || disabled` 直接 return)+ mime / 大小校验 + `fileToBase64` + 并入 `audios`。
- `addAudios()`:`<input type="file" accept=...>` 多选 → `addAudioFiles`。能力门控:`audioSupported=false` 时按钮不渲染。
- compose-tools 新增 `Mic` 按钮(`data-testid="audio-btn"`),`audioSupported` 为真才渲染。
- att-chips 新增音频 chip(`att-chip-audio` + Mic 图标 + 名字 + X 删除)。
- `submit` 收集 `aus` 透传;`empty` 判定 + `referencesCount` 计数纳入 `audios.length`;提交后 `onAudiosChange([])` 清空。

### 5. i18n

`composer.addAudioTip`:zh「添加音频(经 ACP Audio 块发送)」/ en「Add audio (sent as ACP Audio block)」。

## 改了哪些文件

- `frontend/src/types.ts`:`SessionEvent` 加 audioSupported / embeddedContextSupported;新增 `AudioAttachment`;`QueueItem` 加 `audios?`。
- `frontend/src/App.tsx`:per-session `audiosBySession` / `audioSupportedBySession` state + 事件消费 + `onAudiosChange` + sendMessage/enqueueMessage/drainSession/interruptQueue 签名与构造带 Kind 的 attachments + removeSession 清理。
- `frontend/src/components/ChatView.tsx`:Props 加 `audios` / `onAudiosChange` / `audioSupported`;`onSend`/`onEnqueue` 签名加 `audios?`;透传给 Composer。
- `frontend/src/components/Composer.tsx`:Props 加三项 + 签名扩展;`AUDIO_MIME_ALLOWED` / `AUDIO_MAX_BYTES`;`addAudioFiles` / `addAudios`;Mic 按钮 + 音频 chip;`submit` / `empty` / `referencesCount` 纳入 audios。
- `frontend/src/i18n/locales/{zh,en}.json`:`composer.addAudioTip`。
- 三个 mount-test 的 STUB_PROPS / baseProps 加 `audios: []` / `onAudiosChange` / `audioSupported: false`。

## 验证

- `make bindings`(改 Go 导出方法签名后才需要;本任务未改 Go 签名,但 bindings 不入库,dev/build 时生成):clean。
- `cd frontend && bun run build`(= `tsc && vite build`):clean(无 TS 错误,bundle 产出)。
- `cd frontend && bun run test`:130 pass / 0 fail(含 Composer mount-test + ChatView virtual + TurnDivider 等)。
- `go build ./...` / `go vet ./...`:clean(本任务未改 Go,确认未因 bindings 重生成引入回归)。

## 下一步 / OPEN

- **embeddedContextSupported 的前端落地(后续任务)**:本任务已对齐 types 字段,但 state / 入口 / ContentBlock::Resource 构造未实现。落地需考虑:文件内容读取(走 File API 客户端读,或后端 fs 读)、文本 vs 二进制分流(TextResourceContents / BlobResourceContents)、chip UI、与既有回形针(baseline ResourceLink)的关系(新增内联入口 or 改变回形针行为)。后端 `buildEmbeddedResource` 已就绪。
- **音频录入(麦克风)入口**:本任务只做「选择音频文件」入口(`<input type="file">`)。录音(Mic 长按 / MediaRecorder API)是更完整的音频输入形态,可作增强。
- 旧粘贴路径仅处理 image(clipboard 图片);音频目前只能经文件选择入口加入,不支持粘贴(剪贴板音频少见)。
