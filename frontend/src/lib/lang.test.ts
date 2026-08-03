// Pin detectDiffLanguage's passthrough behavior. The original `return mapped`
// dropped every language NOT listed in HLJS_TO_REFRACTOR — so go/python/rust/js/ts
// (all refractor-supported, all unlisted) silently lost syntax highlighting. After
// the fix, only explicit `undefined` entries drop; unlisted names pass through.
import { describe, test, expect } from "bun:test";
import { detectDiffLanguage } from "./lang";

describe("detectDiffLanguage", () => {
  test("listed remap entries use the mapped refractor name", () => {
    expect(detectDiffLanguage("a.xml")).toBe("markup");
    expect(detectDiffLanguage("c.tsx")).toBe("typescript");
    expect(detectDiffLanguage("s.sass")).toBe("scss");
  });

  test("listed drop entries (refractor-unsupported) return undefined", () => {
    expect(detectDiffLanguage("a.proto")).toBeUndefined();
    expect(detectDiffLanguage("b.gradle")).toBeUndefined();
    expect(detectDiffLanguage("m.ex")).toBeUndefined();
  });

  test("unlisted languages pass through under their hljs name (the regression)", () => {
    // Before the fix these all returned undefined; they must now pass through so
    // react-diff-viewer-continued can lazy-load the matching Prism grammar.
    expect(detectDiffLanguage("main.go")).toBe("go");
    expect(detectDiffLanguage("app.py")).toBe("python");
    expect(detectDiffLanguage("lib.rs")).toBe("rust");
    expect(detectDiffLanguage("index.js")).toBe("javascript");
    expect(detectDiffLanguage("App.ts")).toBe("typescript");
  });
});
