# 2026-07-26 后端 prompt 能力扩展:SupportsAudio/SupportsEmbeddedContext + 事件透出 + Attachment Kind + Audio/Resource block + 单测

**类型**:feat(acp)

## 起因

ACP `promptCapabilities` 除既已使用的 `image` 外还有 `audio` 与 `embeddedContext` 两项(协议见 acp-go-sdk `types_gen.go` PromptCapabilities)。当前后端只透出 image 能力 + 只能构造 Image / ResourceLink 两种 prompt 块,无法发音频、也无法发内联资源(ContentBlock::Resource)。

Task #23076:补齐后端三能力(accessor + 事件透出)+ 扩展 Attachment(Kind 区分四类附件)+ buildPromptBlocks 构造 Audio / Resource 块 + 单测,为前端音频输入 / 内联附件 UI 打地基。

## 协议调研(acp-go-sdk v0.13.5)

- `PromptCapabilities{Audio, EmbeddedContext, Image}` 三 bool,默认 false。
- prompt 的 `ContentBlock` union 共 5 变体:`text`(baseline)/ `resource_link`(baseline)/ `image`(需 image)/ `audio`(需 audio)/ `resource`(需 embeddedContext)。
- SDK 已提供构造器:`acp.AudioBlock(data, mimeType)`、`acp.ResourceBlock(EmbeddedResourceResource)`。
- `EmbeddedResourceResource` 是 union:`TextResourceContents{text, uri, *mimeType}` 或 `BlobResourceContents{blob, uri, *mimeType}`(uri 为 required 字段)。
- 协议推荐:`ContentBlock::Resource` preferred over `ResourceLink`(省去 agent 读盘往返)。

## 改法

### 1. Attachment Kind 扩展(runner.go)

Attachment 加三字段,Kind 作块类型判别单一来源:

- `Kind string`:`""`/`"file"` → ResourceLink(baseline);`"image"`/`"audio"`/`"resource"` → 对应变体。
- `Text string`:resource 的内联文本(TextResourceContents 变体),设了优先于 Data。
- `URI string`:resource 标识 URI,空则按 Path(file://)/ Name(urn:monkey-deck:)兜底。

**兼容旧路径**:`Kind=="" && Data!=""` → image(历史粘贴图片调用 `Attachment{Name,Data,MimeType}` 不带 Kind 仍走 Image,既有单测与前端调用不破)。

### 2. buildPromptBlocks 重构(runner.go)

抽出 `attachmentBlock(a, workDir)` 单 attachment 构造,switch Kind:

- `image` → `acp.ImageBlock`(mime 兜底 image/png)。
- `audio` → `acp.AudioBlock`(mime 兜底 audio/wav,录音常见)。
- `resource` → `acp.ResourceBlock(buildEmbeddedResource(a, workDir))`:
  - Text 非空 → TextResourceContents;
  - 否则 → BlobResourceContents(Data)。
  - URI 三级兜底:`a.URI` → `fileURI(workDir, a.Path)` → `urn:monkey-deck:<Name>`。
- default → `acp.ResourceLinkBlock`(baseline)。

**能力门控不在构造层做**(与既有 image 行为一致:buildPromptBlocks 只构造,门控在调用方 / 前端依 SupportsXxx 决定)。协议要求 REQUIRES capability,但门控责任在前端(不展示不支持入口)+ 后端 accessor,构造函数保持纯粹 / 可单测。

### 3. SupportsAudio / SupportsEmbeddedContext(runner.go)

镜像 SupportsImage,直接读 `cs.PromptCapabilities.Audio / .EmbeddedContext`。零值 ChatSession 三者皆 false(安全默认)。

### 4. 事件透出(handler.go + chat.go)

`SessionEvent` 在 `ImageSupported` 旁加 `AudioSupported` / `EmbeddedContextSupported` 两 bool(omitempty,随 config_option 事件下发)。两处 emit 点同步:

- `startLive`(chat.go:~1114):session 启动推 config_option 时带三能力。
- `RefreshConfig`(chat.go:~2033):刷新配置后重推三能力。

前端据此门控音频入口、决定附件内联与否。

### 5. chatConn 接口 + mock(chat.go + 两 test)

接口加 `SupportsAudio() bool` / `SupportsEmbeddedContext() bool`。`mockChatConn`(idle_reaper_test)/ `fakeChat`(queue_test)各补两 false 实现。

**SendMessage 签名不变**:`SendMessage(sessionID, text string, attachments []acp.Attachment)` —— Attachment 是 struct 扩展(加字段),签名类型不变,Prompt→startTurn→runPrompt→InterruptAndSend→SendAndWaitSync 全链路已用 `[]acp.Attachment`,新 Kind 自然透传。

## 改了哪些文件

- `internal/acp/runner.go`:Attachment 加 Kind/Text/URI + 注释;buildPromptBlocks 重构为 attachmentBlock switch + buildEmbeddedResource;加 SupportsAudio / SupportsEmbeddedContext。
- `internal/acp/handler.go`:SessionEvent 加 AudioSupported / EmbeddedContextSupported 字段。
- `internal/chat/chat.go`:chatConn 接口加两方法;startLive / RefreshConfig 两 emit 点带新能力。
- `internal/chat/idle_reaper_test.go` / `queue_test.go`:mock 补 SupportsAudio / SupportsEmbeddedContext(false)。
- `internal/acp/promptblocks_test.go`:加 audio / resource(text/blob)/ URI 兜底 / Kind=file / 全 Kind 混合 7 组子测试。
- `internal/acp/runner_test.go`:加 TestPromptCapabilityAccessors(零值 / 全 true / 部分)。

## 验证

- `go build ./internal/...` / `go vet ./internal/...`:clean。
- `go test ./internal/acp/... ./internal/chat/...`:全过(含新增 TestBuildPromptBlocks 7 子测 + TestPromptCapabilityAccessors 3 子测)。
- `gofmt -l` 改动文件:clean(既有未触碰文件的不规范不在本任务范围)。
- 既有 TestBuildPromptBlocks 5 个旧子测全过(Kind 兼容兜底生效,无回归)。
- `main.go` 的 `frontend/dist` embed 报错是**预先存在**(git stash 验证:clean base 同样报),与本改动无关。

## 下一步

- 前端(另一任务):消费 audioSupported / embeddedContextSupported 事件字段,门控音频输入入口 + 决定附件内联;构造带 Kind 的 Attachment 调 SendMessage。
- 若某些 agent 的 audio 能力有额外约束(如采样率 / 格式),在 accessor 层补注;构造层目前按协议标准。
