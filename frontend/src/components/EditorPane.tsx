import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { File as FileIcon, Copy, X } from "lucide-react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import CodeViewer from "./CodeViewer";
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
export interface EditorFile {
  path: string;
  line?: number;
}

export default function EditorPane({
  sessionId,
  file,
  onClose,
}: {
  sessionId: string;
  file: EditorFile;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string>("");
  const [imgUrl, setImgUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

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
          highlightLine={lineNum}
          testId="editor-pane-viewer"
        />
      )}
    </div>
  );
}
