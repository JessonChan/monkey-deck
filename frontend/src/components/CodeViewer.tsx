import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

// 文件 / 代码阅读器(Task #15088)。
// 能力:按扩展名选语言做语法高亮(highlight.js)+ 左侧行号槽与内容对齐滚动同步
//      + 目标行高亮并自动滚入视野 + 大文件虚拟化(仅渲染可视窗口,避免卡顿)。
//
// 设计:
// - 高亮在 lib/highlight.ts 里先对整段做、再按行切成平衡 span 片段,故跨行块(注释 / 模板串)
//   颜色在每行都正确延续;这里只负责逐行渲染行号 + 片段。
// - 行号槽与内容同行(.cv-line flex),共用一个滚动容器,天然对齐、同步滚动。
// - 虚拟化:行数超过阈值时改为「定高 + 按 scrollTop 只渲染可视区」;行数少时直接平铺,
//   兼顾小文件的简单可靠与大文件的低开销(§4.6 桌面长期驻留,禁止重型渲染)。
// - dangerouslySetInnerHTML 仅注入 highlight.js 产出的受限 HTML(标签 + class),非任意来源。
import { highlightToLines } from "../lib/highlight";
import "../hljs-theme.css";

export interface CodeViewerProps {
  /** 文件全文(纯文本)。 */
  content: string;
  /** 文件名或路径,用于按扩展名选语言;留空则走 highlightAuto。 */
  filename?: string;
  /**
   * Per-file scrollTop persistence key (Task #24182). When provided, the saved
   * scroll position is stored/restored under this key; otherwise falls back to
   * `filename`. Callers that share the same `filename` across distinct contexts
   * (e.g. the same relative path open in different sessions) MUST pass a key
   * unique to that context — otherwise scroll positions leak across contexts.
   * EditorPane passes `${sessionId}/${file.path}` because file.path is a relative
   * path pinned to each session's worktree, NOT globally unique.
   */
  scrollKey?: string;
  /** 显式语言名,优先于 filename 推断。 */
  language?: string;
  /** 1-based 目标行号:高亮该行并滚入视野(由路径点击的行号定位触发)。 */
  highlightLine?: number;
  /**
   * Search match line numbers (1-based) to highlight (Task #24197). Driven by
   * the EditorPane ⌘F overlay scanning `content`. Distinct from highlightLine
   * (which is the file-open target line) — both can be active at once.
   */
  searchMatches?: number[];
  /**
   * The currently-active search match's line (1-based). Gets a stronger
   * highlight than other match lines and is scrolled into view as the user
   * steps through prev/next. null/undefined when search is inactive or empty.
   */
  activeMatchLine?: number | null;
  /** 滚动容器最大高度(如 "80vh" / "420px");默认撑满父级给定高度。 */
  maxHeight?: string;
  /** 根节点附加 className。 */
  className?: string;
  /** data-testid 前缀(默认 "code-viewer")。 */
  testId?: string;
}

// 行高(与 .cv-line 的 line-height 严格一致,虚拟化按此换算像素)。
const LINE_HEIGHT = 19;
// 超过该行数启用虚拟化(只渲染可视窗口 + 上下缓冲)。
const VIRT_THRESHOLD = 2000;
// 虚拟化上下额外渲染的行数(减少快速滚动时的空白闪烁)。
const OVERSCAN = 12;
// Per-file scroll positions (Task #24182): module-level so the Map outlives any
// single CodeViewer instance. EditorPane unmounts/remounts CodeViewer on every
// file-tab switch (its loading gate hides the viewer while fetching), so without
// this a file always snaps back to the top when revisited. Keyed by `scrollKey`
// (or `filename` fallback) — callers must ensure the key is unique across all
// live contexts, since the Map is process-global.
const scrollPositions = new Map<string, number>();

export default function CodeViewer({
  content,
  filename,
  scrollKey,
  language,
  highlightLine,
  searchMatches,
  activeMatchLine,
  maxHeight,
  className = "",
  testId = "code-viewer",
}: CodeViewerProps) {
  const { lines, langLabel } = useMemo(() => {
    const r = highlightToLines(content, { filename, language });
    return { lines: r.lines, langLabel: r.language };
  }, [content, filename, language]);

  const total = lines.length;
  const virtual = total > VIRT_THRESHOLD;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const activeMatchRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Search match line lookup (Task #24197). searchMatches may contain
  // duplicates or be undefined; normalise into a Set once per render-pass of
  // the prop so the per-line className check stays O(1) inside rowEl.
  const searchMatchSet = useMemo(() => {
    if (!searchMatches || searchMatches.length === 0) return null;
    return new Set(searchMatches);
  }, [searchMatches]);

  // 滚动 / 尺寸 → 计算可视窗口(rAF 节流,避免高频 setState 卡顿)。
  useEffect(() => {
    if (!virtual) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollTop(el.scrollTop);
      });
    };
    const onResize = () => setViewportH(el.clientHeight);
    setViewportH(el.clientHeight);
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [virtual, total]);

  // 目标行:高亮 + 滚入视野。虚拟化态用像素定位;平铺态用 scrollIntoView(更稳)。
  useLayoutEffect(() => {
    if (!highlightLine || highlightLine < 1 || highlightLine > total) return;
    const el = scrollRef.current;
    if (!el) return;
    if (virtual) {
      const top = (highlightLine - 1) * LINE_HEIGHT - Math.max(0, (el.clientHeight - LINE_HEIGHT) / 2);
      el.scrollTop = Math.max(0, top);
    } else {
      const id = requestAnimationFrame(() => targetRef.current?.scrollIntoView({ block: "center", behavior: "auto" }));
      return () => cancelAnimationFrame(id);
    }
  }, [highlightLine, total, virtual, lines]);

  // Active search match: scroll into view as the user steps prev/next
  // (Task #24197). Mirrors the highlightLine effect above but keyed on
  // activeMatchLine so navigating between matches re-centers each time.
  // Defined after the highlightLine effect so a file-open target line wins
  // when both happen to land on the same commit; in practice search is opened
  // well after load, so the two rarely compete.
  useLayoutEffect(() => {
    if (!activeMatchLine || activeMatchLine < 1 || activeMatchLine > total) return;
    const el = scrollRef.current;
    if (!el) return;
    if (virtual) {
      const top = (activeMatchLine - 1) * LINE_HEIGHT - Math.max(0, (el.clientHeight - LINE_HEIGHT) / 2);
      el.scrollTop = Math.max(0, top);
    } else {
      const id = requestAnimationFrame(() => activeMatchRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
      return () => cancelAnimationFrame(id);
    }
  }, [activeMatchLine, total, virtual]);

  // Per-file scrollTop restore/dump (Task #24182). Coordinated with the
  // highlightLine effect above: that one is defined earlier, so on each commit
  // it runs first and wins when a valid target line is requested — here we skip
  // the restore whenever highlightLine is active. Dump lives in the cleanup,
  // which for a key change runs before the next setup (and runs on unmount),
  // so the live scrollTop is captured before the restore could overwrite it.
  // useLayoutEffect keeps dump→restore ordered within one commit and before
  // paint (no flicker). Deps are intentionally [posKey] only: restore fires on
  // mount and on file switch, not on every highlight/resize change.
  const posKey = scrollKey ?? filename;
  useLayoutEffect(() => {
    const hlActive = !!highlightLine && highlightLine >= 1 && highlightLine <= total;
    const el = scrollRef.current;
    if (el && posKey && !hlActive) {
      const saved = scrollPositions.get(posKey);
      if (saved != null) el.scrollTop = saved;
    }
    return () => {
      if (!posKey) return;
      const e = scrollRef.current;
      if (e) scrollPositions.set(posKey, e.scrollTop);
    };
  }, [posKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowEl = (i: number) => {
    const ln = i + 1;
    const isTarget = highlightLine === ln;
    const isMatch = !!searchMatchSet?.has(ln);
    const isActiveMatch = activeMatchLine === ln;
    return (
      <div
        key={i}
        ref={isTarget && !virtual ? targetRef : isActiveMatch && !virtual ? activeMatchRef : undefined}
        className={`cv-line${isTarget ? " cv-target" : ""}${isMatch ? " cv-search-match" : ""}${isActiveMatch ? " cv-search-active" : ""}`}
        data-line={ln}
      >
        <span className="cv-no">{ln}</span>
        <code className="cv-code hljs" dangerouslySetInnerHTML={{ __html: lines[i] || " " }} />
      </div>
    );
  };

  const bodyStyle: CSSProperties = virtual
    ? { position: "relative", height: total * LINE_HEIGHT }
    : {};

  const [start, end] = useMemo(() => {
    if (!virtual) return [0, total];
    const s = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
    const e = Math.min(total, Math.ceil((scrollTop + viewportH) / LINE_HEIGHT) + OVERSCAN);
    return [s, e];
  }, [virtual, total, scrollTop, viewportH]);

  const innerStyle: CSSProperties = virtual
    ? { position: "absolute", top: start * LINE_HEIGHT, left: 0, right: 0 }
    : {};

  return (
    <div
      className={`cv ${className}`}
      data-testid={testId}
      data-lang={langLabel || undefined}
      style={{ maxHeight }}
    >
      {langLabel && <span className="cv-lang" data-testid={`${testId}-lang`}>{langLabel}</span>}
      <div className="cv-scroll" ref={scrollRef} style={{ maxHeight }}>
        <div className="cv-body hljs" style={bodyStyle}>
          <div className="cv-window" style={innerStyle}>
            {virtual
              ? Array.from({ length: end - start }, (_, k) => rowEl(start + k))
              : lines.map((_, i) => rowEl(i))}
          </div>
        </div>
      </div>
    </div>
  );
}
