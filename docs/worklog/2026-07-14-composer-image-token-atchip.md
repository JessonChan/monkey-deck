# Composer 优化:@ chip 化 + token 用量展示 + 图片输入(能力门控)

## 起因
Composer(输入框)需补齐三项体验:
1. **@ 引用 chip 化**:已有的 att-chip-mention 进一步紧凑化(用 `@` 标记代替通用文件图标,
   语义更明确、视觉更轻)。
2. **token 用量**:输入区附近展示当前对话上下文用量(已用/上限)+ 输入文本的近似 token 预估,
   给用户「这条大概多少 token / 还剩多少上下文」的直觉。
3. **图片输入**:附件按钮 / 粘贴图片,经 ACP `ContentBlock::Image` 发给 agent —— 但 image 块
   是**能力门控**的(协议:`REQUIRES 'image' prompt capability`),后端不支持时入口必须隐藏/禁用。

## 协议调研 / 设计

### 图片能力门控(ACP)
- ACP `ContentBlock::Image` 要求 agent 在 Initialize 响应里声明 `promptCapabilities.image=true`
  (SDK `types_gen.go`:`PromptCapabilities{Image bool}`,默认 false)。未声明时发 image 块属协议违规。
- 故**必须能力门控**:前端据 agent 声明决定是否展示图片入口,不支持则隐藏按钮 + 粘贴静默丢弃。
- 能力来源:`InitializeResponse.AgentCapabilities.PromptCapabilities.Image`,在 `spawnAndInit`
  后即知(NewSession/LoadSession 之前)。

### token 用量数据源
- 会话上下文用量:`SessionUsageUpdate` 流(`used`/`size`/`cost`),App 已按 session 累积在
  `usageBySession`,ChatView 顶部已有 `usage-bar`。Composer 复用同一份 `usage`,紧凑再展示一次
  (输入区附近,「已用/上限」)。
- 输入文本预估:无后端精确分词器,用**字符数/4**经验比值近似(GPT 系中间值,CJK 偏高、英文偏低),
  作占位提示(明确标注「非计费依据」),不引入新依赖。

### @ chip 化
- 原 mention chip 用通用 `<File>` 图标 + 文件名;改为 `<span class="att-chip-at">@</span>` 小徽标
  + 文件名,更紧凑、语义直指「路径引用」。删除/编辑逻辑不变(X 删 chip + 同步删 textarea 里的 `@path`)。

## 改法

### 后端(最小,为图片能力门控铺路)
- `internal/acp/runner.go`:
  - `Attachment` 扩 `Data`/`MimeType` 字段(可选,与 `Path` 互斥;`Data` 非空 → 发 Image 块)。
  - `ChatSession` 加 `PromptCapabilities` 字段(NewSession/LoadSession 时从 `initResp` 填充)。
  - 新增 `SupportsImage() bool`(读 `PromptCapabilities.Image`)。
  - `buildPromptBlocks`:`Data` 非空发 `acp.ImageBlock(data, mimeType)`(`mimeType` 空兜底 `image/png`);
    否则照旧发 `ResourceLink`(baseline,所有 agent MUST support)。
- `internal/acp/handler.go`:`SessionEvent` 加 `ImageSupported bool` 字段(随 config_option 事件下发)。
- `internal/chat/chat.go`:`startLive` 发 `config_option` 事件时附带 `ImageSupported: chat.SupportsImage()`
  (去掉旧 `len(opts) > 0` 守卫 —— 无 config options 也要发,以投递 imageSupported)。
- `internal/acp/promptblocks_test.go`:补 image 块 / 混合 / mime 兜底 三组用例。

### 前端
- `types.ts`:`SessionEvent` 加 `imageSupported?`;新增 `ImageAttachment` 类型;`QueueItem` 加 `images?`。
- `App.tsx`:
  - 按 session 跟踪 `imageSupportedBySession` / `imagesBySession`(切走保留,删 session 清理)。
  - `config_option` 事件分支捕获 `imageSupported`。
  - `sendMessage(text, mentions, images?)`:images 映射成后端 `{name, data, mimeType}` 并入 attachments;
    入队/打断回放同步携带 images(`drainQueue` / `interruptQueue`)。
- `ChatView.tsx`:Props 透传 `images` / `onImagesChange` / `imageSupported` / `usage` 给 Composer。
- `Composer.tsx`:
  - **图片按钮**:`imageSupported` 为真才渲染(`data-testid="image-btn"`),原生 file dialog 选图。
  - **粘贴图片**:`onPaste` 检测剪贴板图片(兼容 `files` 与 `items`),能力门控下转 `ImageAttachment`,
    `preventDefault` 防图片被当文本插入。
  - **图片 chip**:缩略图(`<img>` base64)+ 文件名 + X 删除。
  - **mime/大小校验**:白名单 png/jpeg/webp/gif,单图 ≤10MB。
  - **草稿 token 预估**:`estimateTokens = len/4`;`ComposerUsage` 组件在 compose-bar 展示
    `~{draft}` · `{used} / {size} · {pct}%`,色阶随上下文占比加重(mid/high/crit)。
  - **@ chip 化**:mention chip 用 `@` 徽标替代 File 图标。
- `index.css`:`.att-chip-at`、`.att-chip-image`、`.att-chip-thumb`、`.composer-usage[-mid|-high|-crit]` 样式。

## 改了哪些文件
- 后端:`internal/acp/runner.go`、`internal/acp/handler.go`、`internal/chat/chat.go`、`internal/acp/promptblocks_test.go`
- 前端:`frontend/src/types.ts`、`frontend/src/App.tsx`、`frontend/src/components/ChatView.tsx`、
  `frontend/src/components/Composer.tsx`、`frontend/src/index.css`

## 验证
- 后端 acceptance gate:`go build ./... && go vet ./... && go test ./...` 全绿
  (含新增 promptblocks image 用例;`main` 包需 `frontend/dist` stub 满足 embed,已放桩,`.gitignore` 排除)。
- 前端:`wails3 generate bindings` 后 `cd frontend && bun run build`(tsc + vite production)通过,
  无类型/编译错误;`bun test` 27 pass。
- `git status` 仅上述源文件;bindings/dist/node_modules 均 gitignore;AGENTS.md / RAK 运行时文件未动。

## 下一步
- 手动 `wails3 dev` 验证:opencode(应声明 image 能力)下图片按钮可见、粘贴/选择图片成 chip、
  发送后 agent 能看到图;不支持 image 的 harness 按钮隐藏。
- 可选:图片在对话历史里的回显(目前用户消息只存文本,图片不入 DB —— 若需回看需持久化图片块)。
- token 预估后续可换后端真实分词(若 harness 提供),当前字符比值够用作占位。
