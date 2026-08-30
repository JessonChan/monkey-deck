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
  if (key === "chat.emptyValue") return "(空)";
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

test("⑧ nested record → └─ tree, never JSON.stringify (#169)", () => {
  const out = summarizeToolPayload({ changes: { file: "a.go", lines: [1, 2] } }, t)!;
  expect(out.summary).toBe("changes:\n  └─ file: a.go\n  └─ lines:\n    └─ 1\n    └─ 2");
  expect(out.summary).not.toContain("{");
});

test("formatHuman on nested shapes contains no JSON braces", () => {
  // #169: formatHuman renders nested shapes as an indented └─ tree now.
  expect(formatHuman({ a: { b: { c: 1 } }, d: [{ e: "x" }] })).toBe(
    "a:\n  └─ b:\n    └─ c: 1\nd:\n  └─ e: x"
  );
  expect(formatHuman({ a: { b: { c: 1 } }, d: [{ e: "x" }] })).not.toContain("{");
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

// --- #169 tree rendering: depth cap / cycles / line clip / big arrays ---

test("#169 subtree past depth 4 flattens to one formatInline line", () => {
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: "deep" } } } } } };
  const out = formatHuman(deep, t);
  expect(out).toBe("l1:\n  └─ l2:\n    └─ l3:\n      └─ l4:\n        └─ l5: l6: deep");
  expect(out).not.toContain("{");
});

test("#169 reference cycles render ↻ instead of recursing forever", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  const out = formatHuman(a, t);
  expect(out).toContain("↻");
  expect(out).toContain("name: a");

  const arr: unknown[] = ["x"];
  arr.push(arr);
  expect(formatHuman(arr, t)).toBe("x\n↻");

  // formatInline guards too (preview / depth-flatten paths share it).
  const n: Record<string, unknown> = {};
  n.loop = n;
  expect(formatInline(n)).toBe("loop: ↻");
});

test("#169 tree leaf lines clip at 200 chars, shared with the preview cap", () => {
  const out = formatHuman({ key: "x".repeat(500) }, t);
  const line = out.split("\n")[0];
  expect(line!.length).toBe(200);
  expect(line!.endsWith("…")).toBe(true);
  // A root string payload is the output body itself, not a tree line: verbatim.
  expect(formatHuman("y".repeat(500))).toBe("y".repeat(500));
});

test("#169 arrays over 8 items show first 3 plus an N-more tail", () => {
  const items = Array.from({ length: 12 }, (_, i) => `item${i}`);
  // Root-level items are the tree's top lines: bare, like flat records.
  expect(formatHuman(items, t)).toBe("item0\nitem1\nitem2\n…另有 9 项");
  // ≤8 stays full: no tail.
  expect(formatHuman(["a", "b"], t)).toBe("a\nb");
  // Nested under a key the items gain one └─ level.
  expect(formatHuman({ files: items }, t)).toBe(
    "files:\n  └─ item0\n  └─ item1\n  └─ item2\n  └─ …另有 9 项"
  );
});

test("#169 empty nodes render the chat.emptyValue word", () => {
  expect(formatHuman({ a: null, b: "", c: {}, d: [] }, t)).toBe("a: (空)\nb: (空)\nc: (空)\nd: (空)");
  // Top-level empty containers stay "" — the summarizer's open-form gate
  // (NO_STRUCTURE for bare {}/[]) depends on the falsy result.
  expect(formatHuman({})).toBe("");
  expect(formatHuman([])).toBe("");
});
