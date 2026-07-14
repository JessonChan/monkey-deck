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
  /** 显式语言名,优先于 filename 推断。 */
  language?: string;
  /** 1-based 目标行号:高亮该行并滚入视野(由路径点击的行号定位触发)。 */
  highlightLine?: number;
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

export default function CodeViewer({
  content,
  filename,
  language,
  highlightLine,
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
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

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

  const rowEl = (i: number) => {
    const ln = i + 1;
    const isTarget = highlightLine === ln;
    return (
      <div
        key={i}
        ref={isTarget && !virtual ? targetRef : undefined}
        className={`cv-line${isTarget ? " cv-target" : ""}`}
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
