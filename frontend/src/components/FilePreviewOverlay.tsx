import { useCallback, useEffect, useRef, useState } from "react";
import { File as FileIcon, Copy, X } from "lucide-react";
import * as ChatService from "../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice";

// 文件预览覆盖层(Task #15084)。
// 由对话/工具卡片里的路径点击触发:加载文件内容,展示;有行号则定位/滚动/高亮该行。
// 与 FilePanel 的预览形态对齐(同样的覆盖层 + 等宽 <pre>),复用同一套 CSS(.preview-*)。
//
// 定位行号:把内容按行渲染成 <div data-line="n">,高亮目标行并 scrollIntoView。
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
  const targetLineRef = useRef<HTMLDivElement | null>(null);

  // 切换目标:重新加载 + 切到目标行后 scrollIntoView。
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

  // 内容/目标行变化后:scrollIntoView 目标行(等渲染完成)。
  useEffect(() => {
    if (!target?.line || loading || error) return;
    // rAF 等 DOM 更新后定位。
    const id = requestAnimationFrame(() => {
      targetLineRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(id);
  }, [target, content, loading, error]);

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
          <pre className="preview-pre preview-pre-lined">
            {content.split("\n").map((l, i) => {
              const ln = i + 1;
              const isTarget = lineNum === ln;
              return (
                <div
                  key={i}
                  ref={isTarget ? targetLineRef : undefined}
                  data-line={ln}
                  className={isTarget ? "preview-line preview-line-target" : "preview-line"}
                >
                  <span className="preview-line-no">{ln}</span>
                  <span className="preview-line-text">{l || " "}</span>
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );
}
