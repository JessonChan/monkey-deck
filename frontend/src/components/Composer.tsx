import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ConfigOption } from "../types";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";
import type { Mention } from "../types";
import { Paperclip, X, Slash, Square, ArrowUp, File, Folder } from "lucide-react";

interface Props {
  value: string;            // 受控文本(由 App 持有,支持「撤回编辑」回填)
  onChange: (v: string) => void;
  disabled: boolean;        // 无 session 时禁用全部交互
  prompting: boolean;       // 一轮进行中:显示停止键 + send 提示将排队
  configOptions: ConfigOption[];        // agent 自报的 model/mode/effort(渲染下拉)
  onSetConfig: (configId: string, value: string) => void;  // 切换 config option(热切)
  history: string[];        // 输入框历史(上下键翻):该 session 全部发过的消息,无长度限制
  sessionId: string;        // @autocomplete 浏览此 session 的 cwd
  attachments: string[];      // 回形针附件(绝对路径)— 按 session 隔离(App 持有)
  onAttachmentsChange: (next: string[]) => void;
  mentions: Mention[];        // @autocomplete 选中项 — 按 session 隔离(App 持有)
  onMentionsChange: (next: Mention[]) => void;
  onSend: (text: string, mentions: Mention[]) => void;
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

// 从光标位置向前找当前 token:若以 @ 开头,返回 @ 的起点 + @ 之后的查询文本。
function detectMention(text: string, pos: number): { start: number; query: string } | null {
  let i = pos - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const wordStart = i + 1;
  if (text[wordStart] !== "@") return null;
  return { start: wordStart, query: text.slice(wordStart + 1, pos) };
}

export default function Composer({ value, onChange, disabled, prompting, configOptions, onSetConfig, history, sessionId, attachments, onAttachmentsChange, mentions, onMentionsChange, onSend, onStop, onAction }: Props) {
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef(0);                                       // 光标位置(命令式读写,供 @ 插入定位)
  const [cursorPos, setCursorPos] = useState(0);                     // 光标位置(仅作 mention useMemo 的重算触发器;cursorRef 才是权威值)
  // IME 合成追踪:compositionStart/End 手动记录,配合 isComposing + keyCode===229 三重保险,
  // 彻底防中文输入法选词确认的 Enter 被误判为发送(部分 macOS IME 下 isComposing 不可靠)。
  const composingRef = useRef(false);

  // --- 上下键翻历史 ---
  // navIdx = -1:未翻历史(显示当前草稿);否则指向 history 数组的下标(当前展示的那条)。
  // history 按时间升序(末尾=最新)。↑ 向旧、↓ 向新,翻过最新恢复草稿。
  const navRef = useRef(-1);
  const draftRef = useRef("");

  // --- @autocomplete ---
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionItems, setMentionItems] = useState<FileNode[]>([]);

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

  // @ 触发:每次 value 或光标位置变化,据光标位置判定是否在 @ 提及中,拉目录列表过滤。
  const mentionInfo = useMemo(() => detectMention(value, cursorRef.current), [value, cursorPos]);
  useEffect(() => {
    if (!sessionId || slashOpen) { setMentionOpen(false); return; }
    if (!mentionInfo) { setMentionOpen(false); return; }
    const q = mentionInfo.query;
    const slash = q.lastIndexOf("/");
    const dir = slash >= 0 ? q.slice(0, slash) : "";
    const filter = slash >= 0 ? q.slice(slash + 1) : q;
    let cancelled = false;
    // 防抖:快打字时不每次按键都打后端 IPC,150ms 内的新 keystroke 取消上一次拉目录。
    const timer = setTimeout(() => {
      ChatService.SessionListDir(sessionId, dir).then((nodes) => {
        if (cancelled) return;
        const list = (nodes || [])
          .filter((n) => n.name !== ".git")
          .filter((n) => n.name.toLowerCase().includes(filter.toLowerCase()))
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
          .slice(0, 12);
        setMentionItems(list);
        setMentionIdx(0);
        setMentionOpen(list.length > 0);
      }).catch(() => { if (!cancelled) setMentionOpen(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mentionInfo, sessionId, slashOpen]);

  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;
  const empty = !value.trim() && attachments.length === 0 && mentions.length === 0;

  const submit = (finalText?: string) => {
    if (disabled) return;
    const t = (finalText ?? value).trim();
    // 收集有效提及:@autocomplete 选中的需仍在文本里(用户可能已删掉);用词边界防 @src/foo 误命中 @src/foobar。
    const inline = mentions.filter((m) => {
      const token = "@" + m.path;
      const idx = t.indexOf(token);
      if (idx === -1) return false;
      const after = idx + token.length;
      return after >= t.length || /\s/.test(t[after]);
    });
    const clips = attachments.map((p) => ({ path: p, name: baseName(p) }));
    const all = [...inline, ...clips];
    if (!t && all.length === 0) return;
    onSend(t, all);
    onChange("");
    onAttachmentsChange([]);
    onMentionsChange([]);
    navRef.current = -1;
    setMentionOpen(false);
    setSlashOpen(false);
    requestAnimationFrame(() => { if (ref.current) ref.current.style.height = "auto"; });
  };
  const pickSlash = (c: SlashCommand) => {
    if (c.action) onAction(c.action);
    else if (c.insert) onChange(c.insert);
    setSlashOpen(false);
    requestAnimationFrame(() => ref.current?.focus());
  };

  // 把当前光标所在的 @query 替换成 newQuery(不含 @),同步更新 cursorRef。
  // 关键:cursorRef 必须在 onChange 前同步更新,否则 useMemo detectMention 用旧光标重开面板。
  const setMentionQuery = (newQuery: string): boolean => {
    const pos = cursorRef.current;
    const m = detectMention(value, pos);
    if (!m) return false;
    const insert = "@" + newQuery;
    cursorRef.current = m.start + insert.length;
    onChange(value.slice(0, m.start) + insert + value.slice(pos));
    setMentionIdx(0);
    return true;
  };
  // 进入子文件夹:把 @query 改成 @folderPath/,列表随之刷新到该文件夹内容。
  const descendMention = (node: FileNode) => setMentionQuery(node.path + "/");
  // 返回上一级目录(←);已在根目录则不动作(返回 false 让光标正常左移)。
  const ascendMention = (): boolean => {
    const q = mentionInfo?.query ?? "";
    const slash = q.lastIndexOf("/");
    if (slash < 0) return false; // 已在根
    const dir = q.slice(0, slash);
    const upDir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    return setMentionQuery(upDir ? upDir + "/" : "");
  };
  // 选中一个 @ 候选:把 @query 替换成 @完整路径 + 尾随空格,记录提及,关闭面板。
  const pickMention = (node: FileNode) => {
    const pos = cursorRef.current;
    const m = detectMention(value, pos);
    if (!m) return;
    const token = "@" + node.path + " ";
    cursorRef.current = m.start + token.length; // 同步,防面板重开
    const next = value.slice(0, m.start) + token + value.slice(pos);
    onChange(next);
    if (!mentions.some((x) => x.path === node.path)) {
      onMentionsChange([...mentions, { path: node.path, name: node.name }]);
    }
    setMentionOpen(false);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorRef.current; }
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法(IME)composing 中:Enter 用于选词,不提交/不触发命令。
    // 三重检查:手动 ref 追踪(最可靠)+ isComposing(标准)+ keyCode 229(已废弃但兜底)。
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

    // 斜杠命令菜单(优先级最高)
    if (slashOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(filtered[slashIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlashOpen(false); return; }
    }
    // @ 提及菜单(业界惯例:→/Tab/点击 进文件夹,← 返回上级,Enter 确认选中)
    if (mentionOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => Math.min(i + 1, mentionItems.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter") { e.preventDefault(); pickMention(mentionItems[mentionIdx]); return; }
      // Tab / → :文件夹 → 进入;文件 → 选中。
      if (e.key === "Tab" || e.key === "ArrowRight") {
        e.preventDefault();
        const node = mentionItems[mentionIdx];
        if (node?.isDir) descendMention(node); else pickMention(node);
        return;
      }
      // ← :返回上一级(已在根则放行,让光标正常左移)。
      if (e.key === "ArrowLeft" && ascendMention()) { e.preventDefault(); return; }
      if (e.key === "Escape") { e.preventDefault(); setMentionOpen(false); return; }
    }

    // 上下键翻历史:仅当光标在首行(↑)/末行(↓),且无菜单时。
    const el = ref.current;
    if (el && e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const before = value.slice(0, el.selectionStart);
      if (!before.includes("\n")) {
        e.preventDefault();
        navigateHistory(-1);
        return;
      }
    }
    if (el && e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (navRef.current === -1) return; // 未在翻历史,让光标正常下移
      const after = value.slice(el.selectionStart);
      if (!after.includes("\n")) {
        e.preventDefault();
        navigateHistory(1);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); }
  };

  // dir = -1 向旧(↑),dir = 1 向新(↓)。翻到最新之后恢复草稿。
  const navigateHistory = (dir: number) => {
    if (history.length === 0) return;
    if (navRef.current === -1) {
      if (dir > 0) return; // 未在翻历史,↓ 无意义
      draftRef.current = value; // 进入翻历史前存当前草稿
      navRef.current = history.length - 1;
    } else {
      const next = navRef.current + dir; // dir=-1(↑向旧) → idx 减;dir=1(↓向新) → idx 增
      if (next >= history.length) { navRef.current = -1; onChange(draftRef.current); moveCursorEnd(); return; }
      if (next < 0) { navRef.current = 0; }
      else { navRef.current = next; }
    }
    onChange(history[navRef.current]);
    moveCursorEnd();
  };
  const moveCursorEnd = () => {
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.selectionStart = el.selectionEnd = el.value.length; cursorRef.current = el.value.length; }
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    cursorRef.current = e.target.selectionEnd ?? 0;
    setCursorPos(cursorRef.current);
    navRef.current = -1; // 真实输入(非翻历史)→ 退出翻历史模式
    onChange(e.target.value);
  };
  const handleSelect = () => {
    const el = ref.current;
    if (el) { cursorRef.current = el.selectionEnd ?? 0; setCursorPos(cursorRef.current); }
  };

  const addFiles = async () => {
    try {
      const paths = await ChatService.PickFiles();
      if (paths && paths.length) onAttachmentsChange([...attachments, ...paths]);
    } catch { /* 取消静默 */ }
  };

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
      {mentionOpen && (
        <div className="slash-popover mention-popover" data-testid="mention-popover">
          {(() => {
            const q = mentionInfo?.query ?? "";
            const s = q.lastIndexOf("/");
            const dir = s >= 0 ? q.slice(0, s) : "";
            return dir ? <div className="mention-cwd">📁 {dir}/ <span className="mention-hint">← 返回</span></div> : null;
          })()}
          {mentionItems.map((n, i) => (
            <button key={n.path} className={`slash-item ${i === mentionIdx ? "active" : ""}`} onMouseEnter={() => setMentionIdx(i)} onClick={() => (n.isDir ? descendMention(n) : pickMention(n))}>
              {n.isDir ? <Folder size={13} /> : <File size={13} />}
              <span className="slash-cmd">{n.name}</span>
              <span className="slash-desc">{n.isDir ? "→ 进入" : ""}</span>
            </button>
          ))}
        </div>
      )}

      <div className="compose-card">
        {(attachments.length > 0 || mentions.length > 0) && (
          <div className="att-chips" data-testid="att-chips">
            {attachments.map((p) => (
              <span key={p} className="att-chip" title={p}>
                <span className="att-chip-name"><Paperclip size={11} /> {baseName(p)}</span>
                <button className="att-chip-x" onClick={() => onAttachmentsChange(attachments.filter((x) => x !== p))}><X size={11} /></button>
              </span>
            ))}
            {mentions.map((m) => (
              <span key={m.path} className="att-chip att-chip-mention" title={"@" + m.path}>
                <span className="att-chip-name"><File size={11} /> {m.name}</span>
                <button className="att-chip-x" onClick={() => {
                  const token = "@" + m.path;
                  const idx = value.indexOf(token);
                  if (idx !== -1) {
                    let end = idx + token.length;
                    if (value[end] === " ") end += 1; // 吃掉插入时的尾随空格
                    onChange(value.slice(0, idx) + value.slice(end));
                  }
                  onMentionsChange(mentions.filter((x) => x.path !== m.path));
                }}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          className="composer-input"
          data-testid="composer-input"
          value={value}
          placeholder={prompting ? "排队下一条…(Enter 入队 · 本轮结束后自动发)" : "给 monkey-deck 发消息…   (Enter 发送 · Shift+Enter 换行 · @ 提文件 · / 看命令 · ↑↓ 翻历史)"}
          onChange={handleChange}
          onSelect={handleSelect}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          rows={2}
        />

        <div className="compose-bar">
          <div className="compose-tools">
            <button className="tool-btn" data-testid="attach-btn" onClick={addFiles} disabled={disabled} title="附加文件(经 ACP ResourceLink 发送)">
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
            <ModelSelect configOptions={configOptions} disabled={disabled} onSetConfig={onSetConfig} />
            {(attachments.length > 0 || mentions.length > 0) && <span className="composer-count">{attachments.length + mentions.length} 引用</span>}
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

// ModelSelect 渲染 configOptions 里的 model/effort/mode 下拉(发送按钮左侧)。
// model 按 value 的 provider 前缀("provider/model")分组(optgroup);
// effort(thought_level)/mode 条件出现 —— agent 没报就不显示(如 GLM-4.6/5.1 无 effort)。
// 未 active(harness 未启)时 configOptions 为空 → 不渲染(session.Model 仍在 header 静态显示)。
function ModelSelect({ configOptions, disabled, onSetConfig }: {
  configOptions: ConfigOption[];
  disabled: boolean;
  onSetConfig: (configId: string, value: string) => void;
}) {
  const modelOpt = configOptions.find((c) => c.category === "model");
  const effortOpt = configOptions.find((c) => c.category === "thought_level");
  const modeOpt = configOptions.find((c) => c.category === "mode");
  // model 按 provider 分组:value 形如 "zai/glm-4.6",取 "/" 前缀。
  const groups = useMemo(() => {
    const g: Record<string, { value: string; name: string }[]> = {};
    for (const o of modelOpt?.options ?? []) {
      const prov = o.value.split("/")[0] || "other";
      (g[prov] ??= []).push(o);
    }
    return g;
  }, [modelOpt]);
  if (!modelOpt) return null;
  return (
    <div className="cfg-group">
      <select
        className="cfg-select"
        value={modelOpt.currentValue}
        disabled={disabled}
        onChange={(e) => onSetConfig("model", e.target.value)}
        title="选择模型"
      >
        {Object.entries(groups).map(([prov, opts]) => (
          <optgroup key={prov} label={prov}>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>{o.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {modeOpt && (
        <select
          className="cfg-select"
          value={modeOpt.currentValue}
          disabled={disabled}
          onChange={(e) => onSetConfig("mode", e.target.value)}
          title="会话模式"
        >
          {modeOpt.options.map((o) => (
            <option key={o.value} value={o.value}>{o.name}</option>
          ))}
        </select>
      )}
      {effortOpt && (
        <select
          className="cfg-select"
          value={effortOpt.currentValue}
          disabled={disabled}
          onChange={(e) => onSetConfig("effort", e.target.value)}
          title="思考等级"
        >
          {effortOpt.options.map((o) => (
            <option key={o.value} value={o.value}>{o.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}
