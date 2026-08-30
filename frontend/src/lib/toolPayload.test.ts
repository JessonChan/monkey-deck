// toolPayload.test.ts: fallback-payload summarizer regression (issue #109).
// bun test 运行。锁定不变量:fallback 链任何路径都不得产出 JSON 字符串;
// 六类形态各归其位(content join / 数组计数 / 路径行 / 集合字段 / title+url /
// 布尔成败),开放形态返 {summary:null, hadStructure:false} 交调用方兜底。

import { test, expect } from "bun:test";
import { formatHuman, formatInline, summarizeToolPayload, type TranslateFn } from "./toolPayload";

// t() stub: mirrors zh locale copy for the summary keys.
const t: TranslateFn = (key, opts) => {
  if (key === "chat.itemsTotal") return `共 ${opts?.count} 项`;
  if (key === "chat.itemsMore") return `…另有 ${opts?.count} 项`;
  if (key === "chat.toolSucceeded") return "成功";
  if (key === "chat.toolFailed") return "失败";
  return key;
};

// --- ① content-block arrays ([{type:"text",text:…}]) → text join ---

test("① text-block array joins text parts, before the count branch", () => {
  const out = summarizeToolPayload(
    [{ type: "text", text: "Hello" }, { type: "text", text: "World" }],
    t
  );
  expect(out.summary).toBe("Hello\nWorld");
  expect(out.hadStructure).toBe(true);
});

test("① MCP record {content:[text blocks]} joins too", () => {
  const out = summarizeToolPayload(
    { content: [{ type: "text", text: "mcp result line" }], isError: false },
    t
  );
  expect(out.summary).toBe("mcp result line");
  expect(out.hadStructure).toBe(true);
});

test("① mixed blocks (image among text) fall through to count+preview, no JSON", () => {
  const out = summarizeToolPayload(
    [{ type: "text", text: "hi" }, { type: "image", source: {} }],
    t
  )!;
  expect(out.summary).toContain("共 2 项");
  expect(out.summary).not.toContain("{");
  expect(out.hadStructure).toBe(true);
});

// --- ②③ generic arrays: count+preview / path-led verbatim ---

test("② scalar array → count header + first 3 previews + more tail", () => {
  const out = summarizeToolPayload(["alpha", "beta", "gamma", "delta", "epsilon"], t);
  expect(out.summary).toBe("共 5 项\n- alpha\n- beta\n- gamma\n…另有 2 项");
  expect(out.hadStructure).toBe(true);
});

test("② array of records → previews flattened to key: value, no JSON", () => {
  const out = summarizeToolPayload([{ path: "a.go", line: 1 }, { path: "b.go", line: 2 }], t)!;
  expect(out.summary).toBe("共 2 项\n- path: a.go, line: 1\n- path: b.go, line: 2");
  expect(out.summary).not.toContain("{");
});

test("③ path-led string array → verbatim lines, no count header", () => {
  const out = summarizeToolPayload(["/src/a.go", "/src/b/c.ts"], t);
  expect(out.summary).toBe("/src/a.go\n/src/b/c.ts");
});

test("③ grep-style path:line:content array → verbatim lines", () => {
  const items = ["src/a.go:12: fn()", "src/b.go:3: var x"];
  const out = summarizeToolPayload(items, t);
  expect(out.summary).toBe(items.join("\n"));
});

// --- ④ record with a dominant array field ---

test("④ record with matches array → same as array summary", () => {
  const out = summarizeToolPayload({ matches: ["x.go", "y.go"], total: 2 }, t);
  expect(out.summary).toBe("共 2 项\n- x.go\n- y.go");
});

// --- ⑤ path + body record ---

test("⑤ path + content record → path on first line, body verbatim", () => {
  const out = summarizeToolPayload({ path: "/x/a.go", content: "fn() {}\nreturn\n" }, t);
  expect(out.summary).toBe("/x/a.go\nfn() {}\nreturn\n");
});

// --- ⑥ url+title record ---

test("⑥ url + title → title line first, url second", () => {
  const out = summarizeToolPayload(
    { url: "https://example.com", title: "Example Domain", fetchedAt: 1 },
    t
  );
  expect(out.summary).toBe("Example Domain\nhttps://example.com");
  expect(out.hadStructure).toBe(true);
});

test("⑥ url without title → url alone; title without url → title alone", () => {
  expect(summarizeToolPayload({ url: "https://x.dev" }, t).summary).toBe("https://x.dev");
  expect(summarizeToolPayload({ title: "Report" }, t).summary).toBe("Report");
});

// --- ⑦ ok/success boolean → success/failure word ---

test("⑦ ok/success booleans map to the words via t()", () => {
  expect(summarizeToolPayload({ ok: true }, t).summary).toBe("成功");
  expect(summarizeToolPayload({ success: false }, t).summary).toBe("失败");
  expect(summarizeToolPayload({ ok: false, error: "boom" }, t).summary).toBe("失败");
  expect(summarizeToolPayload({ ok: true }, t).hadStructure).toBe(true);
});

// --- ⑧ flat / nested records ---

test("⑧ flat record → key: value lines", () => {
  const out = summarizeToolPayload({ status: "ok", count: 3 }, t);
  expect(out.summary).toBe("status: ok\ncount: 3");
});

test("⑧ nested record → recursive flattening, never JSON.stringify", () => {
  const out = summarizeToolPayload({ changes: { file: "a.go", lines: [1, 2] } }, t)!;
  expect(out.summary).toBe("changes: file: a.go, lines: 1, 2");
  expect(out.summary).not.toContain("{");
});

test("formatHuman on nested shapes contains no JSON braces", () => {
  expect(formatHuman({ a: { b: { c: 1 } }, d: [{ e: "x" }] })).toBe("a: b: c: 1\nd: e: x");
  expect(formatInline({ deep: { deeper: [1, { k: "v" }] } })).toBe("deep: deeper: 1, k: v");
});

// --- open forms: no structure recognized → caller keeps last resort ---

test("primitives / empty shapes → {summary:null, hadStructure:false}", () => {
  for (const raw of ["plain string", 42, null, [], {}, true]) {
    expect(summarizeToolPayload(raw, t)).toEqual({ summary: null, hadStructure: false });
  }
});

test("preview lines clip at 200 chars with ellipsis", () => {
  const long = "x".repeat(500);
  const out = summarizeToolPayload([long], t)!;
  const line = out.summary!.split("\n")[1];
  expect(line!.startsWith("- ")).toBe(true);
  expect(line!.length).toBeLessThanOrEqual(3 + 200);
  expect(line!.endsWith("…")).toBe(true);
});
