// Prism/refractor language detection for react-diff-viewer-continued's diff viewer.
// Separate from lib/highlight.ts (which targets highlight.js) because the two engines
// name languages differently and ship different grammar sets. We map only to the
// languages react-diff-viewer-continued lazily supports (see its LANGUAGE_LOADERS +
// LANGUAGE_ALIASES); unknown extensions return undefined and the viewer falls back to
// no syntax highlighting (graceful — diff coloring still works via word/line diff).
import { detectLanguage as detectHljs } from "./highlight";

// highlight.js language name → refractor/react-diff-viewer-continued canonical key,
// or undefined to intentionally drop the language (no highlighting). Only remap the
// ones that differ; identical names pass through.
const HLJS_TO_REFRACTOR: Record<string, string | undefined> = {
  // highlight.js has no dockerfile in refractor common set; closest is bash.
  dockerfile: "bash",
  // markup covers html/xml/svg/vue.
  xml: "markup",
  // tsx/jsx render as javascript/typescript (refractor common has no TSX grammar).
  tsx: "typescript",
  jsx: "javascript",
  // highlight.js "ini" already matches refractor "ini".
  // protobuf/groovy/elixir/erlang/clojure/haskell/ocaml/nim/elm/fsharp/dart/graphql/sass
  // are NOT in refractor's common set shipped by react-diff-viewer-continued — drop them
  // so the viewer doesn't waste a failed dynamic import.
  protobuf: undefined,
  groovy: undefined,
  elixir: undefined,
  erlang: undefined,
  clojure: undefined,
  haskell: undefined,
  ocaml: undefined,
  nim: undefined,
  elm: undefined,
  fsharp: undefined,
  dart: undefined,
  graphql: undefined,
  sass: "scss",
};

// Resolve a filename (or extension/path) to a react-diff-viewer-continued language key,
// or undefined if unknown. Uses highlight.js's proven extension table, then remaps to
// the refractor canonical names the viewer actually supports.
export function detectDiffLanguage(filename?: string): string | undefined {
  const hl = detectHljs(filename);
  if (!hl) return undefined;
  // Listed languages: use the mapped name, or undefined to intentionally drop
  // (known-unsupported by refractor's common set). Unlisted languages pass through
  // under their hljs name — refractor common covers go/python/rust/js/ts/c/cpp/java/…,
  // so only the explicit `undefined` entries above actually drop.
  if (hl in HLJS_TO_REFRACTOR) return HLJS_TO_REFRACTOR[hl];
  return hl;
}
