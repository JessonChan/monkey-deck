import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import { Paperclip, X, Slash, Square, ArrowUp } from "lucide-react";

interface Props {
  value: string;            // 受控文本(由 App 持有,支持「撤回编辑」回填)
  onChange: (v: string) => void;
  disabled: boolean;        // 无 session 时禁用全部交互
  prompting: boolean;       // 一轮进行中:显示停止键 + send 提示将排队
  model: string;
  onSend: (text: string) => void;
  onStop: () => void;
  onAction: (action: "clear" | "new" | "stop") => void;
}

// 斜杠命令(wesight 风格)。insert=插入模板;action=执行动作。
interface SlashCommand { cmd: string; desc: string; insert?: string; action?: "clear" | "new" | "stop"; }
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/explain", desc: "解释代码", insert: "请解释这段代码,讲清逻辑与关键点:" },
  { cmd: "/review", desc: "代码审查", insert: "请 review 这段代码,指出问题、风险与改进建议:" },
  { cmd: "/tests", desc: "生成测试", insert: "请为这段代码编写单元测试,覆盖边界:" },
  { cmd: "/refactor", desc: "重构", insert: "请重构这段代码,提升可读性与可维护性,保持行为不变:" },
  { cmd: "/fix", desc: "修复 bug", insert: "请找出并修复这里的 bug,说明根因:" },
  { cmd: "/doc", desc: "写文档", insert: "请为这段代码编写清晰的文档/注释:" },
  { cmd: "/summary", desc: "总结文件", insert: "请总结这个文件的作用、结构与关键逻辑:" },
  { cmd: "/new", desc: "新对话", action: "new" },
  { cmd: "/clear", desc: "清空(新会话)", action: "clear" },
  { cmd: "/stop", desc: "停止生成", action: "stop" },
];

export default function Composer({ value, onChange, disabled, prompting, model, onSend, onStop, onAction }: Props) {
  const [attachments, setAttachments] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const slashQuery = useMemo(() => {
    if (!value.startsWith("/")) return null;
    const rest = value.slice(1);
    return rest.includes(" ") ? null : rest;
  }, [value]);
  const filtered = useMemo(
    () => (slashQuery == null ? [] : SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(slashQuery))),
    [slashQuery]
  );
  useEffect(() => {
    setSlashOpen(filtered.length > 0);
    setSlashIdx(0);
  }, [slashQuery, filtered.length]);

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  };
  useEffect(() => { if (ref.current) autoGrow(ref.current); }, [value]);

  const injectAttachments = (base: string) => {
    if (attachments.length === 0) return base;
    const lines = attachments.map((p) => `@${p}`).join("\n");
    return base.trim() ? `${base}\n\n${lines}` : lines;
  };
  const submit = (finalText?: string) => {
    if (disabled) return;
    const t = (finalText ?? value).trim();
    if (!t && attachments.length === 0) return;
    onSend(injectAttachments(t));   // App 决定: idle 直发 / prompting 入队
    onChange("");
    setAttachments([]);
    requestAnimationFrame(() => { if (ref.current) ref.current.style.height = "auto"; });
  };
  const pickSlash = (c: SlashCommand) => {
    if (c.action) onAction(c.action);
    else if (c.insert) onChange(c.insert);
    setSlashOpen(false);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法(IME)composing 中:Enter 用于选词,不提交/不触发命令。
    // isComposing 已覆盖 IME 场景,不再依赖已废弃的 keyCode===229。
    if (e.nativeEvent.isComposing) return;
    if (slashOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(filtered[slashIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlashOpen(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); }
  };

  const addFiles = async () => {
    try {
      const paths = await ChatService.PickFiles();
      if (paths && paths.length) setAttachments((prev) => [...prev, ...paths]);
    } catch { /* 取消静默 */ }
  };
  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;
  const empty = !value.trim() && attachments.length === 0;

  return (
    <div className="composer" data-testid="composer">
      {slashOpen && (
        <div className="slash-popover" data-testid="slash-popover">
          {filtered.map((c, i) => (
            <button key={c.cmd} className={`slash-item ${i === slashIdx ? "active" : ""}`} onMouseEnter={() => setSlashIdx(i)} onClick={() => pickSlash(c)}>
              <span className="slash-cmd">{c.cmd}</span>
              <span className="slash-desc">{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="compose-card">
        {attachments.length > 0 && (
          <div className="att-chips" data-testid="att-chips">
            {attachments.map((p) => (
              <span key={p} className="att-chip" title={p}>
                <span className="att-chip-name"><Paperclip size={11} /> {baseName(p)}</span>
                <button className="att-chip-x" onClick={() => setAttachments((prev) => prev.filter((x) => x !== p))}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          className="composer-input"
          data-testid="composer-input"
          value={value}
          placeholder={prompting ? "排队下一条…(Enter 入队 · 本轮结束后自动发)" : "给 monkey-deck 发消息…   (Enter 发送 · Shift+Enter 换行 · 输入 / 看命令)"}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />

        <div className="compose-bar">
          <div className="compose-tools">
            <button className="tool-btn" data-testid="attach-btn" onClick={addFiles} disabled={disabled} title="附加文件(@/path 注入)">
              <Paperclip size={17} />
            </button>
            <button
              className="tool-btn"
              onClick={() => { onChange(value.startsWith("/") ? value : "/" + value); requestAnimationFrame(() => ref.current?.focus()); }}
              disabled={disabled}
              title="输入 / 召出命令菜单"
            >
              <Slash size={17} />
            </button>
          </div>
          <div className="compose-right">
            {model && <span className="composer-model" title="当前 model">{model}</span>}
            {attachments.length > 0 && <span className="composer-count">{attachments.length} 附件</span>}
            {value.length > 0 && <span className="composer-count">{value.length} 字</span>}
            {prompting && (
              <button className="send-btn stop" data-testid="stop-btn" onClick={onStop} title="停止当前生成(不清理队列)">
                <Square size={15} />
              </button>
            )}
            <button
              className="send-btn"
              data-testid="send-btn"
              onClick={() => submit()}
              disabled={disabled || empty}
              title={prompting ? "排队发送(本轮结束后自动发)" : "发送"}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
