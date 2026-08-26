// mermaidExport.test.ts(issue #86):hermetic bun tests for the copy-as-image
// pipeline. Covers the pure parts — svgNaturalSize / buildStandaloneSvg
// (parse + style inlining + dimension pinning) and the clipboard/download
// branching of copyImageWithClipboardFallback. The canvas rasterization itself
// needs a real engine (WKWebView/Chromium) and is verified in the desktop app.

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { Window } from "happy-dom";

// ---- happy-dom setup (same recipe as MermaidRenderer.mount.test) ----
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.Node = window.Node;
globalThis.DOMParser = window.DOMParser;
globalThis.XMLSerializer = window.XMLSerializer;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);

// Mock ./download so the fallback path is observable without real file writes.
const downloadBlobMock = mock(() => {});
mock.module("./download.ts", () => ({
  downloadBlob: downloadBlobMock,
  downloadText: () => {},
}));

// Import AFTER the download mock is registered.
const {
  svgNaturalSize,
  buildStandaloneSvg,
  copyImageWithClipboardFallback,
} = await import("./mermaidExport.ts");

// ---- clipboard shims ----
type FakeClipboardItemCtor = new (items: Record<string, unknown>) => { items: Record<string, unknown> };
let savedClipboardItem: unknown;
let savedClipboard: unknown;

function installClipboard({ write }: { write?: (items: unknown[]) => Promise<void> }) {
  savedClipboardItem = (globalThis as any).ClipboardItem;
  savedClipboard = (navigator as any).clipboard;
  if (write) {
    (globalThis as any).ClipboardItem = class {
      items: Record<string, unknown>;
      constructor(items: Record<string, unknown>) {
        this.items = items;
      }
    } as FakeClipboardItemCtor;
    Object.defineProperty(navigator, "clipboard", {
      value: { write },
      configurable: true,
    });
  }
}

function restoreClipboard() {
  if (savedClipboardItem === undefined) delete (globalThis as any).ClipboardItem;
  else (globalThis as any).ClipboardItem = savedClipboardItem;
  if (savedClipboard === undefined) {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  } else {
    Object.defineProperty(navigator, "clipboard", { value: savedClipboard, configurable: true });
  }
}

const pngBlob = () => new Blob(["png-bytes"], { type: "image/png" });

beforeEach(() => {
  downloadBlobMock.mockClear();
});
afterEach(() => {
  restoreClipboard();
});

// ---- svgNaturalSize ----

describe("svgNaturalSize", () => {
  const el = (attrs: string) => {
    const host = document.createElement("div");
    host.innerHTML = `<svg ${attrs}></svg>`;
    return host.querySelector("svg") as unknown as SVGSVGElement;
  };

  test("viewBox attribute wins over width/height attributes", () => {
    const size = svgNaturalSize(el('viewBox="0 0 640 480" width="100%" height="200"'));
    expect(size).toEqual({ width: 640, height: 480 });
  });

  test("falls back to px width/height when no viewBox", () => {
    const size = svgNaturalSize(el('width="320" height="240"'));
    expect(size).toEqual({ width: 320, height: 240 });
  });

  test("percentage / garbage sizes → null", () => {
    expect(svgNaturalSize(el('width="100%" height="100%"'))).toBeNull();
    expect(svgNaturalSize(el(""))).toBeNull();
  });
});

// ---- buildStandaloneSvg ----

describe("buildStandaloneSvg", () => {
  const validSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="100%" style="max-width: 400px;"><g><rect width="10" height="10"/></g></svg>`;

  test("pins explicit pixel dimensions + xmlns, drops fit styles", () => {
    const out = buildStandaloneSvg(validSvg);
    expect(out).not.toBeNull();
    expect(out!.width).toBe(400);
    expect(out!.height).toBe(300);
    expect(out!.svg).toContain('width="400"');
    expect(out!.svg).toContain('height="300"');
    expect(out!.svg).not.toContain("max-width");
  });

  test("inlines computed paint styles onto elements", () => {
    const real = globalThis.getComputedStyle;
    // Fake computed styles: every element reports a known fill + font-family.
    (globalThis as any).getComputedStyle = () => ({
      getPropertyValue: (p: string) =>
        p === "fill" ? "rgb(64, 64, 68)" : p === "font-family" ? "system-ui" : "",
    });
    try {
      const out = buildStandaloneSvg(validSvg);
      expect(out).not.toBeNull();
      expect(out!.svg).toContain("fill:");
      expect(out!.svg).toContain("rgb(64, 64, 68)");
      expect(out!.svg).toContain("font-family:");
    } finally {
      (globalThis as any).getComputedStyle = real;
    }
  });

  test("non-SVG or unsized input → null", () => {
    expect(buildStandaloneSvg("<div>not svg</div>")).toBeNull();
    expect(buildStandaloneSvg("<svg></svg>")).toBeNull();
    expect(buildStandaloneSvg("")).toBeNull();
  });
});

// ---- copyImageWithClipboardFallback(分流:ClipboardItem → 下载降级)----

describe("copyImageWithClipboardFallback", () => {
  test("clipboard.write succeeds → copied, and ClipboardItem receives the promise (Safari gesture pattern)", async () => {
    const seen: { items?: Record<string, unknown> }[] = [];
    installClipboard({
      write: async (items) => {
        seen.push(...(items as { items?: Record<string, unknown> }[]));
      },
    });
    const blob = pngBlob();
    const res = await copyImageWithClipboardFallback(Promise.resolve(blob));
    expect(res).toBe("copied");
    expect(seen.length).toBe(1);
    // The promise itself must be handed over, not a resolved blob: Safari
    // requires ClipboardItem construction inside the user gesture.
    expect((seen[0].items?.["image/png"] as { then?: unknown })?.then).toBeDefined();
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  test("clipboard.write rejects → falls back to download", async () => {
    installClipboard({
      write: async () => {
        throw new Error("NotAllowedError");
      },
    });
    const blob = pngBlob();
    const res = await copyImageWithClipboardFallback(Promise.resolve(blob));
    expect(res).toBe("downloaded");
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    const [dlBlob, filename] = downloadBlobMock.mock.calls[0] as [Blob, string];
    expect(dlBlob).toBe(blob);
    expect(filename).toMatch(/^mermaid-\d{8}-\d{6}\.png$/);
  });

  test("no ClipboardItem API (Firefox) → straight to download", async () => {
    installClipboard({ write: undefined });
    const blob = pngBlob();
    const res = await copyImageWithClipboardFallback(Promise.resolve(blob));
    expect(res).toBe("downloaded");
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
  });

  test("rasterization promise rejects + no clipboard → failed, no download", async () => {
    installClipboard({ write: undefined });
    const res = await copyImageWithClipboardFallback(Promise.reject(new Error("decode failed")));
    expect(res).toBe("failed");
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  test("clipboard.write rejects AND promise rejects → failed", async () => {
    installClipboard({
      write: async () => {
        throw new Error("NotAllowedError");
      },
    });
    const res = await copyImageWithClipboardFallback(Promise.reject(new Error("decode failed")));
    expect(res).toBe("failed");
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  test("accepts a plain Blob too (non-promise)", async () => {
    installClipboard({ write: undefined });
    const res = await copyImageWithClipboardFallback(pngBlob());
    expect(res).toBe("downloaded");
    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
  });
});
