import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { splitByPaths } from "../lib/filePath";

// 可复用的「长文本折叠」块(AGENTS.md §5.3:references 优先参考——形态沿用本项目
// Composer / 用户气泡的长文本折叠先例,docs/worklog/2026-07-14-composer-long-text-collapse.md)。
//
// 短文本:直接渲染等宽 <pre>(保留换行、横向滚动不撑破布局)。
// 长文本:默认折叠(首尾若干行 + 中间省略条),可展开成完整 <pre>(限高 + 双向滚动)。
// 设计为「工具 I/O 卡片」共用折叠件:bash 输出本 task 接入,grep/glob/edit 后续复用(§5.3)。
export interface CollapsibleTextProps {
  text: string;
  /** 行数阈值:超过即判定为长文本(默认 24) */
  longLineThreshold?: number;
  /** 字符阈值:单/双行长文本兜底(默认 1000) */
  longCharThreshold?: number;
  /** 折叠预览展示前 N 行(默认 8) */
  headLines?: number;
  /** 折叠预览展示后 M 行(默认 6) */
  tailLines?: number;
  /** 是否默认折叠(仅长文本生效,默认 true) */
  defaultCollapsed?: boolean;
  /** 顶部 meta 行右侧额外节点(如外部自定义按钮) */
  extra?: ReactNode;
  /** 折叠/展开根节点附加 className */
  className?: string;
  /** 折叠预览块(首尾 + 省略条)的 className */
  previewClassName?: string;
  /** 完整文本(短文本态 / 展开态)的 <pre> className */
  preClassName?: string;
  /** 行计数单位文案(省略时取 i18n collapsibleText.lineUnit) */
  lineUnit?: string;
  /** 是否显示复制按钮(默认 true) */
  copyable?: boolean;
  /** data-testid 前缀(默认「collapsible-text」) */
  testId?: string;
  /** 单行 className 计算回调:提供时把每一行包进 <div className=…>(短/展开/折叠预览三态一致),
   *  用于按行染色(如 diff 的 +/- 高亮)。未提供时维持原 <pre>{text}</pre> 行为(bash 等不动)。 */
  lineClassName?: (line: string, idx: number) => string;
  /** 路径链接化回调:提供时把每行里的文件路径识别成可点击的 .path-link(点击在文件面板预览)。
   *  与 lineClassName 可组合(diff 染色 + 路径可点击)。未提供时维持纯文本(默认)。 */
  onPath?: (path: string, line?: number) => void;
}

const DEFAULTS = {
  longLineThreshold: 24,
  longCharThreshold: 1000,
  headLines: 8,
  tailLines: 6,
  testId: "collapsible-text",
} as const;

export default function CollapsibleText(props: CollapsibleTextProps) {
  const {
    text,
    longLineThreshold = DEFAULTS.longLineThreshold,
    longCharThreshold = DEFAULTS.longCharThreshold,
    headLines = DEFAULTS.headLines,
    tailLines = DEFAULTS.tailLines,
    defaultCollapsed = true,
    extra,
    className = "",
    previewClassName = "",
    preClassName = "",
    lineUnit,
    copyable = true,
    testId = DEFAULTS.testId,
    lineClassName,
    onPath,
  } = props;

  const { t } = useTranslation();
  const lineUnitText = lineUnit ?? t("collapsibleText.lineUnit");

  const lines = useMemo(() => text.split("\n"), [text]);
  const isLong = lines.length > longLineThreshold || text.length > longCharThreshold;
  const [collapsed, setCollapsed] = useState(isLong && defaultCollapsed);
  const [copied, setCopied] = useState(false);

  // 把单行渲染成节点:可选行 className(+ path 链接化)。
  // 短态/展开态/折叠预览态均复用本函数,保持三态一致。
  const renderLine = useCallback(
    (line: string, idx: number) => {
      const cls = lineClassName?.(line, idx);
      if (!onPath) {
        // 纯文本行(最常见路径,避免每行都跑 splitByPaths)。
        return (
          <div key={idx} className={cls}>
            {line || " "}
          </div>
        );
      }
      const parts = splitByPaths(line);
      if (parts.length === 1 && parts[0].type === "text") {
        return (
          <div key={idx} className={cls}>
            {line || " "}
          </div>
        );
      }
      return (
        <div key={idx} className={cls}>
          {parts.map((p, pi) =>
            p.type === "text" ? (
              <Fragment key={pi}>{p.text}</Fragment>
            ) : (
              <span
                key={pi}
                className="path-link"
                role="button"
                tabIndex={0}
                title={t("collapsibleText.openPathTip", { raw: p.raw })}
                data-tooltip-id="md-tip"
                data-tooltip-content={t("collapsibleText.previewPathTip", { raw: p.raw })}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onPath(p.path, p.line);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onPath(p.path, p.line);
                  }
                }}
              >
                {p.raw}
              </span>
            )
          )}
        </div>
      );
    },
    [lineClassName, onPath, t]
  );

  // 按行渲染(供 diff +/- 染色等场景):每行包一个 <div>,空行用「 」占位保留行高。
  const renderPreBody = useMemo(() => {
    if (!lineClassName && !onPath) return null;
    return lines.map((l, i) => renderLine(l, i));
  }, [lines, renderLine, lineClassName, onPath]);

  // 折叠预览:行多 → 首尾若干行 + 中间省略条;行少但字符超长 → 全部行(逐行截断)+ 字符提示。
  const preview = useMemo(() => {
    if (!isLong) return null;
    if (lines.length > headLines + tailLines) {
      return {
        head: lines.slice(0, headLines),
        tail: lines.slice(lines.length - tailLines),
        note: t("collapsibleText.linesFolded", { count: lines.length - headLines - tailLines, unit: lineUnitText }),
      };
    }
    return { head: lines, tail: [], note: t("collapsibleText.longLineTruncated", { count: text.length }) };
  }, [isLong, lines, text.length, headLines, tailLines, lineUnitText, t]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* noop */ }
  };
  const expand = () => setCollapsed(false);

  // 短文本:无 meta、无折叠,直接等宽 <pre>(横向滚动、保留换行)。
  if (!isLong) {
    return (
      <div className={`ctext ctext-short ${className}`} data-testid={testId}>
        {copyable && (
          <div className="ctext-meta">
            <span className="ctext-count">{t("collapsibleText.lineCharCount", { lines: lines.length, unit: lineUnitText, chars: text.length })}</span>
            <button
              className="msg-action-btn"
              type="button"
              onClick={copy}
              data-tooltip-id="md-tip"
              data-tooltip-content={copied ? t("common.copied") : t("common.copy")}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
            {extra}
          </div>
        )}
        <pre className={`ctext-pre ${preClassName}`}>{renderPreBody ?? text}</pre>
      </div>
    );
  }

  return (
    <div className={`ctext ${collapsed ? "is-collapsed" : "is-expanded"} ${className}`} data-testid={testId}>
      <div className="ctext-meta" data-testid={`${testId}-meta`}>
        <span className="ctext-count">{t("collapsibleText.lineCharCount", { lines: lines.length, unit: lineUnitText, chars: text.length })}</span>
        <div className="ctext-actions">
          {copyable && (
            <button
              className="msg-action-btn"
              type="button"
              onClick={copy}
              data-tooltip-id="md-tip"
              data-tooltip-content={copied ? t("common.copied") : t("common.copy")}
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          )}
          {extra}
          <button
            className="ctext-toggle"
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            data-tooltip-id="md-tip"
            data-tooltip-content={collapsed ? t("collapsibleText.expandFull") : t("common.collapse")}
            data-testid={`${testId}-toggle`}
          >
            {collapsed ? <><ChevronDown size={12} /> {t("common.expand")}</> : <><ChevronUp size={12} /> {t("common.collapse")}</>}
          </button>
        </div>
      </div>

      {collapsed && preview ? (
        <div
          className={`ctext-preview ${previewClassName}`}
          data-testid={`${testId}-preview`}
          onClick={expand}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expand(); } }}
        >
          <pre className="ctext-preview-pre">
            {preview.head.map((l, i) => {
              const cls = lineClassName ? `ctext-preview-line ${lineClassName(l, i)}` : "ctext-preview-line";
              if (!onPath) return <div key={i} className={cls}>{l || " "}</div>;
              const parts = splitByPaths(l);
              if (parts.length === 1 && parts[0].type === "text") return <div key={i} className={cls}>{l || " "}</div>;
              return (
                <div key={i} className={cls}>
                  {parts.map((p, pi) =>
                    p.type === "text" ? (
                      <Fragment key={pi}>{p.text}</Fragment>
                    ) : (
                      <span
                        key={pi}
                        className="path-link"
                        role="button"
                        tabIndex={0}
                        title={t("collapsibleText.openPathTip", { raw: p.raw })}
                        data-tooltip-id="md-tip"
                        data-tooltip-content={t("collapsibleText.previewPathTip", { raw: p.raw })}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPath(p.path, p.line); expand(); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onPath(p.path, p.line); expand(); } }}
                      >
                        {p.raw}
                      </span>
                    )
                  )}
                </div>
              );
            })}
          </pre>
          <button
            className="ctext-preview-divider"
            type="button"
            onClick={(e) => { e.stopPropagation(); expand(); }}
          >
            {t("collapsibleText.collapsePreviewDivider", { note: preview.note })}
          </button>
          {preview.tail.length > 0 && (
            <pre className="ctext-preview-pre">
              {preview.tail.map((l, i) => {
                const tailIdx = lines.length - preview.tail.length + i;
                const cls = lineClassName ? `ctext-preview-line ${lineClassName(l, tailIdx)}` : "ctext-preview-line";
                if (!onPath) return <div key={i} className={cls}>{l || " "}</div>;
                const parts = splitByPaths(l);
                if (parts.length === 1 && parts[0].type === "text") return <div key={i} className={cls}>{l || " "}</div>;
                return (
                  <div key={i} className={cls}>
                    {parts.map((p, pi) =>
                      p.type === "text" ? (
                        <Fragment key={pi}>{p.text}</Fragment>
                      ) : (
                        <span
                          key={pi}
                          className="path-link"
                          role="button"
                          tabIndex={0}
                          title={t("collapsibleText.openPathTip", { raw: p.raw })}
                          data-tooltip-id="md-tip"
                          data-tooltip-content={t("collapsibleText.previewPathTip", { raw: p.raw })}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPath(p.path, p.line); expand(); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onPath(p.path, p.line); expand(); } }}
                        >
                          {p.raw}
                        </span>
                      )
                    )}
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      ) : (
        <pre className={`ctext-pre ${preClassName}`}>{renderPreBody ?? text}</pre>
      )}
    </div>
  );
}
