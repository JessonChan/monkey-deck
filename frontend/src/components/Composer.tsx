import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import Icon from "./Icon";

interface Props {
  disabled: boolean;
  prompting: boolean;
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

export default function Composer({ disabled, prompting, model, onSend, onStop, onAction }: Props) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const slashQuery = useMemo(() => {
    const t = text.trimStart();
    if (t.startsWith("/") && !/\s/.test(t)) return t.slice(1).toLowerCase();
    return null;
  }, [text]);
  const filtered = useMemo(
    () => (slashQuery == null ? [] : SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(slashQuery))),
    [slashQuery]
  );
  useEffect(() => {
    const open = slashQuery != null && filtered.length > 0;
    setSlashOpen(open);
    if (open) setSlashIdx(0);
  }, [slashQuery, filtered.length]);

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  };
  useEffect(() => { if (ref.current) autoGrow(ref.current); }, [text]);

  const injectAttachments = (base: string) => {
    if (attachments.length === 0) return base;
    const lines = attachments.map((p) => `@${p}`).join("\n");
    return base.trim() ? `${base}\n\n${lines}` : lines;
  };
  const submit = (finalText?: string) => {
    const t = (finalText ?? text).trim();
    if ((!t && attachments.length === 0) || (disabled && !finalText)) return;
    onSend(injectAttachments(t));
    setText("");
    setAttachments([]);
    requestAnimationFrame(() => { if (ref.current) ref.current.style.height = "auto"; });
  };
  const pickSlash = (c: SlashCommand) => {
    if (c.action) onAction(c.action);
    else if (c.insert) setText(c.insert);
    setSlashOpen(false);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法(IME)composing 中:Enter 用于选词,不提交/不触发命令。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
                <span className="att-chip-name"><Icon name="paperclip" size={11} /> {baseName(p)}</span>
                <button className="att-chip-x" onClick={() => setAttachments((prev) => prev.filter((x) => x !== p))}><Icon name="close" size={11} /></button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          className="composer-input"
          data-testid="composer-input"
          value={text}
          placeholder="给 monkey-deck 发消息…   (Enter 发送 · Shift+Enter 换行 · 输入 / 看命令)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />

        <div className="compose-bar">
          <div className="compose-tools">
            <button className="tool-btn" data-testid="attach-btn" onClick={addFiles} disabled={disabled} title="附加文件(@/path 注入)">
              <Icon name="paperclip" size={17} />
            </button>
            <button
              className="tool-btn"
              onClick={() => { setText((p) => (p.startsWith("/") ? p : "/" + p)); requestAnimationFrame(() => ref.current?.focus()); }}
              disabled={disabled}
              title="输入 / 召出命令菜单"
            >
              <Icon name="slash" size={17} />
            </button>
          </div>
          <div className="compose-right">
            {model && <span className="composer-model" title="当前 model">{model}</span>}
            {attachments.length > 0 && <span className="composer-count">{attachments.length} 附件</span>}
            {text.length > 0 && <span className="composer-count">{text.length} 字</span>}
            {prompting ? (
              <button className="send-btn stop" data-testid="stop-btn" onClick={onStop} title="停止">
                <Icon name="stop" size={15} />
              </button>
            ) : (
              <button className="send-btn" data-testid="send-btn" onClick={() => submit()} disabled={disabled || (!text.trim() && attachments.length === 0)} title="发送">
                <Icon name="send" size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
