// MermaidRenderer(Task #21289):把 ```mermaid 代码块渲染成 SVG 图。
//
// 关键体验决策:
// - streaming 时不渲染:消息流式追加时 ```mermaid 围栏可能不完整,反复尝试渲染 = 浪费 CPU +
//   闪烁报错。streaming 期间直接展示源码(用户能看到图在被「写出来」);streaming 结束才渲染。
// - 失败回退:渲染失败(agent 写错语法 / 不支持的图类型)→ 显示源码 + 简短错误提示(可复制)。
// - 动态加载 + hash 缓存:见 lib/mermaidRenderer.ts。
// - bindFunctions:mermaid 给 SVG 注入事件绑定的回调(accessibility 等),容器挂载后调用一次。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, GitGraph as DiagramIcon, RefreshCw } from "lucide-react";
import { renderMermaid, type MermaidRenderResult } from "../lib/mermaidRenderer";

interface Props {
  /** Mermaid 源码(```mermaid 围栏内的原文)。 */
  code: string;
  /**
   * 是否处于流式生成中。true 期间不渲染,只显示源码(避免不完整语法反复渲染失败)。
   * 默认 false(适用于用户已发送完毕的消息 / 用户消息)。
   */
  streaming?: boolean;
}

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; svg: string; bindFunctions?: (el: Element) => void }
  | { kind: "error"; message: string };

export default function MermaidRenderer({ code, streaming = false }: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  // 容器 ref:挂载 success SVG 后调用 bindFunctions(每次新 SVG 都需要重新绑定)。
  const svgHostRef = useRef<HTMLDivElement>(null);
  // 防止 effect 卸载后 setState(异步渲染可能晚于 unmount 完成)。
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    // streaming 期间不渲染:源码还在追加,渲染必失败。
    if (streaming) {
      setPhase({ kind: "idle" });
      return;
    }
    const codeTrimmed = code.trim();
    if (!codeTrimmed) {
      setPhase({ kind: "idle" });
      return;
    }
    setPhase({ kind: "loading" });
    void renderMermaid(code).then((res: MermaidRenderResult) => {
      if (cancelledRef.current) return;
      if (res.ok) {
        setPhase({ kind: "success", svg: res.svg, bindFunctions: res.bindFunctions });
      } else {
        setPhase({ kind: "error", message: res.error });
      }
    });
    return () => {
      cancelledRef.current = true;
    };
  }, [code, streaming]);

  // success 后 svgHost 挂载 / SVG 变化 → 调用 bindFunctions(mermaid 内部交互事件)。
  useEffect(() => {
    if (phase.kind !== "success") return;
    const host = svgHostRef.current;
    if (host && phase.bindFunctions) {
      try { phase.bindFunctions(host); } catch { /* noop:绑定失败不影响静态展示 */ }
    }
  }, [phase]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };

  // streaming 期间:展示源码(让用户看到图在被写),不渲染。
  if (streaming || phase.kind === "idle") {
    return (
      <div className="mermaid-box mermaid-streaming" data-testid="mermaid-source">
        <MermaidHeader label={t("chat.mermaidWriting")} onCopy={copy} copied={copied} />
        <pre className="mermaid-src-pre"><code>{code}</code></pre>
      </div>
    );
  }

  if (phase.kind === "loading") {
    return (
      <div className="mermaid-box mermaid-loading" data-testid="mermaid-loading">
        <RefreshCw size={13} className="mermaid-spin" />
        <span>{t("chat.mermaidLoading")}</span>
      </div>
    );
  }

  if (phase.kind === "error") {
    // 渲染失败回退:展示源码 + 简短错误提示,绝不把异常吞掉。
    return (
      <div className="mermaid-box mermaid-error" data-testid="mermaid-fallback">
        <MermaidHeader label={t("chat.mermaidRenderFailed")} onCopy={copy} copied={copied} error />
        <pre className="mermaid-src-pre"><code>{code}</code></pre>
        {phase.message && <div className="mermaid-error-msg" data-testid="mermaid-error-msg">{phase.message}</div>}
      </div>
    );
  }

  // success:把 SVG 字符串注入容器;bindFunctions 已在上方 effect 中调用。
  return (
    <div className="mermaid-box mermaid-ok" data-testid="mermaid-diagram">
      <MermaidHeader label={t("chat.mermaidDiagram")} onCopy={copy} copied={copied} />
      <div
        className="mermaid-svg-host"
        ref={svgHostRef}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: phase.svg }}
      />
    </div>
  );
}

function MermaidHeader({ label, onCopy, copied, error }: { label: string; onCopy: () => void; copied: boolean; error?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`mermaid-head${error ? " mermaid-head-err" : ""}`}>
      <span className="mermaid-head-label">
        <DiagramIcon size={12} />
        {label}
      </span>
      <button
        className="msg-action-btn"
        type="button"
        onClick={onCopy}
        data-testid="copy-mermaid"
        data-tooltip-id="md-tip"
        data-tooltip-content={t("common.copy")}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}
