import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import type { ConfigOption, Mention, ImageAttachment, AudioAttachment, Usage, SlashCommand, ElicitationPrompt } from "../types";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import type { FileNode } from "../../bindings/github.com/jessonchan/monkey-deck/internal/fsview/models";
import { lookupModelPricing, estimateSwitchCost } from "../lib/modelPricing";
import { Paperclip, X, Slash, Square, ArrowUp, File, Folder, ChevronDown, ChevronUp, ChevronRight, ImageIcon, Mic, AudioLines, ListPlus, GitBranch, CornerUpLeft, ListChecks, ClipboardPaste, Loader2 } from "lucide-react";
import McpChip from "./McpChip";
import { isRemoteClient } from "../lib/remote";
import { startDictation, transcribeAudio, SttError, type DictationHandle, type SttErrorKind } from "../lib/sttClient";

interface Props {
  value: string;            // 受控文本(由 App 持有,支持「撤回编辑」回填)
  onChange: (v: string) => void;
  disabled: boolean;        // 无 session 时禁用全部交互
  prompting: boolean;       // a turn is in progress: stop slot becomes visible + send turns amber (queue-send)
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
  audios: AudioAttachment[];  // 内联音频附件 — 按 session 隔离(App 持有)
  onAudiosChange: (next: AudioAttachment[]) => void;
  audioSupported: boolean;    // agent 是否声明 audio prompt 能力(门控音频输入入口)
  usage: Usage;  // 上下文用量(展示已用/上限 + 明细)
  branch: string;  // 当前 session 工作目录所在的 git 分支(空 = 非 git / 未取到 → 不显示)
  // Branch chip click → open the new-session modal prefilled to fork off this branch.
  onNewSessionOnBranch: (branch: string) => void;
  onSend: (text: string, mentions: Mention[], images?: ImageAttachment[], audios?: AudioAttachment[]) => void;
  onEnqueue: (text: string, mentions: Mention[], images?: ImageAttachment[], audios?: AudioAttachment[]) => void;  // 主动入队列(并列发送):无论 idle/prompting 都入队
  onStop: () => void;
  commands: SlashCommand[];      // harness 自报斜杠命令(动态,available_commands_update;每 harness 不同)
  // Elicitation (ACP v1 standard protocol): harness requests structured user input
  // (omp /review mode select, /fast confirm). Rendered inline at the top of the
  // compose-card (inside the input box, above attachments) — agent is waiting on the
  // user, so it stays pinned to the input they act on, not buried in the scroll stream.
  elicitation: ElicitationPrompt | null;
  onRespondElicitation: (action: "accept" | "decline" | "cancel", content: Record<string, unknown>) => void;
  // Bump this number to imperatively focus the composer and place the caret at
  // the end (used by "quote to composer" so the user lands ready to type after
  // the quoted block). 0 = no-op on mount; only changes drive the effect.
  focusSignal?: number;
}

// 长文本折叠阈值:超过则折叠成 TUI 风格紧凑块(首尾若干行 + 中间省略),避免撑爆输入区。
// 折叠仅为展示态,提交内容仍是完整 value(见 submit)。
const LONG_LINE_THRESHOLD = 8;     // 行数阈值
const LONG_CHAR_THRESHOLD = 480;   // 字符数阈值(单/双行长文本兜底)
const COLLAPSE_HEAD_LINES = 4;     // 折叠时展示前 N 行
const COLLAPSE_TAIL_LINES = 2;     // 折叠时展示后 M 行

// Large paste fold threshold: a paste whose line count exceeds this is captured
// out-of-band as a "paste snippet" chip (reusing the att-chip / fold visual)
// instead of filling up the textarea. The full text is restored into the outgoing
// message on submit (see submit). Keeps the composer editable for big log/error dumps.
const PASTE_FOLD_THRESHOLD = 20;

// A paste captured as a chip rather than inlined into the textarea. text holds the
// full original paste so submit can restore it verbatim; lines/chars drive the chip label.
interface PasteSnippet {
  id: string;
  text: string;
  lines: number;
  chars: number;
}

// 从光标位置向前找当前 token:若以 @ 开头,返回 @ 的起点 + @ 之后的查询文本。
function detectMention(text: string, pos: number): { start: number; query: string } | null {
  let i = pos - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const wordStart = i + 1;
  if (text[wordStart] !== "@") return null;
  return { start: wordStart, query: text.slice(wordStart + 1, pos) };
}

// 把 @ token 的 query 拆成 (scope, term):最后一个 / 之前是 scope(限定搜索子树),
// 之后是 term(模糊词)。空 term → 后端返 scope 直接子项(含目录,目录优先)。
//   "foo"      → scope="",   term="foo"   (全项目模糊)
//   "src/foo"  → scope="src", term="foo"  (src 子树内模糊)
//   "src/"     → scope="src", term=""     (列 src 直接子项,drill-down 态)
//   "src/sub/" → scope="src/sub", term="" (drill 两级)
// 文本是唯一事实源:scope 从 @ token 推导,不另存 state(§5.3 找不变量)。
function splitScopeTerm(q: string): { scope: string; term: string } {
  const i = q.lastIndexOf("/");
  if (i < 0) return { scope: "", term: q };
  return { scope: q.slice(0, i), term: q.slice(i + 1) };
}

// Detect a path-like token immediately before the cursor for Tab completion.
// The token is the maximal run of non-whitespace chars ending at `pos`. It is
// treated as a path candidate only when it is non-empty, does NOT start with
// '@' (mention territory) or '/' (slash command / absolute path), and looks
// path-like (contains '/' or '.') — plain prose words are left alone so Tab on
// "fix this" doesn't spuriously complete "this". This is plain-text inline
// completion (no @ reference chip): a single unambiguous SessionFuzzyFind match
// replaces the token in place.
function detectPathToken(text: string, pos: number): { start: number; token: string } | null {
  let i = pos - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const start = i + 1;
  const token = text.slice(start, pos);
  if (!token) return null;
  if (token[0] === "@" || token[0] === "/") return null;
  if (!token.includes("/") && !token.includes(".")) return null;
  return { start, token };
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

// 接受的音频 mime 白名单(ACP ContentBlock::Audio 常见类型,对齐后端 attachmentBlock audio 兜底)。
const AUDIO_MIME_ALLOWED = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/webm", "audio/ogg", "audio/x-m4a", "audio/m4a"];
// 单音频大小上限(base64 前,字节):25MB。音频比图片体积更大,但仍需控量以不爆上下文。
const AUDIO_MAX_BYTES = 25 * 1024 * 1024;

// Mobile virtual-keyboard attrs (M2 PWA): autocorrect/autocapitalize mangle
// commands and code in prompts, spellcheck squiggles them, and enterKeyHint
// labels the composer's Enter (= send, see onKeyDown). Gated to coarse-pointer
// clients at module load — desktop typing behavior (incl. spellcheck) is
// unchanged (M2 hard rule: >768px zero modification). Same pattern as App's
// module-level `coarsePointer` (a desktop window never becomes touch mid-session).
const coarsePointer = typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(pointer: coarse)").matches;
const MOBILE_INPUT_ATTRS = coarsePointer
  ? { autoCapitalize: "off", autoCorrect: "off", spellCheck: false, enterKeyHint: "send" } as const
  : {};

export default function Composer({ value, onChange, disabled, prompting, configOptions, commands, elicitation, onRespondElicitation, onSetConfig, onRefreshConfig, history, sessionId, attachments, onAttachmentsChange, mentions, onMentionsChange, images, onImagesChange, imageSupported, audios, onAudiosChange, audioSupported, usage, branch, onNewSessionOnBranch, onSend, onEnqueue, onStop, focusSignal = 0 }: Props) {
  const { t } = useTranslation();
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  // 未知命令拦截:发送/入队时若 /<cmd> 不在 harness 自报命令表里,阻止发送并提示。
  // mode 记录用户触发方式(send/enqueue),「作为普通文本发送」按同模式转义重发(前导空格绕过命令解析)。
  const [slashWarn, setSlashWarn] = useState<{ cmd: string; mode: "send" | "enqueue" } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef(0);                                       // 光标位置(命令式读写,供 @ 插入定位)
  const [cursorPos, setCursorPos] = useState(0);                     // 光标位置(仅作 mention useMemo 的重算触发器;cursorRef 才是权威值)
  // IME 合成追踪:compositionStart/End 手动记录,配合 isComposing + keyCode===229 三重保险,
  // 彻底防中文输入法选词确认的 Enter 被误判为发送(部分 macOS IME 下 isComposing 不可靠)。
  const composingRef = useRef(false);
  // Tab path completion race guard: monotonic id; each Tab press bumps it and
  // only the latest resolution may apply (§5.3 invariant over identity, not order).
  const completeReqId = useRef(0);
  // Mirror of the controlled value for async insert paths (dictation transcript):
  // the toggleVoice closure captured at click time goes stale while the user
  // keeps typing during transcription — the insert must splice into the CURRENT
  // draft, not the snapshot from when stop was clicked (otherwise mid-flight
  // typing is silently clobbered). Only read from event/async continuations,
  // never during render.
  const valueRef = useRef(value);
  valueRef.current = value;

  // --- Voice dictation (#131 stage 2) ---
  // voiceState: idle → recording (mic live) → transcribing (blob in flight).
  // dictationRef holds the open mic session. voicePhaseRef is the synchronous
  // re-entry invariant ("busy" spans every async transition): state closures
  // go stale mid-transition, so rapid double-clicks must be guarded by a ref,
  // not by reading voiceState (§5.3 invariant over shape assumptions). Errors
  // are classified SttErrorKinds rendered as a localized inline row (§4.4).
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceError, setVoiceError] = useState<SttErrorKind | null>(null);
  const dictationRef = useRef<DictationHandle | null>(null);
  const voicePhaseRef = useRef<"idle" | "busy" | "recording">("idle");
  // Release the mic when the composer unmounts (session closed / app quit) —
  // a live track keeps the OS mic indicator on.
  useEffect(() => () => { dictationRef.current?.cancel(); dictationRef.current = null; }, []);

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

  // --- Large paste folded into a chip (PASTE_FOLD_THRESHOLD) ---
  // pasteSnippets: pastes exceeding the threshold line count are captured as chips
  // (reusing the att-chip / fold visual) instead of flooding the textarea. On submit each
  // snippet's full original text is stitched back into the message (submit); the textarea
  // only keeps the user's hand-typed context.
  // expandedSnippet: the id of the snippet whose preview is open (null = all folded); one at a time.
  const snippetIdRef = useRef(0);
  const [pasteSnippets, setPasteSnippets] = useState<PasteSnippet[]>([]);
  const [expandedSnippet, setExpandedSnippet] = useState<string | null>(null);
  // snippetFullyExpanded: within an open preview, whether the folded middle lines have been
  // revealed (divider click). false = head/tail + fold note; true = all lines shown.
  const [snippetFullyExpanded, setSnippetFullyExpanded] = useState(false);
  // Composer does not remount on session switch (no per-session key), so local state would
  // leak across sessions — clear pasteSnippets / expanded state on session change to match
  // the per-session isolation of attachments and friends.
  useEffect(() => { setPasteSnippets([]); setExpandedSnippet(null); setSnippetFullyExpanded(false); snippetIdRef.current = 0; }, [sessionId]);
  const addPasteSnippet = (text: string) => {
    const lines = text.split("\n").length;
    setPasteSnippets((prev) => [...prev, { id: `ps-${++snippetIdRef.current}`, text, lines, chars: text.length }]);
  };
  const removePasteSnippet = (id: string) => {
    setPasteSnippets((prev) => prev.filter((s) => s.id !== id));
    setExpandedSnippet((cur) => (cur === id ? null : cur));
  };
  // Folded preview block for the open snippet (reusing composer-collapse's head/tail + middle
  // ellipsis visual): computed only for the currently expanded snippet.
  const snippetPreview = useMemo(() => {
    if (!expandedSnippet) return null;
    const sn = pasteSnippets.find((s) => s.id === expandedSnippet);
    if (!sn) return null;
    const all = sn.text.split("\n");
    if (all.length > COLLAPSE_HEAD_LINES + COLLAPSE_TAIL_LINES) {
      return {
        all,
        head: all.slice(0, COLLAPSE_HEAD_LINES),
        tail: all.slice(all.length - COLLAPSE_TAIL_LINES),
        foldCount: all.length - COLLAPSE_HEAD_LINES - COLLAPSE_TAIL_LINES,
      };
    }
    return { all, head: all, tail: [], foldCount: 0 };
  }, [expandedSnippet, pasteSnippets]);

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
    () => (slashQuery == null ? [] : commands.filter((c) => c.name.startsWith(slashQuery))),
    [slashQuery, commands]
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

  // Imperative focus via focusSignal (quote-to-composer). Expand the long-text
  // preview first (the textarea isn't mounted while collapsed → ref is null),
  // then rAF into the next frame so a tab switch (editor → chat) that flips the
  // wrapper display:none→visible in the same render cycle has committed —
  // focusing a hidden textarea is a no-op.
  useEffect(() => {
    if (!focusSignal) return;
    setCollapsed(false);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
      cursorRef.current = el.value.length;
      autoGrow(el);
    });
  }, [focusSignal]);

  // @ 触发:据光标位置判定是否在 @ 提及中,调后端 SessionFuzzyFind 在 session 工作目录
  // 按 (scope, term) 检索:term 非空 → scope 子树内模糊匹配(文件 + 目录);term 空 →
  // 列 scope 的直接子项(目录优先,IDE quick-open 初始态)。scope 从 @ token 推导(splitScopeTerm)。
  const mentionInfo = useMemo(() => detectMention(value, cursorRef.current), [value, cursorPos]);
  const mentionScope = mentionInfo ? splitScopeTerm(mentionInfo.query).scope : "";
  useEffect(() => {
    if (!sessionId || slashOpen || !mentionInfo) { setMentionOpen(false); return; }
    const { scope, term } = splitScopeTerm(mentionInfo.query);
    let cancelled = false;
    // 防抖:快打字时不每次按键都打后端 IPC,150ms 内的新 keystroke 取消上一次查询。
    const timer = setTimeout(() => {
      ChatService.SessionFuzzyFind(sessionId, scope, term, 12).then((nodes) => {
        if (cancelled) return;
        const list = (nodes || []).slice(0, 12);
        setMentionItems(list);
        setMentionIdx(0);
        // 空 term 也开面板(列目录):让用户 @ 后即见根,可挑文件或往下钻。
        setMentionOpen(list.length > 0);
      }).catch(() => { if (!cancelled) setMentionOpen(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mentionInfo, sessionId, slashOpen]);

  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;
  const empty = !value.trim() && attachments.length === 0 && mentions.length === 0 && images.length === 0 && audios.length === 0 && pasteSnippets.length === 0;
  // mode: "send" = 默认发送(idle 直发 / prompting 入队由 App 决定);
  //       "enqueue" = 主动入队列(始终压入前端队列,与发送按钮并列的显式入口)。
  // forcePlain=true:已转义(前导空格),跳过未知命令校验、不 trim 前导空格 —— 供「作为普通文本发送」复用。
  const submit = (finalText?: string, mode: "send" | "enqueue" = "send", forcePlain = false) => {
    if (disabled) return;
    const raw = finalText ?? value;
    // Restore the full text: large pastes are chip-ified (kept out of the textarea), so on
    // submit each snippet's full original text is appended to the hand-typed text, separated
    // by blank lines — the agent receives the complete content (the composer just didn't bloat).
    const combined = pasteSnippets.length > 0
      ? [raw, ...pasteSnippets.map((s) => s.text)].filter((s) => s.trim() !== "").join("\n\n")
      : raw;
    const t = forcePlain ? combined : combined.trim();
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
    const aus = audios.length > 0 ? audios : undefined;
    if (!t && all.length === 0 && images.length === 0 && audios.length === 0) return;
    // 未知命令拦截(§slash-commands):消息以 "/" 开头时,首个 token 是命令名。若 harness 已自报命令表
    // (commands 非空)且该命令不在表里 → 阻止发送并提示(各 harness 对未知 /cmd 行为不一:opencode 报错/
    // 静默吞,omp 落到模型)。commands 为空(尚未收到 available_commands)时不拦,交给 harness。
    if (!forcePlain && t.startsWith("/")) {
      const cmdName = t.slice(1).split(/\s+/)[0];
      if (cmdName && commands.length > 0 && !commands.some((c) => c.name === cmdName)) {
        setSlashWarn({ cmd: cmdName, mode });
        return;
      }
    }
    setSlashWarn(null);
    (mode === "enqueue" ? onEnqueue : onSend)(t, all, imgs, aus);
    onChange("");
    onAttachmentsChange([]);
    onMentionsChange([]);
    onImagesChange([]);
    onAudiosChange([]);
    setPasteSnippets([]);
    setExpandedSnippet(null);
    setSnippetFullyExpanded(false);
    navRef.current = -1;
    setNavDisplay(-1);
    setMentionOpen(false);
    setSlashOpen(false);
    requestAnimationFrame(() => { if (ref.current) ref.current.style.height = "auto"; });
  };
  // 选中一个命令:把当前 "/query" 整体替换成 "/<name> "(尾随空格,便于紧接输入参数)。
  // 命令是真实的 harness 斜杠命令——提交时作为普通 prompt 文本原样发送(协议 §slash-commands,
  // agent 识别前缀执行),不在 client 侧执行任何动作。
  const pickSlash = (c: SlashCommand) => {
    const next = "/" + c.name + " ";
    cursorRef.current = next.length;
    onChange(next);
    setSlashOpen(false);
    setSlashWarn(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorRef.current; }
    });
  };

  // 「作为普通文本发送」:前导加空格转义(绕过 harness 的 "/" 命令解析,用户已实测对 opencode 有效),
  // 按用户原本触发的模式(send/enqueue)重发,跳过未知命令校验。
  const sendAsPlain = () => {
    if (!slashWarn) return;
    const mode = slashWarn.mode;
    submit(" " + value, mode, true);
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

  // 钻进一个目录候选:把 @query 替换成 @<dirpath>/(尾随 / 标记 drill 态,scope=dirpath),
  // 不记录提及、不关面板 —— useEffect 据新 query 重算 scope 并列该目录子项,继续挑或继续钻。
  // 文本是唯一事实源:drill 态完全由 @ token 的尾随 / 表达,刷新/恢复都能复现(§5.3)。
  const drillMention = (node: FileNode) => {
    const pos = cursorRef.current;
    const m = detectMention(value, pos);
    if (!m) return;
    const token = "@" + node.path + "/";
    cursorRef.current = m.start + token.length;
    onChange(value.slice(0, m.start) + token + value.slice(pos));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorRef.current; }
    });
  };

  // 返回上一级:剥掉当前 @ query 末尾一段路径(segment),回父目录的 drill 态;已在根则无操作。
  //   "src/sub/" → "src/"   "src/" → ""   "" → 无操作
  const goUpMention = () => {
    const pos = cursorRef.current;
    const m = detectMention(value, pos);
    if (!m || !m.query.includes("/")) return;
    const stripped = m.query.replace(/\/$/, "");
    const i = stripped.lastIndexOf("/");
    const parentQuery = i < 0 ? "" : stripped.slice(0, i + 1);
    const token = "@" + parentQuery;
    cursorRef.current = m.start + token.length;
    onChange(value.slice(0, m.start) + token + value.slice(pos));
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorRef.current; }
    });
  };

  // Mouse click on a list item: directory drills in, file is picked as a mention. (Keyboard
  // model differs: ← / → navigate dirs, Enter commits — see onKeyDown.)
  const activateMention = (node: FileNode) => {
    if (node.isDir) drillMention(node);
    else pickMention(node);
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
    // 未知命令提示:Esc 关闭(编辑也会清,这里兜底键盘流)
    if (slashWarn && e.key === "Escape") { e.preventDefault(); setSlashWarn(null); return; }
    // Dictation error row: Esc dismisses (same keyboard flow as slash-warn).
    if (voiceError && e.key === "Escape") { e.preventDefault(); setVoiceError(null); return; }
    // @ mention menu: ↑↓ move selection, ← go up one dir level (drill state only),
    // → drill into the highlighted directory, Enter/Tab commit the highlighted item as a
    // mention (files AND directories both reference — dir navigation is via ← / →).
    // Esc closes. Backspace at an empty term (cursor right after '/') also goes up a level.
    if (mentionOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => Math.min(i + 1, mentionItems.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => Math.max(i - 1, -1)); return; }
      // → : drill into the highlighted directory. Files / go-up row fall through (cursor stays).
      if (e.key === "ArrowRight") {
        const node = mentionItems[mentionIdx];
        if (node?.isDir) { e.preventDefault(); drillMention(node); return; }
      }
      // ← : go up one directory level; only in drill state (query has '/'), else let the cursor move left.
      if (e.key === "ArrowLeft") {
        const info = detectMention(value, cursorRef.current);
        if (info && info.query.includes("/")) { e.preventDefault(); goUpMention(); return; }
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        // mentionIdx=-1 (go-up row focused) → up one level; otherwise commit the highlighted
        // item as a mention (files and directories alike).
        if (mentionIdx < 0) goUpMention();
        else pickMention(mentionItems[mentionIdx]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setMentionOpen(false); return; }
      if (e.key === "Backspace") {
        const info = detectMention(value, cursorRef.current);
        if (info && info.query.endsWith("/")) { e.preventDefault(); goUpMention(); return; }
      }
    }

    // Tab path completion: when no menu (slash / mention) is open, the cursor sits
    // right after a path-like token, and there is no active selection, Tab fires
    // SessionFuzzyFind. A single unambiguous match replaces the token inline
    // (directories append '/' for further drilling, files append nothing); zero or
    // multiple matches do nothing (focus kept so the user can keep typing). With no
    // path token (whitespace / plain word) Tab falls through to default (move focus).
    // shift/ctrl/cmd/alt+Tab are left to the browser (window/OS shortcuts).
    if (
      e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
      !slashOpen && !mentionOpen && sessionId && !disabled
    ) {
      const el = ref.current;
      const hasSelection = !!el && el.selectionStart !== el.selectionEnd;
      const tok = hasSelection ? null : detectPathToken(value, cursorRef.current);
      if (tok) {
        e.preventDefault();
        const { scope, term } = splitScopeTerm(tok.token);
        const reqId = ++completeReqId.current;
        ChatService.SessionFuzzyFind(sessionId, scope, term, 12).then((nodes) => {
          if (reqId !== completeReqId.current) return; // stale: a newer Tab superseded this
          const list = (nodes || []).slice(0, 12);
          if (list.length !== 1) return; // single match only; multi/zero -> no completion
          const node = list[0];
          const replacement = node.path + (node.isDir ? "/" : "");
          if (replacement === tok.token) return; // already complete
          const pos = cursorRef.current;
          const next = value.slice(0, tok.start) + replacement + value.slice(pos);
          cursorRef.current = tok.start + replacement.length;
          onChange(next);
          requestAnimationFrame(() => {
            const e2 = ref.current;
            if (e2) { e2.focus(); e2.selectionStart = e2.selectionEnd = cursorRef.current; }
          });
        }).catch(() => { /* fuzzy find failed: Tab just no-ops, focus kept */ });
        return;
      }
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
    setSlashWarn(null); // 编辑输入 → 撤销未知命令提示
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

  // 把若干 File 转成 AudioAttachment 并入 audios。能力门控 + mime/大小校验。
  // audioSupported=false 时静默丢弃(入口本身已禁用,这里是兜底)。
  const addAudioFiles = async (files: File[]) => {
    if (!audioSupported || disabled) return;
    const accepted: AudioAttachment[] = [];
    for (const f of files) {
      if (!AUDIO_MIME_ALLOWED.includes(f.type)) continue;
      if (f.size > AUDIO_MAX_BYTES) continue;
      try {
        const data = await fileToBase64(f);
        const ext = (f.name.split(".").pop() || "wav").toLowerCase();
        accepted.push({ name: f.name || `audio-${Date.now()}.${ext}`, data, mimeType: f.type });
      } catch { /* 单条失败跳过,不阻断其余 */ }
    }
    if (accepted.length) onAudiosChange([...audios, ...accepted]);
  };

  // 音频选择入口:原生文件对话框(过滤音频)。能力门控:audioSupported=false 时按钮不渲染。
  const addAudios = async () => {
    if (!audioSupported) return;
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = AUDIO_MIME_ALLOWED.join(",");
      input.multiple = true;
      const chosen: File[] = await new Promise((resolve) => {
        input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
        input.click();
      });
      if (chosen.length) await addAudioFiles(chosen);
    } catch { /* 取消静默 */ }
  };

  // --- Voice dictation (#131 stage 2) ---
  // Insert text at the caret (not append): smart single-space padding on both
  // sides keeps prose readable when landing mid-word/mid-line. Expands the
  // long-text fold so the textarea exists to receive focus (focusSignal
  // pattern), then restores the caret right after the transcript.
  const insertAtCursor = (text: string) => {
    // Read the draft via valueRef: this runs in a promise continuation long
    // after the toggleVoice closure was created, so the captured `value` may
    // be stale if the user typed while transcription was in flight.
    const cur = valueRef.current;
    const pos = Math.min(cursorRef.current, cur.length);
    const before = cur.slice(0, pos);
    const after = cur.slice(pos);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    const next = before + lead + text + trail + after;
    cursorRef.current = pos + lead.length + text.length;
    setCollapsed(false);
    onChange(next);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) { el.focus(); el.selectionStart = el.selectionEnd = cursorRef.current; }
    });
  };

  // Mic button: idle → start recording; recording → stop + transcribe + insert
  // at caret. Failures (mic denied, backend not ready, …) surface as a
  // localized inline row instead of blocking the composer (§3.4-style
  // someone-is-present degradation).
  const toggleVoice = async () => {
    if (disabled || voicePhaseRef.current === "busy") return;
    if (voicePhaseRef.current === "recording") {
      voicePhaseRef.current = "busy";
      setVoiceState("transcribing");
      const handle = dictationRef.current;
      dictationRef.current = null;
      try {
        const blob = await handle?.stop();
        // Zero-size blob (stopped before the first 250ms timeslice) gets the
        // same inline hint as an empty transcript — never a silent return to
        // idle (§4.4 feedback consistency).
        if (!handle || !blob || blob.size === 0) { setVoiceError("noSpeech"); setVoiceState("idle"); return; }
        const text = await transcribeAudio(blob);
        if (!text) { setVoiceError("noSpeech"); setVoiceState("idle"); return; }
        insertAtCursor(text);
        setVoiceState("idle");
      } catch (e) {
        setVoiceError(e instanceof SttError ? e.kind : "failed");
        setVoiceState("idle");
      } finally {
        voicePhaseRef.current = "idle";
      }
      return;
    }
    voicePhaseRef.current = "busy";
    setVoiceError(null);
    try {
      dictationRef.current = await startDictation();
      voicePhaseRef.current = "recording";
      setVoiceState("recording");
    } catch (e) {
      voicePhaseRef.current = "idle";
      setVoiceError(e instanceof SttError ? e.kind : "failed");
    }
  };

  return (
    <div className="composer" data-testid="composer">
      {slashOpen && (
        <div className="slash-popover" data-testid="slash-popover">
          {filtered.map((c, i) => (
            <button key={c.name} className={`slash-item ${i === slashIdx ? "active" : ""}`} onMouseEnter={() => setSlashIdx(i)} onClick={() => pickSlash(c)} title={c.description}>
              <span className="slash-cmd">/{c.name}</span>
              <span className="slash-desc">{c.description}</span>
              {c.inputHint && <span className="slash-hint">{c.inputHint}</span>}
            </button>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div className="slash-popover mention-popover" data-testid="mention-popover">
          {/* 返回上一级:scope 非空(drill 态)时显示,退到父目录。data-testid 供测试点击。 */}
          {mentionScope !== "" && (
            <button
              className={`slash-item mention-up ${mentionIdx < 0 ? "active" : ""}`}
              data-testid="mention-go-up"
              onMouseEnter={() => setMentionIdx(-1)}
              onClick={goUpMention}
              title={t("composer.mention.goUpTip")}
            >
              <CornerUpLeft size={13} />
              <span className="slash-cmd mention-up-label">{t("composer.mention.goUp")}</span>
            </button>
          )}
          {mentionItems.map((n, i) => {
            // 跨目录结果可能撞名(src/foo.ts vs lib/foo.ts),显完整相对路径让用户区分:
            // 目录前缀 dim + basename 正常色(§4.4 不裸露歧义字段)。
            const dirPrefix = n.path.length > n.name.length ? n.path.slice(0, n.path.length - n.name.length) : "";
            return (
              <button
                key={n.path}
                className={`slash-item mention-item ${n.isDir ? "is-dir" : "is-file"} ${i === mentionIdx ? "active" : ""}`}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => activateMention(n)}
                title={n.isDir ? t("composer.mention.drillTip", { dir: n.path }) : "@" + n.path}
              >
                {n.isDir ? <Folder size={13} className="mention-ico-dir" /> : <File size={13} className="mention-ico-file" />}
                <span className="slash-cmd mention-path">
                  {dirPrefix && <span className="mention-dir">{dirPrefix}</span>}
                  {n.name}
                </span>
                {/* 目录项右侧 chevron 提示「可下钻」,文件项无(选中即引用)。 */}
                {n.isDir && <ChevronRight size={12} className="mention-drill-chev" />}
              </button>
            );
          })}
        </div>
      )}
      {slashWarn && (
        <div className="slash-warn" data-testid="slash-warn" role="alert">
          <span className="slash-warn-msg">
            {t("composer.slashUnknown", { cmd: slashWarn.cmd })}
            <span className="slash-warn-hint">{t("composer.slashUnknownHint")}</span>
          </span>
          <span className="slash-warn-actions">
            <button className="slash-warn-plain" data-testid="slash-warn-plain" onClick={sendAsPlain} title={t("composer.sendAsPlainTip")}>
              {t("composer.sendAsPlain")}
            </button>
            <button className="slash-warn-x" onClick={() => setSlashWarn(null)} title={t("common.dismiss")}><X size={13} /></button>
          </span>
        </div>
      )}
      {voiceError && (
        <div className="slash-warn voice-error" data-testid="voice-error" role="alert">
          <span className="slash-warn-msg">
            <span className="slash-warn-hint">{t(`composer.voiceErr.${voiceError}`)}</span>
          </span>
          <span className="slash-warn-actions">
            <button className="slash-warn-x" data-testid="voice-error-dismiss" onClick={() => setVoiceError(null)} title={t("common.dismiss")}><X size={13} /></button>
          </span>
        </div>
      )}

      <div className="compose-card">
        {elicitation && <ElicitationCard prompt={elicitation} onRespond={onRespondElicitation} />}
        {(attachments.length > 0 || mentions.length > 0 || images.length > 0 || audios.length > 0 || pasteSnippets.length > 0) && (
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
            {audios.map((au, i) => (
              <span key={au.name + i} className="att-chip att-chip-audio" title={au.name}>
                <span className="att-chip-name"><Mic size={11} /> {au.name}</span>
                <button className="att-chip-x" onClick={() => onAudiosChange(audios.filter((_, j) => j !== i))}><X size={11} /></button>
              </span>
            ))}
            {/* Large-paste chip: reuses the att-chip + fold visuals. Clicking the chip body
                 opens the fold preview (head/tail + middle ellipsis); × removes the snippet.
                 On submit the full original text is stitched back into the message (submit);
                 the chip is display-only. */}
            {pasteSnippets.map((sn) => (
              <span
                key={sn.id}
                className={`att-chip paste-chip ${expandedSnippet === sn.id ? "paste-chip-expanded" : ""}`}
                title={t("composer.pasteSnippetTip", { lines: sn.lines })}
              >
                <button
                  type="button"
                  className="paste-chip-toggle"
                  data-testid="paste-chip"
                  onClick={() => {
                    if (expandedSnippet === sn.id) {
                      setExpandedSnippet(null);
                      setSnippetFullyExpanded(false);
                    } else {
                      setSnippetFullyExpanded(false);
                      setExpandedSnippet(sn.id);
                    }
                  }}
                >
                  <ClipboardPaste size={11} />
                  <span className="att-chip-name">{t("composer.pasteSnippet", { lines: sn.lines })}</span>
                </button>
                <button
                  className="att-chip-x"
                  data-testid="paste-chip-remove"
                  onClick={() => removePasteSnippet(sn.id)}
                  title={t("common.remove")}
                ><X size={11} /></button>
              </span>
            ))}
          </div>
        )}

        {/* Open paste-snippet preview: reuses composer-collapse's head/tail + middle-ellipsis
            visual (§4.4: no raw object dumped). Click the divider to expand the folded middle
            lines; click the outer area (or the chip again) to close the preview. */}
        {snippetPreview && (
          <div
            className="composer-collapse paste-snippet-preview"
            data-testid="paste-snippet-preview"
            onClick={() => { setExpandedSnippet(null); setSnippetFullyExpanded(false); }}
            title={t("composer.pasteSnippetCloseTip")}
          >
            {snippetFullyExpanded ? (
              <pre className="composer-collapse-pre">
                {snippetPreview.all.map((l, i) => <div key={i} className="composer-collapse-line">{l || " "}</div>)}
              </pre>
            ) : (
              <>
                <pre className="composer-collapse-pre">
                  {snippetPreview.head.map((l, i) => <div key={i} className="composer-collapse-line">{l || " "}</div>)}
                </pre>
                <button
                  className="composer-collapse-divider"
                  data-testid="paste-snippet-expand"
                  onClick={(e) => { e.stopPropagation(); setSnippetFullyExpanded(true); }}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {t("composer.pasteSnippetFoldNote", { count: snippetPreview.foldCount })}
                </button>
                {snippetPreview.tail.length > 0 && (
                  <pre className="composer-collapse-pre">
                    {snippetPreview.tail.map((l, i) => <div key={i} className="composer-collapse-line">{l || " "}</div>)}
                  </pre>
                )}
              </>
            )}
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
            {...MOBILE_INPUT_ATTRS}
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
              // Large text paste (> PASTE_FOLD_THRESHOLD lines): don't flood the textarea,
              // capture it as a paste-snippet chip. preventDefault stops the default insert ->
              // value is unchanged and the textarea stays editable; the full original text is
              // stitched back on submit (submit). Runs after image handling (images first) and
              // before the short->long fold check (higher threshold, mutually exclusive: > 20
              // lines is chip-ified outright, never reaching the textarea so the fold is moot).
              const pasted = e.clipboardData?.getData("text") ?? "";
              if (pasted.split("\n").length > PASTE_FOLD_THRESHOLD) {
                e.preventDefault();
                addPasteSnippet(pasted);
                return;
              }
              // 粘贴使文本从「非长」跨入「长」→ 折叠成预览(聚焦态下 auto-collapse effect 不会折,这里显式补)。
              // 仅当粘贴前不是长文本(!isLong)才折:粘贴前已是长文本(用户多半已手动展开在编辑)时,粘贴不应把
              // textarea 折没 —— 否则键入丢失,即「复制后无法输入」。与 effect 的聚焦守卫一致:聚焦编辑中不打断。
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
            {/* PickFiles opens a NATIVE dialog on the desktop host (§1.8 remote):
                on a phone the tap would do nothing visible there. Hide the entry
                for remote clients — image/audio pickers use DOM file inputs and
                keep working. Phone→host file upload is future work (M2.5+). */}
            {!isRemoteClient() && (
              <button
                className="tool-btn"
                data-testid="attach-btn"
                onClick={addFiles}
                disabled={disabled}
                data-tooltip-id="md-tip"
                data-tooltip-content={t("composer.attachFilesTip")}
              >
                <Paperclip size={17} />
              </button>
            )}
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
            {audioSupported && (
              <button
                className="tool-btn"
                data-testid="audio-btn"
                onClick={addAudios}
                disabled={disabled}
                title={t("composer.addAudioTip")}
              >
                <Mic size={17} />
              </button>
            )}
            {/* Voice dictation (#131): mic → MediaRecorder → host STT → insert
                transcript at the caret. Works on all three faces (webview
                binding / remote /api/stt). The recording state is visually
                loud (red stop square + pulse) so a live mic is never missed.
                Idle icon is AudioLines — NOT Mic — so the button is never
                confused with the adjacent audio-ATTACHMENT button (agent
                capability, Mic icon, different semantics). */}
            <button
              className={`tool-btn voice-btn ${voiceState === "recording" ? "recording" : ""}`}
              data-testid="voice-btn"
              data-state={voiceState}
              onClick={() => { void toggleVoice(); }}
              disabled={disabled}
              aria-label={
                voiceState === "recording" ? t("composer.voiceStopTip")
                : voiceState === "transcribing" ? t("composer.voiceTranscribingTip")
                : t("composer.voiceDictateTip")
              }
              data-tooltip-id="md-tip"
              data-tooltip-content={
                voiceState === "recording" ? t("composer.voiceStopTip")
                : voiceState === "transcribing" ? t("composer.voiceTranscribingTip")
                : t("composer.voiceDictateTip")
              }
              data-tooltip-place="top"
            >
              {voiceState === "recording"
                ? <Square size={13} className="voice-stop-ico" />
                : voiceState === "transcribing"
                  ? <Loader2 size={15} className="spin" />
                  : <AudioLines size={17} />}
            </button>
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
            {/* 当前分支:与右上用量/历史并列的指示,点击从此分支新建对话(fork 一个新 worktree)。
                 空(非 git / 未取到)不渲染。§4.5 用 react-tooltip(md-tip),禁原生 title;§4.4 不裸露字段名。 */}
            {branch && (
              <button
                type="button"
                className="compose-branch"
                data-testid="composer-branch"
                onClick={() => onNewSessionOnBranch(branch)}
                data-tooltip-id="md-tip"
                data-tooltip-content={t("composer.branchTip")}
                data-tooltip-place="top"
              >
                <GitBranch size={11} />
                <span className="compose-branch-name">{branch}</span>
              </button>
            )}
            {/* MCP status chip: read-only indicator of which MCP servers the session selected
                 (relocated from ChatView header, issue #115). 0 selected → chip not rendered. */}
            <McpChip sessionId={sessionId} />
          </div>
          <div className="compose-right">
            <ModelSelect configOptions={configOptions} disabled={disabled} onSetConfig={onSetConfig} onRefreshConfig={onRefreshConfig} contextTokens={usage.used} />
            <ComposerUsage usage={usage} draftTokens={estimateTokens(value)} />
            {(attachments.length > 0 || mentions.length > 0 || images.length > 0 || audios.length > 0) && (
              <span className="composer-count">{t("composer.referencesCount", { count: attachments.length + mentions.length + images.length + audios.length })}</span>
            )}
            {/* Persistent stop slot (#104, plan C): rendered even when idle and hidden via
                visibility so the compose row keeps its width — no layout shift when prompting
                toggles. Hidden state is also unreachable: aria-hidden + tabIndex=-1 here,
                pointer-events:none in CSS. data-testid kept on the button regardless of state. */}
            <button
              className={`send-btn stop${prompting ? "" : " is-hidden"}`}
              data-testid="stop-btn"
              onClick={onStop}
              tabIndex={prompting ? 0 : -1}
              aria-hidden={!prompting || undefined}
              title={t("composer.stopTip")}
            >
              <Square size={15} />
            </button>
            <button
              className="send-btn enqueue"
              data-testid="enqueue-btn"
              onClick={() => submit(undefined, "enqueue")}
              disabled={disabled || empty}
              title={t("composer.enqueueTip")}
            >
              <ListPlus size={16} />
            </button>
            {/* While prompting, send means "queue send" — it takes the same amber look as the
                enqueue button (shared .queuing/.enqueue selector in CSS) so the two queue-ish
                actions read as one family; idle restores the default green. The tooltip keeps
                the existing queueSendTip/sendTip split. */}
            <button
              className={`send-btn${prompting ? " queuing" : ""}`}
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
// 「未上报」态:harness 上报的用量全 0(used/size/cost/明细均 0)时,展示灰色「—(未上报)」,
// 让用户看到「用量入口在,只是 harness 没报」而非入口消失。判定**只看实际数据是否全 0,
// 不依赖 CapabilityMatrix.emitsUsage**(§5.3 尊重数据源:capability 位是能力声明,数据才是真相;
// 声明会报但实际全 0 仍应显示未上报,反之亦然)。草稿预估是本地估算,不计入「是否上报」判定。
function ComposerUsage({ usage, draftTokens }: {
  usage: Usage;
  draftTokens: number;
}) {
  const { t } = useTranslation();
  const hasDraft = draftTokens > 0;
  const hasCtx = usage.used > 0 || usage.size > 0;
  const hasCost = usage.cost > 0;
  const hasBreakdown = usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0
    || usage.cachedReadTokens > 0 || usage.cachedWriteTokens > 0 || usage.thoughtTokens > 0;
  // harness 是否上报了任何用量数据:上下文 / 费用 / token 明细 任一非 0 即「已上报」。
  const hasUsageReported = hasCtx || hasCost || hasBreakdown;
  const pct = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0;
  // 分级配色:上下文越满越警示(绿 → 琥珀 → 红),让占比一眼可读。
  const level = pct >= 85 ? "crit" : pct >= 60 ? "high" : pct >= 30 ? "mid" : "low";
  // token 明细 tooltip(§4.5 react-tooltip):有明细 → 多行;已上报无明细 → 标题;未上报 → 未上报说明。
  const usageTip = !hasUsageReported
    ? t("chat.usageNotReportedTip")
    : hasBreakdown
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
      {hasDraft && hasUsageReported && <span className="cu-sep">·</span>}
      {hasUsageReported ? (
        <>
          {hasCtx && (
            <span className="cu-ctx">
              {fmtTokens(usage.used)}{usage.size > 0 ? ` / ${fmtTokens(usage.size)}` : ""}{usage.size > 0 ? ` · ${pct}%` : ""}
            </span>
          )}
          {hasCost && <span className="cu-cost">${usage.cost.toFixed(4)}</span>}
        </>
      ) : (
        <span className="cu-none">{t("chat.usageNotReported")}</span>
      )}
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

// ElicitationCard: ACP elicitation/create inline form (protocol v1 standard, SDK UNSTABLE).
// Rendered at the top of the compose-card (inside the input box) — agent is waiting on the
// user, so it lives where the user acts, not in the scroll stream. omp's single "value" field
// (select/confirm) gets a compact one-row layout; multi-field falls back to a vertical form.
// Buttons: Submit (accept, primary) + Skip (decline, lets harness degrade gracefully).
// cancel == Stop button (always available mid-turn), not duplicated here.
function ElicitationCard({ prompt, onRespond }: { prompt: ElicitationPrompt; onRespond: (action: "accept" | "decline" | "cancel", content: Record<string, unknown>) => void }) {
  const { t } = useTranslation();
  const isSingle = prompt.fields.length === 1;
  const single = isSingle ? prompt.fields[0] : null;
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of prompt.fields) {
      if (f.type === "boolean") init[f.name] = false;
      else if (f.enum && f.enum.length > 0) init[f.name] = f.default || f.enum[0];
      else init[f.name] = f.default || "";
    }
    return init;
  });
  const setField = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }));
  const submit = () => onRespond("accept", values);

  if (isSingle && single) {
    const label = single.title || single.description || prompt.message;
    return (
      <div className="elicit-inline" data-testid="elicitation-card">
        <ListChecks size={15} className="elicit-icon" />
        <span className="elicit-msg">{prompt.message || t("chat.elicitationTitleFallback")}</span>
        <div className="elicit-control">
          {single.type === "boolean" ? (
            <label className="elicit-bool">
              <input type="checkbox" data-testid={`elicit-${single.name}`} checked={values[single.name] === true} onChange={(e) => setField(single.name, e.target.checked)} />
              <span>{label}</span>
            </label>
          ) : single.enum && single.enum.length > 0 ? (
            <select className="elicit-select" data-testid={`elicit-${single.name}`} value={String(values[single.name] ?? "")} onChange={(e) => setField(single.name, e.target.value)}>
              {single.enum.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : (
            <input className="elicit-input" type="text" data-testid={`elicit-${single.name}`} placeholder={single.description || ""} value={String(values[single.name] ?? "")} onChange={(e) => setField(single.name, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          )}
        </div>
        <button className="elicit-btn elicit-submit" data-testid="elicit-accept" onClick={submit}>{t("chat.elicitAccept")}</button>
        <button className="elicit-btn elicit-skip" data-testid="elicit-decline" onClick={() => onRespond("decline", {})}>{t("chat.elicitSkip")}</button>
      </div>
    );
  }

  return (
    <div className="elicit-inline elicit-inline-multi" data-testid="elicitation-card">
      <div className="elicit-head">
        <ListChecks size={15} className="elicit-icon" />
        <span className="elicit-msg">{prompt.message || t("chat.elicitationTitleFallback")}</span>
      </div>
      <div className="elicit-fields">
        {prompt.fields.map((f) => (
          <div key={f.name} className="elicit-field">
            {f.type === "boolean" ? (
              <label className="elicit-bool">
                <input type="checkbox" data-testid={`elicit-${f.name}`} checked={values[f.name] === true} onChange={(e) => setField(f.name, e.target.checked)} />
                <span>{f.title || f.description || f.name}</span>
              </label>
            ) : f.enum && f.enum.length > 0 ? (
              <>
                {(f.title || f.description) && <div className="elicit-label">{f.title || f.description}</div>}
                <select className="elicit-select" data-testid={`elicit-${f.name}`} value={String(values[f.name] ?? "")} onChange={(e) => setField(f.name, e.target.value)}>
                  {f.enum.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </>
            ) : (
              <>
                {(f.title || f.description) && <div className="elicit-label">{f.title || f.description}</div>}
                <input className="elicit-input" type="text" data-testid={`elicit-${f.name}`} placeholder={f.description || ""} value={String(values[f.name] ?? "")} onChange={(e) => setField(f.name, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
              </>
            )}
          </div>
        ))}
      </div>
      <div className="elicit-actions">
        <button className="elicit-btn elicit-submit" data-testid="elicit-accept" onClick={submit}>{t("chat.elicitAccept")}</button>
        <button className="elicit-btn elicit-skip" data-testid="elicit-decline" onClick={() => onRespond("decline", {})}>{t("chat.elicitSkip")}</button>
      </div>
    </div>
  );
}
