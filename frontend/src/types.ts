// 前端类型:与 Go 后端的 SessionEvent / PermissionPrompt / StatusPayload 对齐(§1.6/§4.3)。
// 数据源全是 ACP 的 SessionUpdate,经 Wails3 event 推来。

export interface SessionEvent {
  sessionId: string;
  kind:
    | "user_message_chunk"
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "tool_call"
    | "tool_call_update"
    | "usage_update"
    | "plan"
    | "session_info"
    | "config_option"
    | "available_commands";
  text?: string; // agent/thought 为累积全文
  messageId?: string; // ACP messageId:同一条逻辑消息的所有 chunk 共享(§5.4 #11),主键归并用
  seq?: number; // 单调序号(防流式乱序)
  // turnId:plan 事件所属的 turn(= 开启该 turn 的 user message ID,client 生成;协议无 turnId)。
  // 仅 plan 事件携带:plan 按 turn 索引,当前 turn 实时 / 历史 turn 静态展示。
  turnId?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolStatus?: string; // pending | in_progress | completed | failed
  toolKind?: string; // read | edit | run | ...
  rawInput?: unknown;
  rawOutput?: unknown;
  used?: number; // context tokens 已用
  size?: number; // context window 总量
  cost?: number; // 累积成本 USD
  // token 明细(来自 PromptResponse.Usage,UNSTABLE;Task #15138)。streaming UsageUpdate 不含明细,
  // 仅在 Prompt 返回后的事件里填充;未回填则全 0(前端据此决定是否展示明细)。
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  title?: string; // session_info 标题
  configOptions?: ConfigOption[]; // config_option:model/mode/effort(agent 自报)
  imageSupported?: boolean; // config_option 附带:agent 是否支持 image prompt 能力(门控图片输入)
  // config_option 附带:agent 是否支持 audio / embeddedContext prompt 能力(门控音频入口 / 内联附件,
  // 对齐后端 SupportsAudio/SupportsEmbeddedContext,见 internal/acp/runner.go)。
  audioSupported?: boolean;
  embeddedContextSupported?: boolean;
  planEntries?: PlanEntry[]; // plan:agent 执行计划(整表替换,ACP protocol)
  commands?: SlashCommand[]; // available_commands:harness 自报斜杠命令(动态,非硬编码;§1.6)
}

// agent 执行计划的一项(与后端 internal/acp.PlanEntry 对齐)。
// status: pending | in_progress | completed;priority: high | medium | low。
export interface PlanEntry {
  content: string;
  priority?: string;
  status: string;
}

// 当前 turn 的实时 plan(进行中的 turn 由 plan 事件流式刷新,turn 结束转为持久化 plan item)。
// turnId 标识该 plan 所属的 turn(= user message ID);entries 为最新全量快照。
export interface LivePlan {
  turnId: string;
  entries: PlanEntry[];
}

// harness 自报的斜杠命令(ACP available_commands_update,动态、随 harness 不同)。
// name 不含前导 "/"(调用时前端拼 "/"+name 作为普通 prompt 文本发送,协议 §slash-commands)。
export interface SlashCommand {
  name: string;
  description: string;
  inputHint?: string; // 参数提示(ACP AvailableCommandInput.hint),可空
}

// session config option(agent 经 NewSession/config_option_update 自报,前端渲染下拉)。
// model 的 value 是 "provider/model" 格式,前端按 provider 前缀分组显示。
export interface ConfigOptionEntry {
  value: string;
  name: string;
  description?: string;
}
export interface ConfigOption {
  id: string;
  name: string;
  category: string; // model | mode | thought_level
  currentValue: string;
  options: ConfigOptionEntry[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string; // allow_once | allow_always | deny_once | deny_always
}

export interface PermissionPrompt {
  id: string;
  sessionId: string;
  toolName: string;
  title: string;
  actionType?: string; // read/write/exec/other(决策上下文:动作分组)
  command?: string; // 决策上下文:exec 类抽取的命令
  locations?: string[]; // 决策上下文:涉及路径
  options: PermissionOption[];
}

// Elicitation prompt (ACP v1 standard protocol, SDK marked UNSTABLE).
// Harness requests structured user input (e.g. omp /review mode select, /fast confirm).
// Fields drive rendering: string→input, string+enum→select, boolean→checkbox.
export interface ElicitationPrompt {
  id: string;
  sessionId: string;
  message: string;
  fields: ElicitationField[];
}

export interface ElicitationField {
  name: string; // property key (omp convention: "value")
  type: "string" | "boolean" | string;
  title?: string;
  description?: string;
  enum?: string[];
  default?: string;
  required?: boolean;
}

export interface StatusPayload {
  sessionId: string;
  status: "started" | "prompting" | "idle" | "error" | "closed" | "readonly" | "notice" | "reconnecting";
  code?: string; // 稳定错误码;error 状态下前端按 code 经 i18n 翻译(对应 locales 的 chat.error.*)
  detail?: string;
  rootCause?: string; // Human-readable root cause extracted from the Prompt error (e.g. provider quota text); set on error status when diagnostics are attached (#46)
  resetAt?: string;   // Verbatim provider-side reset moment on quota exhaustion (provider local time); carried with provider_quota_exhausted (#46)
  attempts?: number;  // Total Prompt attempts for this turn (1 + auto-retries, capped at 3); set on error status when diagnostics are attached (#46)
}

// @提及的文件/目录引用,经 ACP ContentBlock::ResourceLink 发给 agent。
// 与后端 internal/acp.Attachment 对齐(由 bindings 生成)。
export interface Mention {
  path: string;  // 相对 cwd 或绝对路径
  name: string;  // 显示名
}

// 内联图片附件,经 ACP ContentBlock::Image 发给 agent(需 agent 声明 image prompt 能力)。
// data 是 base64(无 data: 前缀);mimeType 如 image/png。与后端 internal/acp.Attachment 的 Data/MimeType 对齐。
export interface ImageAttachment {
  name: string;      // 显示名(如 paste-<ts>.png)
  data: string;      // base64 编码(无前缀)
  mimeType: string;  // image/png | image/jpeg | image/webp | image/gif
}

// 内联音频附件,经 ACP ContentBlock::Audio 发给 agent(需 agent 声明 audio prompt 能力)。
// 与后端 internal/acp.Attachment 的 Data/MimeType 对齐;发送时 Kind="audio"。
export interface AudioAttachment {
  name: string;      // 显示名(如 voice-<ts>.webm)
  data: string;      // base64 编码(无前缀)
  mimeType: string;  // audio/wav | audio/mpeg | audio/webm | audio/ogg
}

// 会话用量:context 占比(streaming UsageUpdate)+ token 明细(PromptResponse.Usage,Task #15138)。
// 明细字段仅 Prompt 返回后填充,streaming 不含 → 全 0(前端据此决定是否展示明细)。
export interface Usage {
  used: number; size: number; cost: number;
  cachedReadTokens: number; cachedWriteTokens: number;
  inputTokens: number; outputTokens: number;
  thoughtTokens: number; totalTokens: number;
}

// Prompt attachment sent alongside a message (frontend mirror of the backend
// internal/acp.Attachment). buildAttachments produces this shape; SendMessage /
// EnqueueMessage / InterruptAndSend all take it.
export interface Attachment {
  kind?: string;   // "" | file | image | audio | resource (decides the ContentBlock)
  name: string;    // display name
  path?: string;   // file/dir path (mentions / paperclip files)
  data?: string;   // base64 payload (inline image/audio)
  mimeType?: string;
}

// Queued message (#126A: the queue lives on the SERVER; the frontend is only a
// chat:queue event consumer). attachments is the pre-built prompt-attachment
// array captured at enqueue time — the backend reuses it verbatim on drain and
// the frontend reuses it for "send now" (InterruptAndSend).
// scheduledAt: epoch-ms send time; default = enqueue time ("due now"). A future
// value parks the item (backend skips it on drain, fires a one-shot timer).
// repeatEveryMs/sentCount (#111): recurring send — >0 re-arms the item after
// each successful send (max(now, prev+interval), skip-catch-up); sentCount
// counts those sends. Both optional for legacy-shaped test fixtures (0/absent
// = plain one-shot item).
export interface QueueItem {
  id: string;
  text: string;
  attachments?: Attachment[];
  scheduledAt: number;
  repeatEveryMs?: number;
  sentCount?: number;
}

// chat:queue event body (#126A): full authoritative per-session queue snapshot,
// emitted on every mutation and on OpenSession. items is always an array
// (possibly empty — an empty snapshot authoritatively clears stale state).
export interface QueuePayload {
  sessionId: string;
  items: QueueItem[];
}

// 前端展示用的对话条目(由持久化历史 + 实时流式合并而来)。
export type ChatItem =
  | { type: "user"; id: string; text: string; ts?: number; messageId?: string }
  | { type: "agent"; id: string; text: string; streaming?: boolean; seq?: number; ts?: number; messageId?: string }
  | { type: "thought"; id: string; text: string; streaming?: boolean; seq?: number; ts?: number; messageId?: string }
  | {
      type: "tool";
      id: string; // toolCallId
      title: string;
      status: string;
      kind: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      ts?: number;
    }
  | {
      type: "plan";
      id: string; // 持久化 message id;实时 eager-append 用 `live-plan-<turnId>`
      turnId: string; // 所属 turn(= user message ID)
      entries: PlanEntry[];
      ts?: number;
    };
