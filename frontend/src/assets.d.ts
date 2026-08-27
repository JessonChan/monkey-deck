// Ambient module declarations for non-TS assets loaded through dynamic import.
//
// Why only this specifier: TS bundler-resolution skips validation of plain
// side-effect `.css` imports, but a DYNAMIC `import()` must resolve the module
// for its expression type. Vite handles the real loading/code-splitting (see
// lib/katexRenderer.ts), so an empty declaration models reality.
declare module "katex/dist/katex.min.css";
