// MermaidRenderer(Task #21289):把 ```mermaid 代码块渲染成 SVG 图。
//
// 关键体验决策:
// - streaming 时不渲染:消息流式追加时 ```mermaid 围栏可能不完整,反复尝试渲染 = 浪费 CPU +
//   闪烁报错。streaming 期间直接展示源码(用户能看到图在被「写出来」);streaming 结束才渲染。
// - 失败回退:渲染失败(agent 写错语法 / 不支持的图类型)→ 显示源码 + 简短错误提示(可复制)。
// - 动态加载 + hash 缓存:见 lib/mermaidRenderer.ts。
// - bindFunctions:mermaid 给 SVG 注入事件绑定的回调(accessibility 等),容器挂载后调用一次。
// - 查看源码 toggle(Task #22115):success 状态下可一键切换查看原始 mermaid 源码 / 渲染图。
// - zoom(Task #22115):按钮(放大 / 缩小 / 重置)+ Ctrl/⌘ + 滚轮。按 SVG 自然宽度(取自 viewBox)
//   为缩放基准,zoom=1 即「适配容器宽度」(与原先 max-width:100% 一致),>1 触发横向滚动。
// - 全屏(Task #22945):success 状态下「全屏」按钮打开 modal overlay,复用同一套 zoom 机制;
//   Esc / 点遮罩 / 关闭按钮 三种方式关闭。zoom 逻辑抽到 useMermaidZoom + ZoomControls 共享,
//   避免 inline 与 modal 两份效果代码漂移。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Code2, Copy, GitGraph as DiagramIcon, Maximize2, RefreshCw, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
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

// zoom 边界与步长:0.3~3 够覆盖「看清细节 ↔ 纵览全图」,按钮步长比滚轮大一档更顺手。
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
const ZOOM_STEP_BTN = 0.2;
const ZOOM_STEP_WHEEL = 0.1;

function clampZoom(v: number): number {
  const r = Math.round(v * 100) / 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r));
}

// useMermaidZoom:SVG 宿主 + 缩放状态 + 效果(apply 宽度 / Ctrl 滚轮 / bindFunctions)。
// inline(success 视图)与 fullscreen modal 共用,是 zoom 的唯一实现,避免两份代码漂移。
// - enabled=false 时三个效果都短路(对应 inline 查看源码期间 / 未到 success)。
// - resetKey 变化时重置 zoom=1(对应新图渲染)。
function useMermaidZoom(opts: {
  enabled: boolean;
  bindFunctions?: (el: Element) => void;
  resetKey?: unknown;
}) {
  const { enabled, bindFunctions, resetKey } = opts;
  const svgHostRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  // resetKey 变化 → 重置缩放(新图)。挂载时也为 1,no-op。
  useEffect(() => {
    setZoom(1);
  }, [resetKey]);

  // success 后 svgHost 挂载 / SVG 变化 → 调用 bindFunctions(mermaid 内部交互事件)。
  useEffect(() => {
    if (!enabled) return;
    const host = svgHostRef.current;
    if (host && bindFunctions) {
      try { bindFunctions(host); } catch { /* noop:绑定失败不影响静态展示 */ }
    }
  }, [enabled, bindFunctions]);

  // zoom 实现:把 SVG 的 width 设为「基准宽度 × zoom」(基准 = min(自然宽度, 容器宽度)),
  // 这样 zoom=1 等价于原先的 max-width:100% 适配,zoom>1 时 SVG 实际变宽 → 容器 overflow:auto
  // 自然出现滚动条(无需 transform 的滚动尺寸补偿,跨平台 webview 表现一致)。
  // ResizeObserver 负责容器宽度变化(侧栏 / 窗口缩放)时重算基准,保持 zoom=1 始终「适配」。
  useEffect(() => {
    if (!enabled) return;
    const host = svgHostRef.current;
    const svg = host?.querySelector("svg") as SVGSVGElement | null;
    if (!host || !svg) return;
    const apply = () => {
      const hostW = host.clientWidth;
      if (hostW <= 0) return; // 测试 / 未布局环境,跳过(不影响 SVG 存在性)
      const vb = svg.viewBox?.baseVal;
      const natW = vb && vb.width > 0 ? vb.width : parseFloat(svg.getAttribute("width") || "") || hostW;
      const baseline = Math.min(natW, hostW);
      svg.style.width = `${Math.round(baseline * zoom)}px`;
      svg.style.maxWidth = "none";
    };
    apply();
    // ResizeObserver 驱动容器宽度变化时重算基准(侧栏 / 窗口缩放);测试环境无此 API 时降级为仅初始应用。
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(apply);
      ro.observe(host);
    }
    return () => ro?.disconnect();
  }, [enabled, zoom]);

  // Ctrl/⌘ + 滚轮缩放:用原生 addEventListener(wheel) + passive:false 才能 preventDefault 阻止页面缩放。
  useEffect(() => {
    if (!enabled) return;
    const host = svgHostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(e.deltaY < 0 ? z + ZOOM_STEP_WHEEL : z - ZOOM_STEP_WHEEL));
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [enabled]);

  return {
    svgHostRef,
    zoom,
    pct: Math.round(zoom * 100),
    zoomIn: () => setZoom((z) => clampZoom(z + ZOOM_STEP_BTN)),
    zoomOut: () => setZoom((z) => clampZoom(z - ZOOM_STEP_BTN)),
    resetZoom: () => setZoom(1),
    atMin: zoom <= ZOOM_MIN,
    atMax: zoom >= ZOOM_MAX,
  };
}

type ZoomApi = ReturnType<typeof useMermaidZoom>;

// ZoomControls:三个缩放按钮(缩小 / 重置 / 放大),inline 与 fullscreen 复用。
// testIdPrefix 区分两处实例的 data-testid,避免同文档内重复 testid 让选择器误选(inline=mermaid,modal=mermaid-fs)。
function ZoomControls({ z, testIdPrefix }: { z: ZoomApi; testIdPrefix: string }) {
  const { t } = useTranslation();
  return (
    <>
      <button
        className="msg-action-btn"
        type="button"
        onClick={z.zoomOut}
        disabled={z.atMin}
        data-testid={`${testIdPrefix}-zoom-out`}
        data-tooltip-id="md-tip"
        data-tooltip-content={t("chat.mermaidZoomOut")}
      >
        <ZoomOut size={12} />
      </button>
      <button
        className="msg-action-btn"
        type="button"
        onClick={z.resetZoom}
        data-testid={`${testIdPrefix}-zoom-reset`}
        data-tooltip-id="md-tip"
        data-tooltip-content={`${t("chat.mermaidZoomReset")} · ${z.pct}%`}
      >
        <RotateCcw size={12} />
      </button>
      <button
        className="msg-action-btn"
        type="button"
        onClick={z.zoomIn}
        disabled={z.atMax}
        data-testid={`${testIdPrefix}-zoom-in`}
        data-tooltip-id="md-tip"
        data-tooltip-content={t("chat.mermaidZoomIn")}
      >
        <ZoomIn size={12} />
      </button>
    </>
  );
}

export default function MermaidRenderer({ code, streaming = false }: Props) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  // success 状态下的查看源码开关(true = 显示源码而非 SVG)。
  const [viewSource, setViewSource] = useState(false);
  // success 状态下的全屏 modal 开关。
  const [fullscreen, setFullscreen] = useState(false);
  // inline 视图的 zoom(仅 success 且非查看源码时启用)。
  const inlineZoom = useMermaidZoom({
    enabled: phase.kind === "success" && !viewSource,
    bindFunctions: phase.kind === "success" ? phase.bindFunctions : undefined,
    resetKey: code,
  });
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
    // 新一轮渲染:重置交互态(查看源码 / 全屏)。zoom 由 useMermaidZoom 的 resetKey(code)重置。
    setViewSource(false);
    setFullscreen(false);
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

  // success:可切换查看源码;非源码视图展示 SVG + zoom 控件 + 全屏入口。
  return (
    <>
      <div className="mermaid-box mermaid-ok" data-testid="mermaid-diagram">
        <MermaidHeader label={t("chat.mermaidDiagram")} onCopy={copy} copied={copied}>
          <button
            className="msg-action-btn"
            type="button"
            onClick={() => setViewSource((v) => !v)}
            data-testid="mermaid-src-toggle"
            data-tooltip-id="md-tip"
            data-tooltip-content={viewSource ? t("chat.mermaidViewDiagram") : t("chat.mermaidViewSource")}
          >
            <Code2 size={12} />
          </button>
          {!viewSource && (
            <>
              <ZoomControls z={inlineZoom} testIdPrefix="mermaid" />
              <button
                className="msg-action-btn"
                type="button"
                onClick={() => setFullscreen(true)}
                data-testid="mermaid-fullscreen-open"
                data-tooltip-id="md-tip"
                data-tooltip-content={t("chat.mermaidFullscreen")}
              >
                <Maximize2 size={12} />
              </button>
            </>
          )}
        </MermaidHeader>
        {viewSource ? (
          <pre className="mermaid-src-pre"><code>{code}</code></pre>
        ) : (
          <div
            className="mermaid-svg-host"
            ref={inlineZoom.svgHostRef}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: phase.svg }}
          />
        )}
      </div>
      {fullscreen && (
        <MermaidFullscreen
          svg={phase.svg}
          bindFunctions={phase.bindFunctions}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  );
}

// MermaidFullscreen:全屏查看 modal(Task #22945)。复用 useMermaidZoom + ZoomControls,
// 独立 zoom 状态(每次打开即 100% 适配)。Esc / 点遮罩 / 关闭按钮 三种关闭方式。
function MermaidFullscreen({
  svg,
  bindFunctions,
  onClose,
}: {
  svg: string;
  bindFunctions?: (el: Element) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const z = useMermaidZoom({ enabled: true, bindFunctions, resetKey: svg });

  // Esc 关闭(§4.2)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="mermaid-fs-overlay" onClick={onClose} data-testid="mermaid-fullscreen">
      <div className="mermaid-fs-card" onClick={(e) => e.stopPropagation()}>
        <div className="mermaid-head">
          <span className="mermaid-head-label">
            <DiagramIcon size={12} />
            {t("chat.mermaidDiagram")}
          </span>
          <div className="mermaid-head-actions">
            <ZoomControls z={z} testIdPrefix="mermaid-fs" />
            <button
              className="msg-action-btn"
              type="button"
              onClick={onClose}
              data-testid="mermaid-fullscreen-close"
              data-tooltip-id="md-tip"
              data-tooltip-content={t("common.close")}
            >
              <X size={12} />
            </button>
          </div>
        </div>
        <div className="mermaid-fs-stage">
          <div
            className="mermaid-svg-host"
            ref={z.svgHostRef}
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}

function MermaidHeader({
  label,
  onCopy,
  copied,
  error,
  children,
}: {
  label: string;
  onCopy: () => void;
  copied: boolean;
  error?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`mermaid-head${error ? " mermaid-head-err" : ""}`}>
      <span className="mermaid-head-label">
        <DiagramIcon size={12} />
        {label}
      </span>
      <div className="mermaid-head-actions">
        {children}
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
    </div>
  );
}
