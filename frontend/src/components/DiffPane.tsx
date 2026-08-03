import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitCompare, X } from "lucide-react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import DiffView from "./DiffView";
import { countDiffLines } from "../lib/diff";
import { unifiedToOldNew } from "../lib/unified";

// DiffPane renders one file's git diff as a middle-column tab — the same DiffView
// (real LCS split/unified + word-diff + lazy Prism) used by EditToolCard, now given
// the full middle-column width instead of GitPanel's old cramped inline expand.
//
// Loads via SessionFileDiff (returns a unified patch), reconstructs old/new strings
// (lib/unified) and hands them to DiffView. `staged` selects the diff scope:
//   true  -> cached in the index, diffed against HEAD;
//   false -> working tree, diffed against the index.
// Loading/error/empty mirror EditorPane's states so the two pane kinds feel uniform.
export default function DiffPane({
  sessionId,
  path,
  staged,
  onClose,
}: {
  sessionId: string;
  path: string;
  staged: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiffText("");
    ChatService.SessionFileDiff(sessionId, path, staged)
      .then((d) => {
        if (!cancelled) setDiffText(d || "");
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, staged]);

  const recon = useMemo(() => unifiedToOldNew(diffText), [diffText]);
  const stat = useMemo(() => countDiffLines(diffText), [diffText]);
  const hasRecon = !!(recon.oldStr || recon.newStr);

  return (
    <div className="diff-pane" data-testid="diff-pane">
      <div className="editor-toolbar">
        <GitCompare size={14} />
        <span className="editor-path" title={path}>
          {path}
        </span>
        <span className={`diff-pane-scope ${staged ? "staged" : "unstaged"}`}>
          {staged ? t("diffPane.staged") : t("diffPane.unstaged")}
        </span>
        {(stat.added > 0 || stat.removed > 0) && (
          <span className="git-diff-stat">
            {stat.added > 0 && <span className="diff-stat diff-stat-add">+{stat.added}</span>}
            {stat.removed > 0 && <span className="diff-stat diff-stat-del">−{stat.removed}</span>}
          </span>
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
      {error ? (
        <div className="preview-error">{t("gitPanel.diffFailed", { error })}</div>
      ) : loading ? (
        <div className="preview-loading">{t("gitPanel.diffLoading")}</div>
      ) : hasRecon ? (
        <div className="diff-pane-body" data-testid="diff-pane-body">
          <DiffView oldStr={recon.oldStr} newStr={recon.newStr} filename={path} testId="diff-pane-view" maxHeight="100%" />
        </div>
      ) : (
        <div className="preview-loading">{t("gitPanel.noDiff")}</div>
      )}
    </div>
  );
}
