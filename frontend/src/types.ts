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
    | "config_option";
  text?: string; // agent/thought 为累积全文
  seq?: number; // 单调序号(防流式乱序)
  toolCallId?: string;
  toolTitle?: string;
  toolStatus?: string; // pending | in_progress | completed | failed
  toolKind?: string; // read | edit | run | ...
  rawInput?: unknown;
  rawOutput?: unknown;
  used?: number; // context tokens 已用
  size?: number; // context window 总量
  cost?: number; // 累积成本 USD
  title?: string; // session_info 标题
  configOptions?: ConfigOption[]; // config_option:model/mode/effort(agent 自报)
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
  options: PermissionOption[];
}

export interface StatusPayload {
  sessionId: string;
  status: "started" | "prompting" | "idle" | "error" | "closed";
  detail?: string;
}

// 排队消息(前端队列:ACP 协议无 queue,turn 进行中的消息先入前端队列,回合结束自动续发)。
export interface QueueItem {
  id: string;
  text: string;
}

// 前端展示用的对话条目(由持久化历史 + 实时流式合并而来)。
export type ChatItem =
  | { type: "user"; id: string; text: string; ts?: number }
  | { type: "agent"; id: string; text: string; streaming?: boolean; seq?: number; ts?: number }
  | { type: "thought"; id: string; text: string; streaming?: boolean; seq?: number; ts?: number }
  | {
      type: "tool";
      id: string; // toolCallId
      title: string;
      status: string;
      kind: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      ts?: number;
    };
