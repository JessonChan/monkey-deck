// Read-only diff viewer built on react-diff-viewer-continued (MIT).
// Replaces the old "color by +/- prefix" rendering in lib/diff.ts with a real LCS
// diff: split/unified views, word-level diff highlighting, lazy Prism syntax
// highlighting (refractor loads each language on demand via dynamic import, so no
// heavy up-front cost — §4.6 lightweight), and built-in virtualization (infiniteLoading)
// so large diffs don't jank the desktop webview.
//
// Why this lib over Monaco/CodeMirror: we are read-only (no editing — see product
// positioning). react-diff-viewer-continued is ~50KB + lazy Prism langs, pure DOM,
// no canvas/WASM, behaves consistently across WKWebView/WebView2/WebKitGTK (§4.6).
//
// Why highlightLanguage (Prism) instead of renderContent (our highlight.js): the lib
// highlights each side as a whole (cross-line tokens correct) AND merges the highlight
// with word-diff marks on changed lines — renderContent only colours whole lines and
// cannot merge. Prism grammars are lazy-loaded per language, so the cost is paid only
// for the language actually shown. highlight.js is still used for plain file preview
// (CodeViewer); the two highlight engines serve different rendering contexts and both
// stay lightweight.
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { Columns2, Rows2, Copy, Check, X } from "lucide-react";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { detectDiffLanguage } from "../lib/lang";

export interface DiffViewProps {
  /** Old (before) content. Empty string for new-file case. */
  oldStr: string;
  /** New (after) content. Empty string for deleted-file case. */
  newStr: string;
  /** File path or basename — used to detect syntax language for highlighting. */
  filename?: string;
  /** Override detected language (Prism/refractor name). */
  language?: string;
  /** Default view: split (true, default) or unified (false). */
  defaultSplit?: boolean;
  /** data-testid prefix (default "diff-view"). */
  testId?: string;
  /** Max height for the viewer region (CSS string). Default 360px. */
  maxHeight?: string;
}

// Dark-theme palette overrides to match the app's tokens (react-diff-viewer-continued
// ships a built-in dark theme; we tint the diff backgrounds to the same greens/reds
// used by the old .diff-add/.diff-del classes so the upgrade is visually continuous).
const darkStyles = {
  variables: {
    dark: {
      diffViewerBackground: "transparent",
      gutterBackground: "transparent",
    },
  },
  line: { padding: "0 8px" },
  gutter: { padding: "0 6px" },
};

export default function DiffView({
  oldStr,
  newStr,
  filename,
  language,
  defaultSplit = true,
  testId = "diff-view",
  maxHeight = "360px",
}: DiffViewProps) {
  const { t } = useTranslation();
  const [split, setSplit] = useState(defaultSplit);

  const lang = language || (filename ? detectDiffLanguage(filename) : undefined);

  const viewer = useMemo(
    () => (
      <ReactDiffViewer
        oldValue={oldStr}
        newValue={newStr}
        splitView={split}
        // Word-level diff on; lines method handles CRLF/whitespace robustly.
        compareMethod={DiffMethod.WORDS_WITH_SPACE}
        useDarkTheme={true}
        hideLineNumbers={false}
        // Fold unchanged context (show only changed + N surrounding lines).
        showDiffOnly={true}
        extraLinesSurroundingDiff={3}
        // Virtualize large diffs so the desktop webview stays responsive (§4.6).
        infiniteLoading={{ pageSize: 50, containerHeight: maxHeight, overscan: 20 }}
        // Lazy Prism highlighting per detected language; unknown langs fall back to none.
        highlightLanguage={lang}
        styles={darkStyles}
        // Sync diff computation is the safe fallback if the worker bundle fails to load
        // under Wails3's webview/Vite config (§5.3 — know the degraded path).
        disableWorker={false}
      />
    ),
    [oldStr, newStr, split, lang, maxHeight]
  );

  const { copied, failed, copy } = useCopyFeedback();

  return (
    <div className="diff-view" data-testid={testId}>
      <div className="diff-view-bar">
        <button
          className="diff-view-btn"
          onClick={() => setSplit((s) => !s)}
          data-tooltip-id="md-tip"
          data-tooltip-content={split ? t("diff.switchToUnified") : t("diff.switchToSplit")}
          data-testid="diff-view-toggle"
        >
          {split ? <Columns2 size={13} /> : <Rows2 size={13} />}
          <span>{split ? t("diff.split") : t("diff.unified")}</span>
        </button>
        <button
          className="diff-view-btn"
          onClick={() => void copy(newStr)}
          data-tooltip-id="md-tip"
          data-tooltip-content={copied ? t("diff.copied") : failed ? t("common.copyFailed") : t("diff.copyNew")}
          data-testid="diff-view-copy"
        >
          {copied ? <Check size={13} /> : failed ? <X size={13} /> : <Copy size={13} />}
          <span>{copied ? t("diff.copied") : failed ? t("common.copyFailed") : t("diff.copy")}</span>
        </button>
      </div>
      <div className="diff-view-body" style={{ maxHeight }}>
        {viewer}
      </div>
    </div>
  );
}
