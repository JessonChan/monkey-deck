import { Fragment, memo, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { Project, Session } from "../../bindings/github.com/jessonchan/monkey-deck/internal/store/models";
import type { ChatItem, PermissionPrompt, StatusPayload, QueueItem, Mention } from "../types";
import Composer from "./Composer";
import QueuePanel from "./QueuePanel";
import Collapsible from "./Collapsible";
import { X, Sparkles, Brain, Check, Copy, Wrench, ShieldAlert, ChevronRight } from "lucide-react";

interface Usage { used: number; size: number; cost: number; }

interface Props {
  project: Project | null;
  session: Session | null;
  items: ChatItem[];
  status: StatusPayload["status"] | "empty";
  statusDetail: string;
  usage: Usage;
  error: string | null;
  permission: PermissionPrompt | null;
  mergeResult: string | null;
  sessionDiff: string | null;
  onSend: (text: string, mentions: Mention[]) => void;
  onStop: () => void;
  onAction: (action: "clear" | "new" | "stop") => void;
  onRespondPermission: (optionId: string) => void;
  onCloseSession: () => void;
  onMerge: () => void;
  queue: QueueItem[];
  onInterruptQueue: (id: string) => void;
  onRevokeQueue: (id: string) => void;
  composerValue: string;
  onComposerChange: (v: string) => void;
  history: string[];
  sessionId: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  idle: { label: "空闲", cls: "st-idle" },
  prompting: { label: "思考中", cls: "st-busy" },
  started: { label: "就绪", cls: "st-idle" },
  error: { label: "出错", cls: "st-error" },
  closed: { label: "已关闭", cls: "st-closed" },
  empty: { label: "", cls: "" },
};
const TOOL_STATUS_MAP: Record<string, { label: string; cls: string }> = {
  pending: { label: "等待", cls: "tc-pending" },
  in_progress: { label: "执行中", cls: "tc-running" },
  completed: { label: "完成", cls: "tc-done" },
  failed: { label: "失败", cls: "tc-fail" },
};

export default function ChatView(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { items } = props;
  // 用户是否贴底:记最近一次滚动的「贴底」状态。新消息到来时只在贴底才自动滚,
  // 用户向上翻阅历史时不打断(避免每条新消息强制拽回底部)。
  const stickToBottomRef = useRef(true);
  // 按 session 记忆滚动位置:切走时存 {top, stick},切回时恢复——用户读到哪里就从哪里继续。
  const scrollStateRef = useRef<Map<string, { top: number; stick: boolean }>>(new Map());
  const prevSessionIdRef = useRef<string>("");
  // prepend(加载更多)检测:记录上一轮的首条 id + 容器高度,比较后算高度差补偿 scrollTop。
  const prevFirstIdRef = useRef<string>("");
  const prevHeightRef = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 距底 ≤ 80px 视为贴底(留出阅读余量,避免最后一行差几像素被判为「不在底部」)。
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
    // 持续记忆当前位置,切走时已是最新的。
    scrollStateRef.current.set(props.session?.id || "", { top: el.scrollTop, stick: stickToBottomRef.current });
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sessionId = props.session?.id || "";
    // 切 session:瞬间定位(不动画,避免「乱滚」)。有记忆且不在底部 → 恢复原位;否则贴底(看最新)。
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      const saved = scrollStateRef.current.get(sessionId);
      if (saved && !saved.stick) {
        stickToBottomRef.current = false;
        el.scrollTop = saved.top;
      } else {
        stickToBottomRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
      prevFirstIdRef.current = items.length > 0 ? items[0].id : "";
      prevHeightRef.current = el.scrollHeight;
      return; // 切换瞬间一次性定位,不走下面的逻辑。
    }
    // 加载更多(prepend):首条 id 变了 → 补偿高度差,保持用户视觉位置不动。
    const firstId = items.length > 0 ? items[0].id : "";
    if (firstId !== prevFirstIdRef.current && prevFirstIdRef.current !== "" && firstId) {
      const delta = el.scrollHeight - prevHeightRef.current;
      el.scrollTop += delta;
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
      prevFirstIdRef.current = firstId;
      prevHeightRef.current = el.scrollHeight;
      return;
    }
    // 同一 session 内 items 变化(流式输出 / 历史加载完成):仅在贴底时跟随。
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    prevFirstIdRef.current = firstId;
    prevHeightRef.current = el.scrollHeight;
  }, [items, props.session?.id, props.permission]);

  const pct = props.usage.size > 0 ? Math.min(100, Math.round((props.usage.used / props.usage.size) * 100)) : 0;
  // 分级配色:上下文越满越警示(绿 → 琥珀 → 红),让占比一眼可读。
  const usageLevel = pct >= 85 ? "crit" : pct >= 60 ? "high" : pct >= 30 ? "mid" : "low";
  const hasUsage = props.usage.used > 0 || props.usage.size > 0 || props.usage.cost > 0;
  const s = STATUS_MAP[props.status] || { label: props.status, cls: "" };

  const onTitleDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a")) return;
    void ChatService.ToggleMaximise();
  };

  return (
    <div className="chat-view">
      <header className="chat-header" onDoubleClick={onTitleDoubleClick}>
        <div className="chat-header-info">
          <span className="chat-project" title={props.project?.path || ""}>{props.project?.name || ""}</span>
          <span className="chat-sep">/</span>
          <span className="chat-session-title">{props.session?.title || "新对话"}</span>
          {props.session?.model && <span className="chat-model">{props.session.model}</span>}
        </div>
        <div className="chat-header-actions">
          {s.label && <span className={`status-badge ${s.cls}`}>{s.label}</span>}
          <button className="icon-btn small" onClick={props.onCloseSession} title="关闭会话">
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="chat-body" ref={scrollRef} onScroll={onScroll} data-testid="chat-body">
        {items.length === 0 && <div className="chat-placeholder">发一条消息开始对话…</div>}
        {props.hasMore && (
          <button className="load-more-btn" onClick={props.onLoadMore} disabled={props.loadingMore} data-testid="load-more">
            {props.loadingMore ? "加载中…" : "加载更多"}
          </button>
        )}
        {items.map((item, i) => {
          // 连续工具调用折叠:遇到 tool 时,若前一个也是 tool 则跳过(已被组首个处理);
          // 组首个负责收集后续连续 tool,2 个以上渲染为 ToolGroup,单个仍用 ToolCard。
          if (item.type === "tool") {
            const prevIsTool = i > 0 && items[i - 1].type === "tool";
            if (prevIsTool) return null;
            const group = [item];
            for (let j = i + 1; j < items.length; j++) {
              const next = items[j];
              if (next.type !== "tool") break;
              group.push(next);
            }
            if (group.length >= 2) return <ToolGroup key={item.id} tools={group} />;
            return <ToolCard key={item.id} item={item} />;
          }
          return (
            <Fragment key={item.id}>
              {/* 回合分隔:每条用户消息(首条除外)前插一条带时间的分隔线,让多轮对话边界清晰。 */}
              {item.type === "user" && i > 0 && <TurnDivider ts={item.ts} />}
              <ChatRow item={item} />
            </Fragment>
          );
        })}
        {props.permission && <PermissionCard prompt={props.permission} onRespond={props.onRespondPermission} />}
        {props.status === "prompting" && items.length > 0 && (
          <div className="typing-indicator"><span /> <span /> <span /></div>
        )}
      </div>

      {props.error && <div className="error-bar">⚠ {props.error}</div>}
      {props.mergeResult && <div className={`merge-result ${props.mergeResult.startsWith("✅") ? "ok" : "fail"}`}>{props.mergeResult}</div>}

      <footer className="chat-footer">
        {hasUsage && (
          <div className={`usage-bar usage-${usageLevel}`} title="上下文用量" data-testid="usage-bar">
            <div className="usage-track"><div className="usage-fill" style={{ width: `${pct}%` }} /></div>
            <span className="usage-text">
              {formatTokens(props.usage.used)}
              {props.usage.size > 0 && ` / ${formatTokens(props.usage.size)}`}
              {props.usage.size > 0 && ` · ${pct}%`}
              {props.usage.cost > 0 && ` · $${props.usage.cost.toFixed(4)}`}
            </span>
          </div>
        )}
        <QueuePanel
          queue={props.queue}
          onInterrupt={props.onInterruptQueue}
          onRevoke={props.onRevokeQueue}
        />
        <Composer
          value={props.composerValue}
          onChange={props.onComposerChange}
          disabled={!props.session}
          prompting={props.status === "prompting"}
          model={props.session?.model || ""}
          onSend={props.onSend}
          onStop={props.onStop}
          onAction={props.onAction}
          history={props.history}
          sessionId={props.sessionId}
        />
      </footer>
    </div>
  );
}

const ChatRow = memo(function ChatRow({ item }: { item: ChatItem }) {
  if (item.type === "user") {
    return (
      <div className="row row-user" data-testid="msg-user">
        <div className="bubble-user">{item.text}</div>
      </div>
    );
  }
  if (item.type === "agent") {
    return (
      <div className="row row-agent" data-testid="msg-agent">
        <div className="avatar"><Sparkles size={15} /></div>
        <div className="bubble-agent-wrap">
          <div className="bubble-agent">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeRenderer, pre: PreRenderer }}>
              {item.text + (item.streaming ? " ▋" : "")}
            </ReactMarkdown>
          </div>
          <div className="msg-meta">
            {item.ts && <span className="msg-time">{formatTime(item.ts)}</span>}
            {!item.streaming && item.text && <MessageActions text={item.text} />}
          </div>
        </div>
      </div>
    );
  }
  if (item.type === "thought") {
    return <ThoughtBlock item={item} />;
  }
  return <ToolCard item={item} />;
});

// ThoughtBlock:思考块默认折叠(含流式中),summary 显示转圈 spinner;用户展开后记住偏好,
// 后续新思考块也默认展开;底部「收起」按钮方便长文本尾部直接收回(不用滚回顶部)。
function ThoughtBlock({ item }: { item: Extract<ChatItem, { type: "thought" }> }) {
  const [open, setOpen] = useState(() => localStorage.getItem("md:thought-open") === "true");
  const everOpenedRef = useRef(open);
  if (open) everOpenedRef.current = true;
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      localStorage.setItem("md:thought-open", String(next));
      return next;
    });
  };
  return (
    <div className="thought-block">
      <button className={`thought-summary ${open ? "open" : ""}`} onClick={toggle} type="button">
        {item.streaming ? <span className="thought-spinner" /> : <Brain size={13} />}
        <span className="thought-summary-label">{item.streaming ? "思考中" : "思考过程"}</span>
        <ChevronRight size={13} className="thought-chevron" />
      </button>
      <div className={`collapse-body ${open ? "open" : ""}`}>
        <div className="collapse-body-inner">
          {everOpenedRef.current && (
            <>
              <div className="thought-text">{item.text}</div>
              <button className="thought-collapse-btn" onClick={toggle}>收起</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };
  return (
    <div className="msg-actions">
      <button className="msg-action-btn" onClick={copy} data-testid="copy-msg">
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

// 连续工具调用折叠组:2 个以上连续 tool 包进一个 Collapsible,summary 显示数量 + 执行状态。
// 展开后内部各 tool 仍是独立 ToolCard(各自可再展开看 I/O)。
function ToolGroup({ tools }: { tools: Extract<ChatItem, { type: "tool" }>[] }) {
  const anyRunning = tools.some(t => t.status === "pending" || t.status === "in_progress");
  return (
    <Collapsible
      className="tool-group"
      open={false}
      summaryClassName="tool-group-summary"
      summary={<>
        {anyRunning ? <span className="thought-spinner" /> : <Wrench size={13} />}
        <span className="tool-group-count">{tools.length} 个工具调用</span>
        <span className={`tool-group-status ${anyRunning ? "tg-running" : "tg-done"}`}>
          {anyRunning ? "执行中…" : "已完成"}
        </span>
      </>}
    >
      {tools.map(t => <ToolCard key={t.id} item={t} />)}
    </Collapsible>
  );
}

function ToolCard({ item }: { item: Extract<ChatItem, { type: "tool" }> }) {
  const st = TOOL_STATUS_MAP[item.status] || { label: item.status || "未知", cls: "tc-unknown" };
  const [copiedIn, setCopiedIn] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);
  const inputR = item.rawInput != null ? extractToolText(item.rawInput) : null;
  const outputR = item.rawOutput != null ? extractToolText(item.rawOutput) : null;
  const copyIn = async () => { try { await navigator.clipboard.writeText(inputR?.text || ""); setCopiedIn(true); setTimeout(() => setCopiedIn(false), 1200); } catch { /* noop */ } };
  const copyOut = async () => { try { await navigator.clipboard.writeText(outputR?.text || ""); setCopiedOut(true); setTimeout(() => setCopiedOut(false), 1200); } catch { /* noop */ } };
  return (
    <Collapsible
      className="tool-card"
      open={false}
      summaryClassName="tool-summary"
      summary={<>
        <Wrench size={13} />
        <span className="tool-title">{item.title || "工具调用"}</span>
        {item.kind && <span className="tool-kind">{item.kind}</span>}
        <span className={`tool-status ${st.cls}`}>{st.label}</span>
      </>}
    >
      {inputR && (
        <div className="tool-section">
          <div className="tool-section-head">
            <span className="tool-section-label">输入</span>
            <button className="msg-action-btn" onClick={copyIn}>{copiedIn ? <Check size={11} /> : <Copy size={11} />}</button>
          </div>
          <pre className={inputR.fallback ? "tool-pre" : "tool-pre tool-term"}>{inputR.text}</pre>
        </div>
      )}
      {outputR && (
        <div className="tool-section">
          <div className="tool-section-head">
            <span className="tool-section-label">
              输出{outputR.exit != null ? ` · exit ${outputR.exit}` : ""}{outputR.truncated ? " · 截断" : ""}
            </span>
            <button className="msg-action-btn" onClick={copyOut}>{copiedOut ? <Check size={11} /> : <Copy size={11} />}</button>
          </div>
          <pre className={outputR.fallback ? "tool-pre" : "tool-pre tool-term"}>{outputR.text}</pre>
        </div>
      )}
    </Collapsible>
  );
}

function PermissionCard({ prompt, onRespond }: { prompt: PermissionPrompt; onRespond: (id: string) => void }) {
  return (
    <div className="permission-card" data-testid="permission-card">
      <div className="permission-head">
        <ShieldAlert size={18} />
        <div>
          <div className="permission-title">{prompt.title || "权限请求"}</div>
          {prompt.toolName && <div className="permission-tool">{prompt.toolName}</div>}
        </div>
      </div>
      <div className="permission-actions">
        <button className="perm-btn perm-allow" data-testid="perm-once" onClick={() => onRespond("once")}>允许本次</button>
        <button className="perm-btn perm-allow" data-testid="perm-session" onClick={() => onRespond("session")}>本会话允许</button>
        <button className="perm-btn perm-allow" data-testid="perm-project" onClick={() => onRespond("project")}>本项目允许</button>
        <button className="perm-btn perm-deny" data-testid="perm-deny" onClick={() => onRespond("deny")}>本次拒绝</button>
      </div>
    </div>
  );
}

function PreRenderer(props: ComponentPropsWithoutRef<"pre">) {
  const codeEl = extractCodeChild(props.children);
  return <CodeBox language={codeEl?.language || "code"} raw={codeEl?.text || ""} />;
}

function CodeRenderer(props: ComponentPropsWithoutRef<"code">) {
  const { className, children, ...rest } = props;
  const isBlock = Boolean(className?.includes("language-")) || String(children ?? "").includes("\n");
  if (isBlock) return <code className={className} data-block {...rest}>{children}</code>;
  return <code className="code-inline" {...rest}>{children}</code>;
}

function CodeBox({ language, raw }: { language: string; raw: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(raw); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };
  return (
    <div className="code-box">
      <div className="code-box-head">
        <span className="code-lang">{language}</span>
        <button className="msg-action-btn" onClick={copy} data-testid="copy-code">
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="code-box-pre"><code>{raw}</code></pre>
    </div>
  );
}

function extractCodeChild(children: ComponentPropsWithoutRef<"pre">["children"]): { language: string; text: string } | null {
  const node = Array.isArray(children) ? children[0] : children;
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const props = (node as { props: { className?: string; children?: unknown } }).props;
  const cls = props.className || "";
  const lang = /language-(\w[\w+-]*)/.exec(cls)?.[1] || "";
  const text = typeof props.children === "string" ? props.children : String(props.children ?? "");
  return { language: lang || "code", text: text.replace(/\n$/, "") };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// 回合分隔:发丝线 + 时间,清晰划分每一轮对话(用户消息前的锚点)。
function TurnDivider({ ts }: { ts?: number }) {
  return (
    <div className="turn-divider">
      <span className="turn-divider-line" />
      {ts && <span className="turn-divider-time">{formatTime(ts)}</span>}
      <span className="turn-divider-line" />
    </div>
  );
}

// 时间格式化:今天显示 HH:mm;跨天显示 MM-DD HH:mm;无 ts 返回空。
function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }
// 把结构化数据转成人可读文本,绝不把 {…} / JSON 原样给用户(AGENTS.md §4.4)。
// string 原样;record 渲染成「键: 值」逐行;数组逐项;嵌套对象/数组用紧凑单行兜底。
function formatHuman(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(formatHuman).filter(Boolean).join("\n");
  if (isRecord(v)) {
    const lines: string[] = [];
    for (const [k, val] of Object.entries(v)) {
      if (val == null || val === "") continue;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") lines.push(`${k}: ${val}`);
      else lines.push(`${k}: ${formatInline(val)}`);
    }
    return lines.join("\n");
  }
  return String(v);
}
function formatInline(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(formatInline).join(", ");
  try { return JSON.stringify(v); } catch { return String(v); }
}

function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object"; }

// 从工具的 input/output 提取「人类可读的主要文本」+ exit/truncated 元信息。
// opencode 的工具结果常是 {output, metadata:{exit,output,truncated}} 或 {command/content/...},
// 直接 JSON 不直观;这里抽出主文本干净展示,找不到才回退 JSON。
function extractToolText(raw: unknown): { text: string; exit?: number; truncated?: boolean; fallback: boolean } {
  if (typeof raw === "string") return { text: raw, fallback: false };
  if (!isRecord(raw)) return { text: formatHuman(raw), fallback: true };
  const meta = isRecord(raw.metadata) ? raw.metadata : undefined;
  const exit = typeof meta?.exit === "number" ? meta.exit : (typeof raw.exit === "number" ? raw.exit : undefined);
  const truncated = Boolean(meta?.truncated ?? raw.truncated);
  for (const k of ["output", "stdout", "stderr", "content", "command", "prompt", "message", "text"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return { text: v, exit, truncated, fallback: false };
  }
  if (typeof meta?.output === "string" && meta.output.trim()) return { text: meta.output, exit, truncated, fallback: false };
  return { text: formatHuman(raw), exit, truncated, fallback: true };
}
