# 2026-08-01 ACP available_commands_update 调研 + 真机实测

## 起因

聊天框里的 `/`(斜杠命令)现有实现与 ACP 协议不符,是早期错误实现。用户要求调研 ACP 中
`/` 的标准语义,并实测 opencode / omp 两个目标 harness 在 ACP 模式下是否发射
`available_commands_update`,以决定是否按协议标准重做。

## 根因 / 协议调研

- **ACP 有标准**:`docs/protocol/slash-commands.mdx`(协议 v1)。
- 机制三段:
  1. **广告**:agent 在 session 创建后(可动态更新)发 `session/update` 通知,
     `sessionUpdate: "available_commands_update"` + `availableCommands: [{name, description, input?: {hint}}]`。
     `name` **不含** `/`。
  2. **调用**:命令就是**普通 user message**——client 把完整文本(如 `/model`)原样放进
     `session/prompt`,**不解析、不剥前缀**;「识别命令前缀并执行」是 agent 的职责
     (规范原文:"The Agent recognizes the command prefix and processes it accordingly.")。
     命令名后的所有文本 = 命令输入(`AvailableCommandInput.Unstructured`)。
  3. **规范性**:广告是 **MAY**(agent 可选),无协议级语法;`/` 只是文档示例约定。
- SDK(`coder/acp-go-sdk v0.13.5`,本项目已钉)已完整支持:`SessionAvailableCommandsUpdate`
  (types_gen.go:5183)、`AvailableCommand{Name, Description, Input→Unstructured{hint}}`(:739-830),
  经 `Client.SessionUpdate` 回调统一派发。
- **本项目现状**:`internal/acp/handler.go` `flattenUpdate` 的 switch **无
  `AvailableCommandsUpdate` 分支**,落入 default 直接丢弃 → 前端拿不到命令列表。

## 改法

本轮为纯调研 + 实测,**未改代码**。

## 验证(真机探针,非单测)

探针 `/tmp/acp-probe/main.go`(临时目录,不进仓库):spawn harness `acp` 子进程 →
`NewClientSideConnection` → Initialize → NewSession(cwd=/tmp/acp-probe-cwd)→ 收集 8s 内全部
session/update → 统计 kind + 打印 available_commands_update 内容。

| harness | 版本 | 是否发射 | 命令数 | 实测内容 |
|---|---|---|---|---|
| omp(oh-my-pi) | 17.2.0 | ✅ 是 | 42 | /model /fast /todo /compact /usage /mcp /skill:* 等,含 description + input.hint |
| opencode | 1.18.10 | ✅ 是 | 3 | /customize-opencode /init /review |

- **omp 源码**:`packages/coding-agent/src/modes/acp/acp-agent.ts` `#emitAvailableCommandsUpdate`
  (:1920),session 创建后经 `setTimeout(0)` 排队发射(注释:直接发会与 NewSession 响应竞态,
  Zed 会丢首条导致 palette 空);命令元数据变更(refreshCommands / reloadPlugins /
  command_metadata_changed)会重发。
- **opencode 源码**:`packages/opencode/src/acp/service.ts` `sendAvailableCommands`(:928),
  NewSession / LoadSession / replay 路径都会发。
- **端到端**:omp 上把 `/model` 作为普通 prompt 发送 → 识别执行 → `stopReason: end_turn` +
  命令输出以 `agent_message_chunk` 流回。协议链路完整可用。

## 改了哪些文件

无(仅新增本条 worklog)。

## 下一步

按协议重做聊天框 `/` 功能:
1. `internal/acp/handler.go`:`flattenUpdate` 加 `case u.AvailableCommandsUpdate != nil` 分支 →
   `SessionEvent` 新 kind(如 `available_commands`)+ `[]AvailableCommand` 扁平结构;
2. `internal/chat` 或 service 层把命令列表经 Wails3 event 推前端(可复用 config_option 等
   现有推流模式);
3. 前端:输入框首字符 `/` 弹命令面板,渲染 name/description/hint;选中后**原样**作为
   prompt 文本发送(如 `/todo list`),不走任何本地解析/剥离;
4. Go 导出签名若变更 → `wails3 gen bindings`;
5. 参考 omp 竞态教训:首个 available_commands_update 可能与 NewSession 响应并发到达,
   UI 应能处理「事件先于 session 就绪」的情况。
