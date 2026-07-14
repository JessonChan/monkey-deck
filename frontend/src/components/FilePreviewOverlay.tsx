import { useCallback, useEffect, useState } from "react";
import { File as FileIcon, Copy, X } from "lucide-react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";
import CodeViewer from "./CodeViewer";

// 文件预览覆盖层(Task #15084;Task #15088 升级为 CodeViewer —— 语法高亮 + 行号 + 目标行)。
// 由对话/工具卡片里的路径点击触发:加载文件内容,展示;有行号则定位/滚动/高亮该行。
// 高亮 / 行号对齐 / 目标行滚入视野 / 大文件虚拟化均由 CodeViewer 统一负责,这里只管加载与外壳。
// 行号是 1-based。
export interface PreviewTarget {
  path: string;
  line?: number;
}

export default function FilePreviewOverlay({
  sessionId,
  target,
  onClose,
}: {
  sessionId: string;
  target: PreviewTarget | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // 切换目标:重新加载。
  useEffect(() => {
    if (!target) {
      setContent("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent("");
    ChatService.SessionReadFile(sessionId, target.path)
      .then((c) => {
        if (cancelled) return;
        setContent(c ?? "");
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
  }, [target, sessionId]);

  // Esc 关闭(§4.2)。
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  }, [content]);

  if (!target) return null;
  const name = target.path.split("/").pop() || target.path;
  const lineNum = target.line;

  return (
    <div className="preview-overlay" onClick={onClose} data-testid="file-preview-overlay">
      <div className="preview-card" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <FileIcon size={14} />
          <span className="preview-name" title={target.path}>{name}</span>
          <span className="preview-path">
            {target.path}{lineNum ? `:${lineNum}` : ""}
          </span>
          <button
            className="tool-btn"
            onClick={copy}
            data-tooltip-id="md-tip"
            data-tooltip-content={copied ? "已复制" : "复制内容"}
            aria-label="复制内容"
          >
            {copied ? <span style={{ fontSize: 11 }}>✓</span> : <Copy size={14} />}
          </button>
          <button
            className="tool-btn"
            onClick={onClose}
            data-tooltip-id="md-tip"
            data-tooltip-content="关闭 (Esc)"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        {error ? (
          <div className="preview-error">读取失败:{error}</div>
        ) : loading ? (
          <div className="preview-loading">加载中…</div>
        ) : (
          <CodeViewer
            content={content}
            filename={target.path}
            highlightLine={lineNum}
            testId="file-preview-viewer"
          />
        )}
      </div>
    </div>
  );
}

