// MathInline / MathBlock (#135): React view over lib/katexRenderer.
//
// Integration shape (see ChatView wiring): remark-math turns `$...$` into a
// <code.language-math.math-inline> hast node and `$$...$$` / ```math fences into
// a <pre><code.language-math.math-display> — ChatView's CodeRenderer routes the
// former here and PreRenderer the latter.
//
// Behavior contract:
// - Rendered KaTeX HTML arrives ASYNCHRONOUSLY on the very first formula ever
//   encountered app-wide (lazy chunk). Until it resolves — and whenever rendering
//   fails — the raw LaTeX source is shown instead, so streaming messages read
//   naturally while typing and degrade gracefully offline.
// - Cache hits paint synchronously on mount (no idle→rendered flash), mirroring
//   MermaidRenderer's getCachedSvg usage.
// - No explicit error copy: KaTeX itself highlights invalid TeX via .katex-error,
//   and loader failure is a transient infrastructure condition — both fall back
//   to quiet source display rather than alarm rows.

import { useEffect, useState } from "react";
import { getCachedKatexHtml, renderKatex } from "../lib/katexRenderer";

// Shared async glue: returns rendered HTML once available, else null
// (= show raw source). Re-runs per source/display change so streaming appends
// re-enter the pipeline and cache hits short-circuit synchronously.
function useKatexHtml(source: string, displayMode: boolean): string | null {
  const [html, setHtml] = useState<string | null>(() => getCachedKatexHtml(source, displayMode) ?? null);
  useEffect(() => {
    const cached = getCachedKatexHtml(source, displayMode);
    if (cached) {
      setHtml(cached);
      return;
    }
    let alive = true;
    setHtml(null);
    void renderKatex(source, displayMode).then((result) => {
      if (alive && result.ok) setHtml(result.html);
    });
    return () => {
      alive = false;
    };
  }, [source, displayMode]);
  return html;
}

// Inline `$...$` formula: flows inside paragraph text, no own scroll container.
export function MathInline({ code }: { code: string }) {
  const html = useKatexHtml(code, false);
  if (!html) return <code className="md-math-src">{code}</code>;
  // Safe to inject: katex renders untrusted input to inert HTML (trust:false),
  // see lib/katexRenderer.ts trust-boundary note.
  return <span className="md-math-inline" data-testid="math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Display formula: `$$\n...\n$$` blocks AND ```math fences converge here.
// Wrapped like .md-table-wrap (#136) so wide/tall formulas scroll horizontally
// inside the bubble instead of stretching the chat column.
export function MathBlock({ code }: { code: string }) {
  const html = useKatexHtml(code, true);
  return (
    <div className={`md-math-block${html ? "" : " is-source"}`} data-testid="math-block">
      {html ? (
        <div className="md-math-body" data-testid="math-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-math-src">{code}</pre>
      )}
    </div>
  );
}
