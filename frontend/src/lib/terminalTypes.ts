// 终端功能的共享类型。后端事件 payload 与前端 tab 状态。
// 后端事件名与 internal/terminal/service.go 的常量一一对应。

// 后端 terminal:data 事件 payload(Data 为 base64 编码的 PTY 输出)。
export interface TerminalDataEvent {
  id: string;
  sessionId: string;
  data: string;
}

// 后端 terminal:exit 事件 payload(进程退出码)。
export interface TerminalExitEvent {
  id: string;
  sessionId: string;
  code: number;
}

// 一个终端 tab 的前端状态(钉在 session 上,per-session 隔离)。
export interface TerminalTab {
  id: string; // = 后端 terminal id
  sessionId: string;
  title: string; // 动态:cwd basename
  userTitle?: string; // 右键改名,优先级最高
  status: "running" | "dead";
}

