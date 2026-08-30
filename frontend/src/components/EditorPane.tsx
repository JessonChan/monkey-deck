import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { File as FileIcon, Copy, Check, X, Search, ChevronUp, ChevronDown, Quote, Pencil, Save, AlertTriangle } from "lucide-react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import CodeViewer from "./CodeViewer";
import SelectionToolbar, { type SelectionAction } from "./SelectionToolbar";
import { isImageFile } from "../utils";
import { copyTextQuiet } from "../lib/clipboard";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

// EditorPane renders the content of one opened file tab: text -> CodeViewer
// (syntax highlight + line numbers + virtualization + target-line highlight),
// image -> <img>. Text files additionally switch into an edit mode: a gutter +
// textarea surface with dirty tracking, ⌘S save (SessionWriteFile), an
// on-disk conflict check before overwriting (the agent may edit the same
// worktree), and a per-path draft cache so switching file tabs mid-edit never
// silently drops unsaved text. Agent-side code changes still go through ACP —
// this is the human-at-the-desk convenience path.
//
// Loading logic ported from the deleted FilePreviewOverlay; the overlay shell
// (modal, Esc, centered card) is gone — this is a plain flex-fill pane that
// lives in the middle column under the file-tab row.
// `highlightLine` updates the target line each time the same path is reopened
// from a different source (file tree vs. tool card with a line number) without
// reloading content: EditorPane stays mounted across tab re-activations, and its
// fetch effect keys on `file.path`, so a pure line-hint change doesn't refetch.
// The line hint is passed straight through to CodeViewer.
//
// ⌘F search overlay (Task #24197): intercepts Cmd/Ctrl+F while a text file is
// open, shows a small find bar at the top-right of the pane, debounces the
// query, scans `content` for case-insensitive matches, and drives CodeViewer's
// per-line highlight (searchMatches) + active-match scroll-into-view
// (activeMatchLine). Esc closes the overlay; Enter / Shift+Enter step next /
// prev. Images don't get search (no text to scan).
export interface EditorFile {
  path: string;
  line?: number;
}

// Resolve the 1-based line numbers under the live DOM selection's anchor and
// focus endpoints (issue #168). CodeViewer rows carry data-line, so walking
// closest() from each endpoint's element yields its row. Returns null when
// either endpoint can't be resolved to a row (selection outside the viewer,
// empty, or a malformed attribute) — callers then proceed WITHOUT the source
// footnote (exact pre-#168 behavior) and never error.
function selectionLineRange(): [number, number] | null {
  const s = window.getSelection();
  if (!s || s.rangeCount === 0) return null;
  const lineOf = (node: Node | null): number | null => {
    const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
    const raw = el?.closest("[data-line]")?.getAttribute("data-line");
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const a = lineOf(s.anchorNode);
  const b = lineOf(s.focusNode);
  if (a === null || b === null) return null;
  // Drag direction is irrelevant to the cited range: normalize ascending.
  return a <= b ? [a, b] : [b, a];
}

// Append the source footnote (#168): `<selection>\n— <path>:N` for a single
// line, `<selection>\n— <path>:N-M` (N≤M) across lines. path is the file's
// relative path verbatim; the em-dash footnote is deliberately not i18n'd —
// it's a machine-readable anchor pasted into chat, not UI copy. App's
// quoteToComposer blockquotes the payload line-by-line, so the footnote lands
// naturally as the last line inside the quote block. Read at action-run time
// (the SelectionToolbar invokes run before clearing the selection), so the
// numbers always match the selection the user actually acted on.
function withSourceFootnote(text: string, path: string): string {
  const range = selectionLineRange();
  if (!range) return text;
  const span = range[0] === range[1] ? String(range[0]) : `${range[0]}-${range[1]}`;
  return `${text}\n— ${path}:${span}`;
}

export default function EditorPane({
  sessionId,
  file,
  onClose,
  onQuoteToComposer,
}: {
  sessionId: string;
  file: EditorFile;
  onClose: () => void;
  // Quote selected text (from the editor selection toolbar) into the composer
  // as a markdown blockquote. Routed up to App.tsx which owns the composer draft.
  onQuoteToComposer?: (text: string) => void;
}) {
  const [content, setContent] = useState<string>("");
  const [imgUrl, setImgUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Why content is absent (binary / too-large), from the backend's structured
  // FileData — gates the Edit button and renders a plain message. null = text.
  const [noPreview, setNoPreview] = useState<"binary" | "tooLarge" | null>(null);
  // Edit mode state. `draft` is the edit buffer for the CURRENT path;
  // `draftsRef` caches drafts per path so switching file tabs mid-edit and
  // coming back restores the buffer (EditorPane stays mounted across tab
  // switches — without this the load effect would silently drop edits).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Drafts are keyed by `${sessionId}/${path}`: relative paths collide across
  // sessions (each session is its own worktree), and a path-only key would
  // leak a draft — and its save target — into another session's file.
  const draftsRef = useRef<Map<string, string>>(new Map());
  const draftKey = `${sessionId}/${file.path}`;
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Non-null = the file changed on disk after we loaded it (typically the
  // agent writing the same worktree); banner offers overwrite / reload / keep.
  const [conflictDisk, setConflictDisk] = useState<string | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { t } = useTranslation();
  const { copied, failed, copy: copyFn } = useCopyFeedback();
  // Scope ref for the selection toolbar: the content area below the toolbar /
  // search overlay. Excludes the toolbar inputs so selecting in them doesn't
  // pop the quote toolbar.
  const contentRef = useRef<HTMLDivElement>(null);
  const onQuoteRef = useRef(onQuoteToComposer);
  onQuoteRef.current = onQuoteToComposer;
  // Same stability trick as onQuoteRef: the actions array must stay referentially
  // stable (SelectionToolbar re-renders on every selectionchange), while file.path
  // changes on tab switches without remount — read it through a ref at run time.
  const filePathRef = useRef(file.path);
  filePathRef.current = file.path;
  const selectionActions = useMemo<SelectionAction[]>(
    () => [
      {
        key: "copy",
        labelKey: "common.copy",
        tipKey: "selectionToolbar.copyTip",
        Icon: Copy,
        testId: "editor-selection-copy",
        run: (text) => { copyTextQuiet(withSourceFootnote(text, filePathRef.current)); },
      },
      {
        key: "quote",
        labelKey: "selectionToolbar.quoteToChat",
        tipKey: "selectionToolbar.quoteToChatTip",
        Icon: Quote,
        testId: "editor-selection-quote",
        run: (text) => { onQuoteRef.current?.(withSourceFootnote(text, filePathRef.current)); },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // ⌘F search overlay state (Task #24197). `query` is the live input value;
  // `debouncedQuery` is the snapshot actually used for matching, updated on a
  // timer so typing doesn't re-scan + re-render the whole file per keystroke.
  // `activeIdx` is the index into `matches` the user is currently on (Enter /
  // prev-next buttons step it, wrapping modulo length).
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const image = isImageFile(file.path);

  // Load content when the path changes (line changes alone don't reload —
  // CodeViewer re-highlights via highlightLine prop without a refetch).
  // Also (re)instates edit state from the per-path draft cache so returning
  // to a tab with unsaved edits restores the buffer instead of dropping it.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    setImgUrl("");
    setNoPreview(null);
    setSaveError(null);
    setConflictDisk(null);
    setConfirmExit(false);
    const savedDraft = draftsRef.current.get(draftKey);
    if (savedDraft !== undefined) {
      setEditing(true);
      setDraft(savedDraft);
    } else {
      setEditing(false);
      setDraft("");
    }
    const p = image
      ? ChatService.SessionReadImage(sessionId, file.path).then((d) => d?.dataUrl ?? "")
      : ChatService.SessionReadFile(sessionId, file.path);
    p.then((c) => {
        if (cancelled) return;
        if (image) {
          setImgUrl(c ?? "");
          return;
        }
        const fd = c ?? {};
        setContent(fd.content ?? "");
        setNoPreview(fd.binary ? "binary" : fd.tooLarge ? "tooLarge" : null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, sessionId, image]);

  // ---- Edit mode (text files) ----

  // Dirty = edit buffer diverged from the loaded on-disk content. Derived,
  // never stored, so it can't drift (§5.3 find the invariant).
  const dirty = editing && draft !== content;

  const enterEdit = useCallback(() => {
    setSearchOpen(false);
    setDraft(content);
    draftsRef.current.set(draftKey, content);
    setEditing(true);
    setConflictDisk(null);
    setConfirmExit(false);
    setSaveError(null);
  }, [content, draftKey]);

  const discardAndExit = useCallback(() => {
    draftsRef.current.delete(draftKey);
    setEditing(false);
    setDraft("");
    setConflictDisk(null);
    setConfirmExit(false);
    setSaveError(null);
  }, [draftKey]);

  const requestExitEdit = useCallback(() => {
    if (dirty) {
      setConfirmExit(true);
      return;
    }
    discardAndExit();
  }, [dirty, discardAndExit]);

  // Save the draft. Unless `force`, first re-read the file and refuse to
  // overwrite when the disk copy no longer matches what we loaded — the agent
  // edits the same worktree, and silently clobbering its writes (or vice
  // versa) is data loss. The conflict banner then offers overwrite / reload.
  const save = useCallback(
    async (force: boolean) => {
      if (saving || loading) return;
      setSaveError(null);
      setSaving(true);
      try {
        if (!force) {
          const c = await ChatService.SessionReadFile(sessionId, file.path);
          const fd = c ?? {};
          if (fd.binary || fd.tooLarge || (fd.content ?? "") !== content) {
            setConflictDisk(fd.binary || fd.tooLarge ? "" : fd.content ?? "");
            return;
          }
        }
        await ChatService.SessionWriteFile(sessionId, file.path, draft);
        setContent(draft);
        draftsRef.current.delete(draftKey);
        setEditing(false);
        setDraft("");
        setConflictDisk(null);
        setConfirmExit(false);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      } catch (e) {
        setSaveError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [saving, loading, sessionId, file.path, content, draft],
  );

  // Conflict banner → drop my edits and take the on-disk version.
  const conflictReload = useCallback(async () => {
    draftsRef.current.delete(draftKey);
    setEditing(false);
    setDraft("");
    setConflictDisk(null);
    setConfirmExit(false);
    setSaveError(null);
    try {
      const c = await ChatService.SessionReadFile(sessionId, file.path);
      const fd = c ?? {};
      setContent(fd.content ?? "");
      setNoPreview(fd.binary ? "binary" : fd.tooLarge ? "tooLarge" : null);
    } catch {
      // keep the current content; a failed re-read surfaces on next open
    }
  }, [sessionId, file.path]);

  const onDraftChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      draftsRef.current.set(draftKey, e.target.value);
    },
    [draftKey],
  );

  // Textarea keys: ⌘S saves, Esc peels banners off first then exits edit
  // (confirm when dirty), Tab inserts a 2-space soft indent (default Tab would
  // move focus out of the editor — broken UX for code).
  const onEditKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (dirty && !saving) void save(false);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (conflictDisk !== null) {
          setConflictDisk(null);
          return;
        }
        if (confirmExit) {
          setConfirmExit(false);
          return;
        }
        requestExitEdit();
        return;
      }
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const ta = e.currentTarget;
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        const next = draft.slice(0, s) + "  " + draft.slice(en);
        setDraft(next);
        draftsRef.current.set(draftKey, next);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = s + 2;
        });
      }
    },
    [dirty, saving, conflictDisk, confirmExit, requestExitEdit, save, draft, draftKey],
  );

  // Keep the gutter scrolled with the textarea (single writer: user scrolls
  // the textarea; the gutter just mirrors scrollTop).
  const syncGutter = useCallback(() => {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  }, []);

  // Focus the textarea whenever edit mode is (re)entered.
  useEffect(() => {
    if (editing) taRef.current?.focus();
  }, [editing]);

  // Gutter line numbers for the current draft. Plain sequential divs; the
  // textarea itself is not virtualized, so the gutter may hold one node per
  // line — same order of cost as the textarea's own content.
  const lineCount = useMemo(() => draft.split("\n").length, [draft]);

  const copy = useCallback(() => {
    void copyFn(editing ? draft : content);
  }, [content, draft, editing, copyFn]);

  // ⌘F / Ctrl+F opens the search overlay (view mode, text files only — edit
  // mode has no CodeViewer to drive). Attached at window scope so it fires
  // regardless of focus within the pane; preventDefault keeps the webview's
  // native find (if any) out of the way. EditorPane only mounts when a file
  // tab is active, so the listener's lifetime matches the pane.
  useEffect(() => {
    if (image || editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image, editing]);

  // Debounce the query so rapid typing doesn't re-scan a large file + re-render
  // every CodeViewer line on each keystroke. Reset activeIdx to 0 so the user
  // always lands on the first match of the new result set.
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedQuery(query);
      setActiveIdx(0);
    }, 200);
    return () => clearTimeout(id);
  }, [query]);

  // Reset search state on file switch — matches from the previous file are
  // meaningless against new content and the overlay shouldn't carry over.
  useEffect(() => {
    setSearchOpen(false);
    setQuery("");
    setDebouncedQuery("");
    setActiveIdx(0);
  }, [file.path]);

  // Focus the input when the overlay opens (both via ⌘F and the toolbar button).
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // Scan content for case-insensitive matches. Each match records its 1-based
  // line so CodeViewer can highlight per-line; occurrences on the same line
  // collapse to one highlight but remain distinct for next/prev stepping.
  // Per §5.3 (find the invariant): the invariant is the (line, col) occurrence
  // list; the per-line Set and the active line are derived, never stored as
  // independent state that could drift out of sync.
  const matches = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return [] as { line: number; col: number }[];
    const out: { line: number; col: number }[] = [];
    const ls = content.split("\n");
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i].toLowerCase();
      let from = 0;
      while (true) {
        const idx = l.indexOf(q, from);
        if (idx < 0) break;
        out.push({ line: i + 1, col: idx });
        from = idx + q.length;
      }
    }
    return out;
  }, [debouncedQuery, content]);

  const searchMatchLines = useMemo(() => {
    if (matches.length === 0) return undefined;
    const s = new Set<number>();
    for (const m of matches) s.add(m.line);
    return Array.from(s);
  }, [matches]);

  const safeIdx = matches.length === 0 ? 0 : Math.min(activeIdx, matches.length - 1);
  const activeMatchLine = matches.length > 0 ? matches[safeIdx].line : null;

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      setActiveIdx((i) => (i + dir + matches.length) % matches.length);
    },
    [matches.length],
  );

  const onSearchKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSearchOpen(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        stepMatch(e.shiftKey ? -1 : 1);
      }
    },
    [stepMatch],
  );

  const closeSearch = useCallback(() => setSearchOpen(false), []);

  const name = file.path.split("/").pop() || file.path;
  const lineNum = file.line;

  return (
    <div className="editor-pane" data-testid="editor-pane">
      <div className="editor-toolbar">
        <FileIcon size={14} />
        <span className="editor-path" title={file.path}>
          {file.path}{lineNum ? `:${lineNum}` : ""}
        </span>
        {savedFlash && !editing && (
          <span className="ed-saved" data-testid="editor-saved">✓ {t("filePreview.saved")}</span>
        )}
        {!image && !editing && !noPreview && !loading && !error && (
          <button
            className="tool-btn"
            onClick={enterEdit}
            data-testid="editor-edit-btn"
            data-tooltip-id="md-tip"
            data-tooltip-content={t("filePreview.editTip")}
            aria-label={t("filePreview.editTip")}
          >
            <Pencil size={14} />
          </button>
        )}
        {editing && (
          <>
            {dirty && (
              <span
                className="ed-dirty"
                data-testid="editor-dirty"
                data-tooltip-id="md-tip"
                data-tooltip-content={t("filePreview.dirtyTip")}
              >
                ●
              </span>
            )}
            <button
              className="tool-btn"
              onClick={() => void save(false)}
              disabled={!dirty || saving}
              data-testid="editor-save-btn"
              data-tooltip-id="md-tip"
              data-tooltip-content={t("filePreview.saveTip")}
              aria-label={t("filePreview.saveTip")}
            >
              {saving ? <span style={{ fontSize: 11 }}>…</span> : <Save size={14} />}
            </button>
            <button
              className="tool-btn"
              onClick={requestExitEdit}
              data-testid="editor-exit-btn"
              data-tooltip-id="md-tip"
              data-tooltip-content={t("filePreview.exitEditTip")}
              aria-label={t("filePreview.exitEditTip")}
            >
              <X size={14} />
            </button>
          </>
        )}
        {!image && !editing && (
          <button
            className="tool-btn"
            onClick={copy}
            data-tooltip-id="md-tip"
            data-tooltip-content={copied ? t("common.copied") : failed ? t("common.copyFailed") : t("filePreview.copyTip")}
            aria-label={t("filePreview.copyTip")}
          >
            {copied ? <Check size={14} /> : failed ? <X size={14} /> : <Copy size={14} />}
          </button>
        )}
        {!image && !editing && (
          <button
            className="tool-btn"
            onClick={() => setSearchOpen(true)}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("filePreview.searchTip")}
            aria-label={t("filePreview.searchTip")}
          >
            <Search size={14} />
          </button>
        )}
        <button
          className="tool-btn"
          onClick={onClose}
          data-tooltip-id="md-tip"
          data-tooltip-content={t("filePreview.closeTip")}
          aria-label={t("common.close")}
        >
          <X size={16} />
        </button>
      </div>
      {searchOpen && !image && (
        <div className="editor-search-overlay" data-testid="editor-search-overlay">
          <Search size={13} className="editor-search-icon" />
          <input
            ref={searchInputRef}
            className="editor-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t("filePreview.searchPlaceholder")}
            aria-label={t("filePreview.searchPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            data-testid="editor-search-input"
          />
          <span className="editor-search-count" data-testid="editor-search-count">
            {matches.length > 0
              ? t("filePreview.searchCount", { n: safeIdx + 1, total: matches.length })
              : debouncedQuery
                ? t("filePreview.searchNoMatch")
                : ""}
          </span>
          <button
            className="tool-btn editor-search-step"
            onClick={() => stepMatch(-1)}
            disabled={matches.length === 0}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("filePreview.searchPrev")}
            aria-label={t("filePreview.searchPrev")}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="tool-btn editor-search-step"
            onClick={() => stepMatch(1)}
            disabled={matches.length === 0}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("filePreview.searchNext")}
            aria-label={t("filePreview.searchNext")}
          >
            <ChevronDown size={15} />
          </button>
          <button
            className="tool-btn"
            onClick={closeSearch}
            data-tooltip-id="md-tip"
            data-tooltip-content={t("filePreview.searchClose")}
            aria-label={t("common.close")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div ref={contentRef} className="editor-pane-content">
        {error ? (
          <div className="preview-error">{t("filePreview.readFailed", { error })}</div>
        ) : editing ? (
          <div className="ed-wrap" data-testid="editor-edit">
            {conflictDisk !== null && (
              <div className="ed-banner ed-banner-warn" data-testid="editor-conflict" role="alert">
                <AlertTriangle size={14} className="ed-banner-icon" />
                <span className="ed-banner-text">{t("filePreview.conflictTitle")}</span>
                <button
                  className="ed-banner-btn"
                  onClick={() => void save(true)}
                  disabled={saving}
                  data-testid="editor-conflict-force"
                >
                  {t("filePreview.conflictForce")}
                </button>
                <button
                  className="ed-banner-btn"
                  onClick={() => void conflictReload()}
                  data-testid="editor-conflict-reload"
                >
                  {t("filePreview.conflictReload")}
                </button>
                <button className="ed-banner-btn ed-banner-cancel" onClick={() => setConflictDisk(null)}>
                  {t("filePreview.keepEditing")}
                </button>
              </div>
            )}
            {confirmExit && (
              <div className="ed-banner" data-testid="editor-exit-confirm" role="alert">
                <span className="ed-banner-text">{t("filePreview.exitConfirmTitle")}</span>
                <button
                  className="ed-banner-btn"
                  onClick={() => void save(false)}
                  disabled={!dirty || saving}
                  data-testid="editor-exit-save"
                >
                  {t("filePreview.saveAndExit")}
                </button>
                <button className="ed-banner-btn" onClick={discardAndExit} data-testid="editor-exit-discard">
                  {t("filePreview.discard")}
                </button>
                <button className="ed-banner-btn ed-banner-cancel" onClick={() => setConfirmExit(false)}>
                  {t("filePreview.keepEditing")}
                </button>
              </div>
            )}
            {saveError && (
              <div className="ed-banner ed-banner-error" data-testid="editor-save-error" role="alert">
                <span className="ed-banner-text">{t("filePreview.saveFailed", { error: saveError })}</span>
                <button className="ed-banner-btn ed-banner-cancel" onClick={() => setSaveError(null)}>
                  {t("common.close")}
                </button>
              </div>
            )}
            <div className="ed-scroll">
              <div className="ed-gutter" ref={gutterRef} aria-hidden="true">
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i} className="ed-no">{i + 1}</div>
                ))}
              </div>
              <textarea
                ref={taRef}
                className="ed-text"
                data-testid="editor-edit-textarea"
                value={draft}
                onChange={onDraftChange}
                onScroll={syncGutter}
                onKeyDown={onEditKey}
                spellCheck={false}
                wrap="off"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={file.path}
              />
            </div>
          </div>
        ) : loading ? (
          <div className="preview-loading">{t("filePreview.loading")}</div>
        ) : image ? (
          <div className="preview-img-scroll" data-testid="editor-pane-img-scroll">
            {imgUrl && (
              <img
                className="preview-img"
                src={imgUrl}
                alt={name}
                data-testid="editor-pane-img"
              />
            )}
          </div>
        ) : noPreview ? (
          <div className="preview-empty" data-testid="editor-nopreview">
            {noPreview === "binary" ? t("filePreview.binaryFile") : t("filePreview.tooLarge")}
          </div>
        ) : (
          <CodeViewer
            content={content}
            filename={file.path}
            scrollKey={`${sessionId}/${file.path}`}
            highlightLine={lineNum}
            searchMatches={searchOpen ? searchMatchLines : undefined}
            activeMatchLine={searchOpen ? activeMatchLine : null}
            testId="editor-pane-viewer"
          />
        )}
      </div>
      {/* Selection toolbar (Quote → composer): scoped to the content area below
          the toolbar / search overlay. See SelectionToolbar. */}
      <SelectionToolbar scope={contentRef} actions={selectionActions} />
    </div>
  );
}
