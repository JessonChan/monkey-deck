import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import type { ConfigOption, Mention, ImageAttachment, Usage } from "../types";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";
import { lookupModelPricing, estimateSwitchCost } from "../lib/modelPricing";
import { Paperclip, X, Slash, Square, ArrowUp, File, Folder, ChevronDown, ChevronUp, ImageIcon, ListPlus } from "lucide-react";

interface Props {
  value: string;            // 受控文本(由 App 持有,支持「撤回编辑」回填)
  onChange: (v: string) => void;
  disabled: boolean;        // 无 session 时禁用全部交互
  prompting: boolean;       // 一轮进行中:显示停止键 + send 提示将排队
  configOptions: ConfigOption[];        // agent 自报的 model/mode/effort(渲染下拉)
  onSetConfig: (configId: string, value: string) => void;  // 切换 config option(热切)
  onRefreshConfig: () => void;  // 打开 model 下拉时防抖重拉 configOptions(同步外部配置改动)
  history: string[];        // 输入框历史(上下键翻):该 session 全部发过的消息,无长度限制
  sessionId: string;        // @autocomplete 浏览此 session 的 cwd
  attachments: string[];      // 回形针附件(绝对路径)— 按 session 隔离(App 持有)
  onAttachmentsChange: (next: string[]) => void;
  mentions: Mention[];        // @autocomplete 选中项 — 按 session 隔离(App 持有)
  onMentionsChange: (next: Mention[]) => void;
  images: ImageAttachment[];  // 内联图片附件 — 按 session 隔离(App 持有)
  onImagesChange: (next: ImageAttachment[]) => void;
  imageSupported: boolean;    // agent 是否声明 image prompt 能力(门控图片输入入口)
  usage: Usage;  // 上下文用量(展示已用/上限 + 明细)
  onSend: (text: string, mentions: Mention[], images?: ImageAttachment[]) => void;
  onEnqueue: (text: string, mentions: Mention[], images?: ImageAttachment[]) => void;  // 主动入队列(并列发送):无论 idle/prompting 都入队
  onStop: () => void;
  onAction: (action: "clear" | "new" | "stop") => void;
}

// 斜杠命令(wesight 风格)。insert=插入模板;action=执行动作。
// desc/insert 经 i18n key 在渲染/插入时翻译(支持语言切换)。
interface SlashCommand { cmd: string; descKey: string; insertKey?: string; action?: "clear" | "new" | "stop"; }
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "/explain", descKey: "composer.slash.explainDesc", insertKey: "composer.slash.explainInsert" },
  { cmd: "/review", descKey: "composer.slash.reviewDesc", insertKey: "composer.slash.reviewInsert" },
  { cmd: "/tests", descKey: "composer.slash.testsDesc", insertKey: "composer.slash.testsInsert" },
  { cmd: "/refactor", descKey: "composer.slash.refactorDesc", insertKey: "composer.slash.refactorInsert" },
  { cmd: "/fix", descKey: "composer.slash.fixDesc", insertKey: "composer.slash.fixInsert" },
  { cmd: "/doc", descKey: "composer.slash.docDesc", insertKey: "composer.slash.docInsert" },
  { cmd: "/summary", descKey: "composer.slash.summaryDesc", insertKey: "composer.slash.summaryInsert" },
  { cmd: "/new", descKey: "composer.slash.newDesc", action: "new" },
  { cmd: "/clear", descKey: "composer.slash.clearDesc", action: "clear" },
  { cmd: "/stop", descKey: "composer.slash.stopDesc", action: "stop" },
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

export default function Composer({ value, onChange, disabled, prompting, configOptions, onSetConfig, onRefreshConfig, history, sessionId, attachments, onAttachmentsChange, mentions, onMentionsChange, images, onImagesChange, imageSupported, usage, onSend, onEnqueue, onStop, onAction }: Props) {
  const { t } = useTranslation();
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
        note: t("composer.linesFolded", { count: all.length - COLLAPSE_HEAD_LINES - COLLAPSE_TAIL_LINES }),
      };
    }
    return { head: all, tail: [], note: t("composer.longLineTruncated", { count: value.length }) };
  }, [isLong, value, t]);
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
  // navRef:事件处理中同步读写的权威值;navDisplay:镜像到 state 仅用于驱动徽标渲染
  // (ref 变化不触发重渲染,徽标要随翻阅即时更新,必须有 state)。
  const navRef = useRef(-1);
  const [navDisplay, setNavDisplay] = useState(-1);
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

  // mode: "send" = 默认发送(idle 直发 / prompting 入队由 App 决定);
  //       "enqueue" = 主动入队列(始终压入前端队列,与发送按钮并列的显式入口)。
  const submit = (finalText?: string, mode: "send" | "enqueue" = "send") => {
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
    (mode === "enqueue" ? onEnqueue : onSend)(t, all, imgs);
    onChange("");
    onAttachmentsChange([]);
    onMentionsChange([]);
    onImagesChange([]);
    navRef.current = -1;
    setNavDisplay(-1);
    setMentionOpen(false);
    setSlashOpen(false);
    requestAnimationFrame(() => { if (ref.current) ref.current.style.height = "auto"; });
  };
  const pickSlash = (c: SlashCommand) => {
    if (c.action) onAction(c.action);
    else if (c.insertKey) onChange(t(c.insertKey));
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
    // ⌘⇧↩ / Ctrl+Shift+Enter:主动入队列(与发送并列的显式入口,无论 idle/prompting 都入队)。
    if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(undefined, "enqueue"); }
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
      if (next >= history.length) { navRef.current = -1; setNavDisplay(-1); onChange(draftRef.current); moveCursorEnd(); return; }
      if (next < 0) { navRef.current = 0; }
      else { navRef.current = next; }
    }
    setNavDisplay(navRef.current);
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
    setNavDisplay(-1);
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
              <span className="slash-desc">{t(c.descKey)}</span>
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
            return dir ? <div className="mention-cwd">📁 {dir}/ <span className="mention-hint">{t("composer.mentionBack")}</span></div> : null;
          })()}
          {mentionItems.map((n, i) => (
            <button key={n.path} className={`slash-item ${i === mentionIdx ? "active" : ""}`} onMouseEnter={() => setMentionIdx(i)} onClick={() => (n.isDir ? descendMention(n) : pickMention(n))}>
              {n.isDir ? <Folder size={13} /> : <File size={13} />}
              <span className="slash-cmd">{n.name}</span>
              <span className="slash-desc">{n.isDir ? t("composer.mentionEnter") : ""}</span>
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
            <span className="composer-meta-count">{t("composer.lineCharCount", { lines: value.split("\n").length, chars: value.length })}</span>
            <button
              className="composer-collapse-toggle"
              data-testid="composer-collapse-toggle"
              onClick={collapsed ? expandInput : collapseInput}
              onMouseDown={(e) => e.preventDefault()}
              title={collapsed ? t("composer.expandFull") : t("composer.collapseToPreview")}
            >
              {collapsed ? <><ChevronDown size={12} /> {t("common.expand")}</> : <><ChevronUp size={12} /> {t("common.collapse")}</>}
            </button>
          </div>
        )}

        {isLong && collapsed && preview ? (
          <div
            className="composer-collapse"
            data-testid="composer-collapse"
            onClick={expandInput}
            title={t("composer.collapsePreviewHint")}
          >
            <pre className="composer-collapse-pre">
              {preview.head.map((l, i) => <div key={i} className="composer-collapse-line">{l || " "}</div>)}
            </pre>
            <button
              className="composer-collapse-divider"
              onClick={(e) => { e.stopPropagation(); expandInput(); }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {t("composer.collapsePreviewDivider", { note: preview.note })}
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
            placeholder={prompting ? t("composer.placeholderQueued") : t("composer.placeholderNormal")}
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
              // 粘贴使文本从「非长」跨入「长」→ 折叠成预览(聚焦态下 auto-collapse effect 不会折,这里显式补)。
              // 仅当粘贴前不是长文本(!isLong)才折:粘贴前已是长文本(用户多半已手动展开在编辑)时,粘贴不应把
              // textarea 折没 —— 否则键入丢失,即「复制后无法输入」。与 effect 的聚焦守卫一致:聚焦编辑中不打断。
              const pasted = e.clipboardData?.getData("text") ?? "";
              const el = e.currentTarget;
              const future = value.slice(0, el.selectionStart ?? 0) + pasted + value.slice(el.selectionEnd ?? 0);
              if (!isLong && (future.split("\n").length > LONG_LINE_THRESHOLD || future.length > LONG_CHAR_THRESHOLD)) {
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
            <button className="tool-btn" data-testid="attach-btn" onClick={addFiles} disabled={disabled} title={t("composer.attachFilesTip")}>
              <Paperclip size={17} />
            </button>
            {imageSupported && (
              <button
                className="tool-btn"
                data-testid="image-btn"
                onClick={addImages}
                disabled={disabled}
                title={t("composer.addImageTip")}
              >
                <ImageIcon size={17} />
              </button>
            )}
            <button
              className="tool-btn"
              onClick={() => { onChange(value.startsWith("/") ? value : "/" + value); requestAnimationFrame(() => ref.current?.focus()); }}
              disabled={disabled}
              title={t("composer.slashMenuTip")}
            >
              <Slash size={17} />
            </button>
            {/* ↑↓ 翻历史:placeholder 瘦身后,把这条最隐晦(无可视入口)的快捷键提为 compose-tools chip。
                未翻历史 → 可点 chip(点击等价 ↑,进入翻历史);翻历史中 → 徽标显示当前位置(1-indexed,旧→新)。 */}
            {history.length > 0 && (
              navDisplay >= 0 ? (
                <span
                  className="compose-history-badge"
                  data-testid="composer-history-badge"
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("composer.historyBadgeTip")}
                  data-tooltip-place="top"
                >
                  {t("composer.historyBadge", { idx: navDisplay + 1, total: history.length })}
                </span>
              ) : (
                <button
                  className="compose-history-chip"
                  data-testid="composer-history-chip"
                  onClick={() => { navigateHistory(-1); requestAnimationFrame(() => ref.current?.focus()); }}
                  disabled={disabled}
                  data-tooltip-id="md-tip"
                  data-tooltip-content={t("composer.historyHintTip")}
                  data-tooltip-place="top"
                >
                  {t("composer.historyHint")}
                </button>
              )
            )}
          </div>
          <div className="compose-right">
            <ModelSelect configOptions={configOptions} disabled={disabled} onSetConfig={onSetConfig} onRefreshConfig={onRefreshConfig} contextTokens={usage.used} />
            <ComposerUsage usage={usage} draftTokens={estimateTokens(value)} />
            {(attachments.length > 0 || mentions.length > 0 || images.length > 0) && (
              <span className="composer-count">{t("composer.referencesCount", { count: attachments.length + mentions.length + images.length })}</span>
            )}
            {prompting && (
              <button className="send-btn stop" data-testid="stop-btn" onClick={onStop} title={t("composer.stopTip")}>
                <Square size={15} />
              </button>
            )}
            <button
              className="send-btn enqueue"
              data-testid="enqueue-btn"
              onClick={() => submit(undefined, "enqueue")}
              disabled={disabled || empty}
              title={t("composer.enqueueTip")}
            >
              <ListPlus size={16} />
            </button>
            <button
              className="send-btn"
              data-testid="send-btn"
              onClick={() => submit()}
              disabled={disabled || empty}
              title={prompting ? t("composer.queueSendTip") : t("composer.sendTip")}
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ComposerUsage:输入区附近的紧凑用量展示(§1.6/§4.4)。合并了原顶部 usage-bar 的全部信息:
//  - 草稿预估:当前输入框文本的近似 token 数(字符数/4 经验比值,非计费依据)。
//  - 上下文:session 已用 / 上限 + 占比%(数据源 ACP SessionUsageUpdate + PromptResponse.Usage)。
//  - 费用:累计 $cost(harness 自报)。
// 配色按 usageLevel 分级(绿 → 琥珀 → 红),hover tooltip 展示 token 明细(输入/输出/缓存/思考/合计)。
// §4.5:统一用 react-tooltip(md-tip),禁用原生 title。
// 仅在有内容可报时渲染(全空则返回 null,不占位)。
function ComposerUsage({ usage, draftTokens }: {
  usage: Usage;
  draftTokens: number;
}) {
  const { t } = useTranslation();
  const hasDraft = draftTokens > 0;
  const hasCtx = usage.used > 0 || usage.size > 0;
  const hasCost = usage.cost > 0;
  if (!hasDraft && !hasCtx && !hasCost) return null;
  const pct = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  // 分级配色:上下文越满越警示(绿 → 琥珀 → 红),让占比一眼可读。
  const level = pct >= 85 ? "crit" : pct >= 60 ? "high" : pct >= 30 ? "mid" : "low";
  // token 明细 tooltip(§4.5 react-tooltip):仅在有明细时附加,用 \n 多行(pre-line 渲染)。
  const hasBreakdown = usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0
    || usage.cachedReadTokens > 0 || usage.cachedWriteTokens > 0 || usage.thoughtTokens > 0;
  const usageTip = hasBreakdown
    ? [
        t("chat.usageTitle"),
        `${t("chat.usageInput")}: ${fmtTokens(usage.inputTokens)}`,
        `${t("chat.usageOutput")}: ${fmtTokens(usage.outputTokens)}`,
        usage.cachedReadTokens > 0 ? `${t("chat.usageCachedRead")}: ${fmtTokens(usage.cachedReadTokens)}` : "",
        usage.cachedWriteTokens > 0 ? `${t("chat.usageCachedWrite")}: ${fmtTokens(usage.cachedWriteTokens)}` : "",
        usage.thoughtTokens > 0 ? `${t("chat.usageThought")}: ${fmtTokens(usage.thoughtTokens)}` : "",
        `${t("chat.usageTotal")}: ${fmtTokens(usage.totalTokens)}`,
      ].filter(Boolean).join("\n")
    : t("chat.usageTitle");
  return (
    <span
      className={`composer-usage composer-usage-${level}`}
      data-testid="composer-usage"
      data-tooltip-id="md-tip"
      data-tooltip-content={usageTip}
      data-tooltip-place="top"
    >
      {hasDraft && <span className="cu-draft">~{fmtTokens(draftTokens)}</span>}
      {hasDraft && (hasCtx || hasCost) && <span className="cu-sep">·</span>}
      {hasCtx && (
        <span className="cu-ctx">
          {fmtTokens(usage.used)}{usage.size > 0 ? ` / ${fmtTokens(usage.size)}` : ""}{usage.size > 0 ? ` · ${pct}%` : ""}
        </span>
      )}
      {hasCost && <span className="cu-cost">${usage.cost.toFixed(4)}</span>}
    </span>
  );
}

// ModelSelect 渲染 configOptions 里的 model/effort/mode 控件(发送按钮左侧)。
// 用 cmdk(Command) + @radix-ui/react-popover:Radix 管开合/定位/焦点/ARIA,cmdk 管搜索/分组/键盘导航。
// model 按 value 的 provider 前缀("provider/model")分组;大量选项时 cmdk 内置搜索 + List 滚动。
export function ModelSelect({ configOptions, disabled, onSetConfig, onRefreshConfig, contextTokens }: {
  configOptions: ConfigOption[];
  disabled: boolean;
  onSetConfig: (configId: string, value: string) => void;
  onRefreshConfig: () => void;
  contextTokens: number;
}) {
  const { t } = useTranslation();
  const modelOpt = configOptions.find((c) => c.category === "model");
  const effortOpt = configOptions.find((c) => c.category === "thought_level");
  const modeOpt = configOptions.find((c) => c.category === "mode");
  if (!modelOpt) return null;
  return (
    <div className="cfg-group">
      <ConfigSelect label={t("composer.cfgLabel.model")} currentValue={modelOpt.currentValue} options={modelOpt.options} disabled={disabled} onSelect={(v) => onSetConfig(modelOpt.id, v)} groupByProvider searchable contextTokens={contextTokens} onRefreshConfig={onRefreshConfig} />
      {modeOpt && <ConfigSelect label={t("composer.cfgLabel.mode")} currentValue={modeOpt.currentValue} options={modeOpt.options} disabled={disabled} onSelect={(v) => onSetConfig(modeOpt.id, v)} />}
      {effortOpt && <ConfigSelect label={t("composer.cfgLabel.thought")} currentValue={effortOpt.currentValue} options={effortOpt.options} disabled={disabled} onSelect={(v) => onSetConfig(effortOpt.id, v)} />}
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
  contextTokens?: number; // model 专用:切换成本提示用的当前上下文 token 量(Task #15138)
  onRefreshConfig?: () => void; // model 专用:打开下拉时防抖重拉 configOptions
}

function ConfigSelect({ label, currentValue, options, disabled, onSelect, groupByProvider, searchable, contextTokens, onRefreshConfig }: ConfigSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // model 下拉打开时防抖重拉最新 configOptions(同步外部 provider/model 改动);mode/effort 不传 → 不触发。
  useEffect(() => {
    if (open && onRefreshConfig) onRefreshConfig();
  }, [open, onRefreshConfig]);
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

  // 模型切换成本提示(Task #15138):contextTokens>0 时在 popover 顶部展示当前上下文量级;
  // 有定价的模型在每个选项右侧附预估单轮成本(无定价则只展示量级,§4.4 人话不抛原始字段)。
  const showCtxHint = !!groupByProvider && (contextTokens ?? 0) > 0;
  const fmtCost = (v: string): string | null => {
    const cost = estimateSwitchCost(contextTokens ?? 0, lookupModelPricing(v));
    if (cost === null) return null;
    return cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`;
  };

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
            {showCtxHint && (
              <div className="cfg-ctx-hint" data-testid="cfg-ctx-hint">
                {t("composer.switchCostHint", { tokens: fmtTokens(contextTokens ?? 0) })}
              </div>
            )}
            {searchable && (
              <div className="cfg-search-row">
                <Command.Input placeholder={t("composer.searchPlaceholder")} className="cfg-search-input" />
              </div>
            )}
            <Command.List className="cfg-list">
              <Command.Empty className="cfg-empty">{t("composer.noMatch")}</Command.Empty>
              {recentOpts.length > 0 && (
                <Command.Group key="recent" heading={t("composer.recentUsed")} className="cfg-group-block">
                  {recentOpts.map((o) => (
                    <Command.Item
                      key={o.value}
                      value={`${o.name} ${o.value}`}
                      onSelect={() => handleSelect(o.value)}
                      className={`cfg-option ${o.value === currentValue ? "active" : ""}`}
                      data-testid={`cfg-option-${o.value}`}
                    >
                      <span className="cfg-option-name">{o.name}</span>
                      {fmtCost(o.value) && <span className="cfg-option-cost" data-testid={`cfg-cost-${o.value}`}>~{fmtCost(o.value)}</span>}
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
                        {fmtCost(o.value) && <span className="cfg-option-cost" data-testid={`cfg-cost-${o.value}`}>~{fmtCost(o.value)}</span>}
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
                    {fmtCost(o.value) && <span className="cfg-option-cost" data-testid={`cfg-cost-${o.value}`}>~{fmtCost(o.value)}</span>}
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
