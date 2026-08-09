import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { File as FileIcon, Copy, X, Search, ChevronUp, ChevronDown, Quote } from "lucide-react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import CodeViewer from "./CodeViewer";
import SelectionToolbar, { type SelectionAction } from "./SelectionToolbar";
import { isImageFile } from "../utils";
import { copyText } from "../lib/clipboard";

// EditorPane renders the content of one opened file tab: text -> CodeViewer
// (syntax highlight + line numbers + virtualization + target-line highlight),
// image -> <img>. This is read-only preview — no editing (per project scope:
// code changes go through the agent via ACP, not an in-app editor).
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
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Scope ref for the selection toolbar: the content area below the toolbar /
  // search overlay. Excludes the toolbar inputs so selecting in them doesn't
  // pop the quote toolbar.
  const contentRef = useRef<HTMLDivElement>(null);
  const onQuoteRef = useRef(onQuoteToComposer);
  onQuoteRef.current = onQuoteToComposer;
  const selectionActions = useMemo<SelectionAction[]>(
    () => [
      {
        key: "quote",
        labelKey: "selectionToolbar.quoteToChat",
        tipKey: "selectionToolbar.quoteToChatTip",
        Icon: Quote,
        testId: "editor-selection-quote",
        run: (text) => { onQuoteRef.current?.(text); },
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
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    setImgUrl("");
    const p = image
      ? ChatService.SessionReadImage(sessionId, file.path).then((d) => d?.dataUrl ?? "")
      : ChatService.SessionReadFile(sessionId, file.path);
    p.then((c) => {
        if (cancelled) return;
        if (image) setImgUrl(c ?? "");
        else setContent(c ?? "");
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

  const copy = useCallback(async () => {
    await copyText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [content]);

  // ⌘F / Ctrl+F opens the search overlay (text files only). Attached at window
  // scope so it fires regardless of focus within the pane; preventDefault keeps
  // the webview's native find (if any) out of the way. EditorPane only mounts
  // when a file tab is active, so the listener's lifetime matches the pane.
  useEffect(() => {
    if (image) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image]);

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
        {!image && (
          <button
            className="tool-btn"
            onClick={copy}
            data-tooltip-id="md-tip"
            data-tooltip-content={copied ? t("common.copied") : t("filePreview.copyTip")}
            aria-label={t("filePreview.copyTip")}
          >
            {copied ? <span style={{ fontSize: 11 }}>✓</span> : <Copy size={14} />}
          </button>
        )}
        {!image && (
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
