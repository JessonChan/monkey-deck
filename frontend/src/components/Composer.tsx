import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import type { ConfigOption } from "../types";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";
import type { Mention, ImageAttachment } from "../types";
import { Paperclip, X, Slash, Square, ArrowUp, File, Folder, ChevronDown, ChevronUp, ImageIcon } from "lucide-react";

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
  images: ImageAttachment[];  // 内联图片附件 — 按 session 隔离(App 持有)
  onImagesChange: (next: ImageAttachment[]) => void;
  imageSupported: boolean;    // agent 是否声明 image prompt 能力(门控图片输入入口)
  usage: { used: number; size: number; cost: number };  // 上下文用量(展示已用/上限)
  onSend: (text: string, mentions: Mention[], images?: ImageAttachment[]) => void;
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

// 长文本折叠阈值:超过则折叠成 TUI 风格紧凑块(首尾若干行 + 中间省略),避免撑爆输入区。
// 折叠仅为展示态,提交内容仍是完整 value(见 submit)。
const LONG_LINE_THRESHOLD = 8;     // 行数阈值
const LONG_CHAR_THRESHOLD = 480;   // 字符数阈值(单/双行长文本兜底)
const COLLAPSE_HEAD_LINES = 4;     // 折叠时展示前 N 行
const COLLAPSE_TAIL_LINES = 2;     // 折叠时展示后 M 行

// 从光标位置向前找当前 token:若以 @ 开头,返回 @ 的起点 + @ 之后的查询文本。
function detectMention(text: string, pos: number): { start: number; query: string } | null {
  let i = pos - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const wordStart = i + 1;
  if (text[wordStart] !== "@") return null;
  return { start: wordStart, query: text.slice(wordStart + 1, pos) };
}

// 草稿文本 token 预估:无后端精确分词器,用「字符数/4」近似(GPT 系经验比值,CJK 偏高、英文偏低,
// 取中间值做占位提示,非计费依据)。展示在输入区附近给用户「这条大概多少 token」的直觉。
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

// 格式化 token 数为可读短串(<1k 显示原数,≥1k 用 k 单位)。
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

// 读 File 为 base64(去 data: 前缀)。用于把粘贴/选择的图片转成 ACP ContentBlock::Image 的 Data。
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = r.result;
      if (typeof res !== "string") { reject(new Error("read failed")); return; }
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// 接受的图片 mime 白名单(ACP ContentBlock::Image 常见类型)。
const IMAGE_MIME_ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
// 单图大小上限(base64 前,字节):10MB。过大发不出去且占上下文,超过则拒收并提示。
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export default function Composer({ value, onChange, disabled, prompting, configOptions, onSetConfig, history, sessionId, attachments, onAttachmentsChange, mentions, onMentionsChange, images, onImagesChange, imageSupported, usage, onSend, onStop, onAction }: Props) {
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef(0);                                       // 光标位置(命令式读写,供 @ 插入定位)
  const [cursorPos, setCursorPos] = useState(0);                     // 光标位置(仅作 mention useMemo 的重算触发器;cursorRef 才是权威值)
  // IME 合成追踪:compositionStart/End 手动记录,配合 isComposing + keyCode===229 三重保险,
  // 彻底防中文输入法选词确认的 Enter 被误判为发送(部分 macOS IME 下 isComposing 不可靠)。
  const composingRef = useRef(false);

  // --- 长文本折叠(展示态)---
  // isLong:超过行/字符阈值即为长文本;collapsed:是否折叠成紧凑预览块。
  // 折叠时 textarea 不渲染,改渲染首尾预览;展开恢复 textarea(可滚动编辑全文)。
  const isLong = useMemo(() => {
    const lineCount = value.split("\n").length;
    return lineCount > LONG_LINE_THRESHOLD || value.length > LONG_CHAR_THRESHOLD;
  }, [value]);
  const [collapsed, setCollapsed] = useState(false);
  // 预览:行多 → 首尾若干行 + 中间省略;行少但字符超长(单行长文本)→ 全部行逐行截断 + 字符提示。
  const preview = useMemo(() => {
    if (!isLong) return null;
    const all = value.split("\n");
    if (all.length > COLLAPSE_HEAD_LINES + COLLAPSE_TAIL_LINES) {
      return {
        head: all.slice(0, COLLAPSE_HEAD_LINES),
        tail: all.slice(all.length - COLLAPSE_TAIL_LINES),
        note: `${all.length - COLLAPSE_HEAD_LINES - COLLAPSE_TAIL_LINES} 行已折叠`,
      };
    }
    return { head: all, tail: [], note: `${value.length} 字符 · 长行已截断` };
  }, [isLong, value]);
  // 自动折叠:长文本 + textarea 非聚焦(草稿恢复 / 外部回填 / 粘贴后失焦)→ 折叠;手打中(聚焦)不打扰。
  useEffect(() => {
    if (!isLong) { setCollapsed(false); return; }
    if (document.activeElement !== ref.current) setCollapsed(true);
  }, [isLong]);
  const expandInput = () => {
    setCollapsed(false);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
        cursorRef.current = el.value.length;
        autoGrow(el);
      }
    });
  };
  const collapseInput = () => setCollapsed(true);

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
  useEffect(() => { if (ref.current) autoGrow(ref.current); }, [value, collapsed]);

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
  const empty = !value.trim() && attachments.length === 0 && mentions.length === 0 && images.length === 0;

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
    const imgs = images.length > 0 ? images : undefined;
    if (!t && all.length === 0 && images.length === 0) return;
    onSend(t, all, imgs);
    onChange("");
    onAttachmentsChange([]);
    onMentionsChange([]);
    onImagesChange([]);
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

  // 把若干 File(粘贴/选择)转成 ImageAttachment 并入 images。能力门控 + mime/大小校验。
  // imageSupported=false 时静默丢弃(入口本身已禁用,这里是兜底:防 paste 绕过)。
  const addImageFiles = async (files: File[]) => {
    if (!imageSupported || disabled) return;
    const accepted: ImageAttachment[] = [];
    for (const f of files) {
      if (!IMAGE_MIME_ALLOWED.includes(f.type)) continue;
      if (f.size > IMAGE_MAX_BYTES) continue;
      try {
        const data = await fileToBase64(f);
        const ext = (f.name.split(".").pop() || "png").toLowerCase();
        accepted.push({ name: f.name || `paste-${Date.now()}.${ext}`, data, mimeType: f.type });
      } catch { /* 单张失败跳过,不阻断其余 */ }
    }
    if (accepted.length) onImagesChange([...images, ...accepted]);
  };

  // 图片选择入口:原生文件对话框(过滤图片)。能力门控:imageSupported=false 时按钮不渲染。
  const addImages = async () => {
    if (!imageSupported) return;
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = IMAGE_MIME_ALLOWED.join(",");
      input.multiple = true;
      const chosen: File[] = await new Promise((resolve) => {
        input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
        input.click();
      });
      if (chosen.length) await addImageFiles(chosen);
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
        {(attachments.length > 0 || mentions.length > 0 || images.length > 0) && (
          <div className="att-chips" data-testid="att-chips">
            {attachments.map((p) => (
              <span key={p} className="att-chip" title={p}>
                <span className="att-chip-name"><Paperclip size={11} /> {baseName(p)}</span>
                <button className="att-chip-x" onClick={() => onAttachmentsChange(attachments.filter((x) => x !== p))}><X size={11} /></button>
              </span>
            ))}
            {mentions.map((m) => (
              <span key={m.path} className="att-chip att-chip-mention" title={"@" + m.path}>
                <span className="att-chip-name"><span className="att-chip-at">@</span>{m.name}</span>
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
            {images.map((im, i) => (
              <span key={im.name + i} className="att-chip att-chip-image" title={im.name}>
                <span className="att-chip-name">
                  <img className="att-chip-thumb" src={`data:${im.mimeType};base64,${im.data}`} alt={im.name} />
                  {im.name}
                </span>
                <button className="att-chip-x" onClick={() => onImagesChange(images.filter((_, j) => j !== i))}><X size={11} /></button>
              </span>
            ))}
          </div>
        )}

        {isLong && (
          <div className="composer-meta-row" data-testid="composer-meta-row">
            <span className="composer-meta-count">{value.split("\n").length} 行 · {value.length} 字符</span>
            <button
              className="composer-collapse-toggle"
              data-testid="composer-collapse-toggle"
              onClick={collapsed ? expandInput : collapseInput}
              onMouseDown={(e) => e.preventDefault()}
              title={collapsed ? "展开全文编辑" : "收起为预览"}
            >
              {collapsed ? <><ChevronDown size={12} /> 展开</> : <><ChevronUp size={12} /> 收起</>}
            </button>
          </div>
        )}

        {isLong && collapsed && preview ? (
          <div
            className="composer-collapse"
            data-testid="composer-collapse"
            onClick={expandInput}
            title="点击展开全文编辑"
          >
            <pre className="composer-collapse-pre">
              {preview.head.map((l, i) => <div key={i} className="composer-collapse-line">{l || " "}</div>)}
            </pre>
            <button
              className="composer-collapse-divider"
              onClick={(e) => { e.stopPropagation(); expandInput(); }}
              onMouseDown={(e) => e.preventDefault()}
            >
              ⋯ {preview.note}(点击展开) ⋯
            </button>
            {preview.tail.length > 0 && (
              <pre className="composer-collapse-pre">
                {preview.tail.map((l, i) => <div key={i} className="composer-collapse-line">{l || " "}</div>)}
              </pre>
            )}
          </div>
        ) : (
          <textarea
            ref={ref}
            className="composer-input"
            data-testid="composer-input"
            value={value}
            placeholder={prompting ? "排队下一条…(Enter 入队 · 本轮结束后自动发)" : "给 monkey-deck 发消息…   (Enter 发送 · Shift+Enter 换行 · @ 提文件 · / 看命令 · ↑↓ 翻历史)"}
            onChange={handleChange}
            onSelect={handleSelect}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              // 粘贴图片(剪贴板含图片):能力门控下转 ImageAttachment,并阻止图片被当文本插入。
              // 兼容两种入口:files(截图 / 从文件管理器拷贝)与 items(网页拷贝图片,部分 webview 仅经 items 暴露)。
              if (imageSupported) {
                const cd = e.clipboardData;
                const imgFiles: File[] = [];
                if (cd) {
                  for (const f of Array.from(cd.files || [])) if (IMAGE_MIME_ALLOWED.includes(f.type)) imgFiles.push(f);
                  for (const it of Array.from(cd.items || [])) {
                    if (it.kind === "file" && IMAGE_MIME_ALLOWED.includes(it.type)) {
                      const f = it.getAsFile();
                      if (f) imgFiles.push(f);
                    }
                  }
                }
                if (imgFiles.length > 0) {
                  e.preventDefault();
                  void addImageFiles(imgFiles);
                  return;
                }
              }
              // 粘贴长文本:折叠成预览(聚焦态下 effect 不会自动折,这里显式触发)。
              const pasted = e.clipboardData?.getData("text") ?? "";
              const el = e.currentTarget;
              const future = value.slice(0, el.selectionStart ?? 0) + pasted + value.slice(el.selectionEnd ?? 0);
              if (future.split("\n").length > LONG_LINE_THRESHOLD || future.length > LONG_CHAR_THRESHOLD) {
                requestAnimationFrame(() => setCollapsed(true));
              }
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            rows={2}
          />
        )}

        <div className="compose-bar">
          <div className="compose-tools">
            <button className="tool-btn" data-testid="attach-btn" onClick={addFiles} disabled={disabled} title="附加文件(经 ACP ResourceLink 发送)">
              <Paperclip size={17} />
            </button>
            {imageSupported && (
              <button
                className="tool-btn"
                data-testid="image-btn"
                onClick={addImages}
                disabled={disabled}
                title="添加图片(经 ACP Image 块发送 · 也可直接粘贴)"
              >
                <ImageIcon size={17} />
              </button>
            )}
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
            <ComposerUsage usage={usage} draftTokens={estimateTokens(value)} />
            {(attachments.length > 0 || mentions.length > 0 || images.length > 0) && (
              <span className="composer-count">{attachments.length + mentions.length + images.length} 引用</span>
            )}
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

// ComposerUsage:输入区附近的紧凑 token 用量(§1.6/§4.4)。
// 两段信息,都是「人话」,不抛原始 JSON/字段名:
//  - 草稿预估:当前输入框文本的近似 token 数(字符数/4 经验比值,非计费依据)。
//  - 上下文:session 已用 / 上限(数据源 ACP SessionUsageUpdate,见 usage-bar);无数据则不显示。
// 仅在有内容可报时渲染(全空则返回 null,不占位)。
function ComposerUsage({ usage, draftTokens }: {
  usage: { used: number; size: number; cost: number };
  draftTokens: number;
}) {
  const hasDraft = draftTokens > 0;
  const hasCtx = usage.used > 0 || usage.size > 0;
  if (!hasDraft && !hasCtx) return null;
  const pct = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  const level = pct >= 85 ? "crit" : pct >= 60 ? "high" : pct >= 30 ? "mid" : "low";
  return (
    <span className={`composer-usage composer-usage-${level}`} data-testid="composer-usage">
      {hasDraft && <span className="cu-draft" title="当前输入的近似 token 数(字符数/4 估算,非计费)">~{fmtTokens(draftTokens)}</span>}
      {hasDraft && hasCtx && <span className="cu-sep">·</span>}
      {hasCtx && (
        <span className="cu-ctx" title="本会话上下文已用 / 上限">
          {fmtTokens(usage.used)}{usage.size > 0 ? ` / ${fmtTokens(usage.size)}` : ""}{usage.size > 0 ? ` · ${pct}%` : ""}
        </span>
      )}
    </span>
  );
}

// ModelSelect 渲染 configOptions 里的 model/effort/mode 控件(发送按钮左侧)。
// 用 cmdk(Command) + @radix-ui/react-popover:Radix 管开合/定位/焦点/ARIA,cmdk 管搜索/分组/键盘导航。
// model 按 value 的 provider 前缀("provider/model")分组;大量选项时 cmdk 内置搜索 + List 滚动。
function ModelSelect({ configOptions, disabled, onSetConfig }: {
  configOptions: ConfigOption[];
  disabled: boolean;
  onSetConfig: (configId: string, value: string) => void;
}) {
  const modelOpt = configOptions.find((c) => c.category === "model");
  const effortOpt = configOptions.find((c) => c.category === "thought_level");
  const modeOpt = configOptions.find((c) => c.category === "mode");
  if (!modelOpt) return null;
  return (
    <div className="cfg-group">
      <ConfigSelect label="模型" currentValue={modelOpt.currentValue} options={modelOpt.options} disabled={disabled} onSelect={(v) => onSetConfig("model", v)} groupByProvider searchable />
      {modeOpt && <ConfigSelect label="模式" currentValue={modeOpt.currentValue} options={modeOpt.options} disabled={disabled} onSelect={(v) => onSetConfig("mode", v)} />}
      {effortOpt && <ConfigSelect label="思考" currentValue={effortOpt.currentValue} options={effortOpt.options} disabled={disabled} onSelect={(v) => onSetConfig("effort", v)} />}
    </div>
  );
}

// 单个配置选择器:Radix Popover 触发器(当前值 + chevron) + cmdk 可搜索列表。
// Radix 负责 open/close、点外部关闭、Esc、焦点陷阱、Portal 定位;cmdk 负责搜索/分组/↑↓键盘导航/选中。
interface ConfigSelectProps {
  label: string;
  currentValue: string;
  options: { value: string; name: string }[];
  disabled: boolean;
  onSelect: (value: string) => void;
  groupByProvider?: boolean;
  searchable?: boolean;
}

function ConfigSelect({ label, currentValue, options, disabled, onSelect, groupByProvider, searchable }: ConfigSelectProps) {
  const [open, setOpen] = useState(false);
  const currentName = options.find((o) => o.value === currentValue)?.name ?? currentValue ?? label;

  // 最近使用(model 专用):localStorage 持久化,选中的模型前移去重,最多 5 个。
  // 只在 groupByProvider(model 下拉)时启用;mode/effort 选项少不需要。
  const recentKey = groupByProvider ? "md:recent-models" : null;
  const recentModels = useMemo(() => {
    if (!recentKey) return [];
    try {
      const raw = localStorage.getItem(recentKey);
      const all = raw ? JSON.parse(raw) as string[] : [];
      const valid = new Set(options.map((o) => o.value));
      return all.filter((v) => valid.has(v) && v !== currentValue).slice(0, 5);
    } catch { return []; }
  }, [recentKey, options, currentValue]);
  const recentOpts = useMemo(
    () => recentModels.map((v) => options.find((o) => o.value === v)!).filter(Boolean),
    [recentModels, options]
  );

  const handleSelect = (v: string) => {
    if (recentKey) {
      try {
        const raw = localStorage.getItem(recentKey);
        const all = raw ? JSON.parse(raw) as string[] : [];
        const next = [v, ...all.filter((x) => x !== v)].slice(0, 5);
        localStorage.setItem(recentKey, JSON.stringify(next));
      } catch { /* noop */ }
    }
    onSelect(v);
    setOpen(false);
  };

  // provider 分组:value 形如 "zai/glm-4.6",按 "/" 前缀聚合。
  const groups = useMemo(() => {
    if (!groupByProvider) return null;
    const g: Record<string, { value: string; name: string }[]> = {};
    for (const o of options) {
      const prov = o.value.split("/")[0] || "other";
      (g[prov] ??= []).push(o);
    }
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [options, groupByProvider]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={`cfg-trigger ${open ? "open" : ""}`} disabled={disabled} title={`${label}: ${currentName}`} data-testid={`cfg-trigger-${label}`}>
          <span className="cfg-trigger-text">{currentName}</span>
          <ChevronDown size={11} className="cfg-chevron" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} className="cfg-popover-content" data-testid={`cfg-popover-${label}`}>
          <Command className="cfg-command" label={label}>
            {searchable && (
              <div className="cfg-search-row">
                <Command.Input placeholder="搜索…" className="cfg-search-input" />
              </div>
            )}
            <Command.List className="cfg-list">
              <Command.Empty className="cfg-empty">无匹配</Command.Empty>
              {recentOpts.length > 0 && (
                <Command.Group key="recent" heading="最近使用" className="cfg-group-block">
                  {recentOpts.map((o) => (
                    <Command.Item
                      key={o.value}
                      value={`${o.name} ${o.value}`}
                      onSelect={() => handleSelect(o.value)}
                      className={`cfg-option ${o.value === currentValue ? "active" : ""}`}
                      data-testid={`cfg-option-${o.value}`}
                    >
                      <span className="cfg-option-name">{o.name}</span>
                      {o.value !== o.name && <span className="cfg-option-value">{o.value}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {groups ? (
                groups.map(([prov, opts]) => (
                  <Command.Group key={prov} heading={prov} className="cfg-group-block">
                    {opts.map((o) => (
                      <Command.Item
                        key={o.value}
                        value={`${o.name} ${o.value}`}
                        onSelect={() => handleSelect(o.value)}
                        className={`cfg-option ${o.value === currentValue ? "active" : ""}`}
                        data-testid={`cfg-option-${o.value}`}
                      >
                        <span className="cfg-option-name">{o.name}</span>
                        {o.value !== o.name && <span className="cfg-option-value">{o.value}</span>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))
              ) : (
                options.map((o) => (
                  <Command.Item
                    key={o.value}
                    value={`${o.name} ${o.value}`}
                    onSelect={() => handleSelect(o.value)}
                    className={`cfg-option ${o.value === currentValue ? "active" : ""}`}
                    data-testid={`cfg-option-${o.value}`}
                  >
                    <span className="cfg-option-name">{o.name}</span>
                    {o.value !== o.name && <span className="cfg-option-value">{o.value}</span>}
                  </Command.Item>
                ))
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
