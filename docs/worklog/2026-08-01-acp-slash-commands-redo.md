# 2026-08-01 斜杠命令重做:走 ACP available_commands_update + 未知命令拦截

## 起因

聊天框的 `/` 是早期错误实现:硬编码命令表(`SLASH_COMMANDS`,/explain /review /tests …)+
3 个假动作(/new /clear /stop 走 client 侧 onAction),与 ACP 协议完全无关。前序调研
(`2026-08-01-acp-available-commands-investigation.md`)已实测 opencode/omp 都会发
`available_commands_update`(opencode=3、omp=42,动态、随 harness 不同),协议虽是 MAY 但
两者都实现。本次按协议标准重做,并补用户要求的「未知命令拦截」。

## 根因 / 设计

- **命令源 = 协议事件**,非硬编码:harness 经 `session/update`(variant `available_commands_update`)
  自报命令列表(name/description/input.hint),client 原样转发给前端渲染 `/` 命令面板。
- **命令调用 = 普通 prompt 文本**:选中命令后前端拼 `/name ` 作为普通消息发送
  (协议 §slash-commands:「The Agent recognizes the command prefix」),client 不解析、不剥前缀。
- **未知命令拦截**(用户要求,通用覆盖所有 harness):submit/enqueue 时若消息以 `/` 开头、
  命令名(首个空白 token)不在 harness 自报表里 → 阻止发送 + 提示,并提供「作为普通文本发送」
  = 前导加空格转义(用户实测对 opencode 有效,绕过命令解析)。commands 为空(尚未收到事件)
  时不拦,交给 harness。

## 改法

后端:
- `internal/acp/handler.go`:新增 `SlashCommand{Name,Description,InputHint}` 类型 +
  `SessionEvent.Commands` 字段;`flattenUpdate` 加 `case u.AvailableCommandsUpdate != nil`
  分支(nil-safe:Input/Unstructured 都判空)。
- `internal/chat/chat.go`:`handleEvent` 的 `s.emit(EventUpdate, e)` 本就无条件,该 kind
  直通 emit,**无需** 特殊 case(见下方 review 删除的冗余缓存)。

前端:
- `types.ts`:`SessionEvent.kind` 加 `available_commands`;新增 `SlashCommand` interface + `commands` 字段。
- `App.tsx`:`commandsBySession` state + `applyEvent` 的 `available_commands` 分支(整表替换)+
  派生切片 + 透传给 ChatView(镜像 config_option 模式;命令不持久化——只在 live session 才需要)。
- `ChatView.tsx`:加 `commands` prop 透传。
- `Composer.tsx`:删硬编码 `SLASH_COMMANDS`/假动作;`commands` prop 驱动命令面板
  (filter by name prefix);`pickSlash` 插入 `/name `;`submit` 加未知命令守卫 + `forcePlain`
  转义路径;`sendAsPlain`/`slashWarn` 状态 + 警告横幅(Esc/编辑可清)。
- `index.css`:`.slash-hint` / `.slash-warn*` 样式。
- i18n(zh/en):删旧 `composer.slash.*` 硬编码键;加 `slashUnknown`/`slashUnknownHint`/
  `sendAsPlain`/`sendAsPlainTip` + `common.dismiss`。

测试:
- `internal/acp/available_commands_test.go`:flatten 契约(name 无 `/`、description/hint 转发、无 input 不崩)。
- `Composer.mount.test.tsx`:5 个守卫测试(未知阻塞 / 已知放行 / 空表不拦 / 转义发送 / enqueue 模式)。

## 深度 review 发现并修复(本轮自查)

1. **`onAction`/`handleComposerAction` 全链死代码**:旧 pickSlash 的假动作(/new /clear /stop)
   是 `onAction` 唯一调用方;重做后 Composer 不再调 onAction → ChatView 透传 + App handler 全成死链。
   按 §5.3 删除:Composer/ChatView 的 prop、App 的 `handleComposerAction`、4 个测试 stub。
   (修的过程两次 CUT 因前置删除导致行号偏移而误删邻行——`const { t } = useTranslation()` 与
   `history` prop——均已即时发现并恢复,tsc 复验通过。教训:CUT 前若该文件本 turn 已删过行,重读确认行号。)
2. **`liveSession.commands` 写而无读**:首版加了缓存字段 + handleEvent case,但 `s.emit` 无条件、
   又删了唯一读者 `GetSessionCommands` → 字段写死无人读。删字段 + 删 case,事件仍直通 emit。
3. **`composer.addAudioTip` i18n key 误删**(外部 review 抓到,自查漏):删 `composer.slash.*` 块时
   某次 CUT 行号偏移误删了相邻的 `addAudioTip`(Composer.tsx 的音频按钮 title 仍 `t("composer.addAudioTip")`
   → tooltip 显示原始 key 串,§4.4 反例)。已恢复 zh/en 两边。教训:locale 编辑后做全量 leaf-key diff
   (`git show HEAD:... ` vs 当前)对账,别只看目标块。

## 改了哪些文件

后端:`internal/acp/handler.go`、`internal/acp/available_commands_test.go`(新)、`internal/chat/chat.go`
前端:`frontend/src/types.ts`、`App.tsx`、`components/{Composer,ChatView}.tsx`、`components/Composer.mount.test.tsx`、
`index.css`、`i18n/locales/{zh,en}.json`
测试 stub 清理:`Composer.usage.mount.test.tsx`、`ChatView.virtual.mount.test.tsx`、`msgmeta.duration.mount.test.tsx`

## 验证

- `go build . ./internal/...` + `go test ./internal/...` 全 ok(flatten 新测试通过)。
- `bun run tsc --noEmit` 0 error。
- `bun run test`:160 个测试,20 fail —— 与改动前**完全一致**(均为既有失败:ChatView 虚拟化/NewSessionModal/
  msgmeta,根因是测试 mock 缺 `GetSessionMcpServers`,与本变更无关);新增 5 个守卫测试全过(pass 135→140)。
- `wails3 task build`:全量桌面构建通过(BUILD_EXIT=0)。
- 既有 20 个失败的归属已用 `git stash` 干净树复核确认(同 20 个),非本变更引入。

## 下一步 / OPEN

- **server 模式端到端实测(§5.5)已做**:起 server 模式 + 浏览器驱动真 harness。omp 新 session 敲 `/` →
  面板 43 命令;opencode 新 session 敲 `/` → 面板 3 命令(/customize-opencode /init /review)。功能在 spawn
  后的 session 完全正常。踩坑:浏览器测受控输入必须用真键盘事件(tab.type),`el.value='/';dispatchEvent('input')`
  不触发 React onChange → React 回填空值 → 面板不开(曾误判为 bug,实为测试方法错)。
- **resume 抑制吞 available_commands(真 bug,已修)**:`LoadChatSession` 抑制窗口原是 blanket noop,opencode
  在 load 响应*之前*发 available_commands_update → 落在 ResumeSession 阻塞窗口被吞 → resumed 的 opencode
  session 命令永久丢失(用户「输入 / 没反应」根因之一)。修法:抑制只针对历史重放(message/tool/plan chunk),
  放行会话级元数据(available_commands 等)。omp 靠 setTimeout(0) 延迟到响应之后故原本无此问题。
- 转义「前导空格」依赖 harness 不 strip 前导空白(用户已实测 opencode 不 strip);若未来某 harness strip
  前导空白致转义失效,需换策略(如包裹引号)。属 [INFERENCE],暂不处理。
- [OPEN] 只读历史 session(未 spawn)敲 `/` 无面板(commands 空,要等 spawn)。当前靠「发消息/继续会话」
  触发 spawn 后即有;若要「敲 / 即触发」,需对未活跃 session 自动 ensureLive(行为变更,待定)。
