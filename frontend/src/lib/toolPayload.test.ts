// toolPayload.test.ts: fallback-payload summarizer regression (issue #109).
// bun test 运行。锁定不变量:fallback 链任何路径都不得产出 JSON 字符串;
// 数组/数组字段给「共 N 项」+前 3 项预览;路径行原样优先;嵌套对象扁平化。

import { test, expect } from "bun:test";
import { formatHuman, formatInline, summarizeToolPayload, type TranslateFn } from "./toolPayload";

// t() stub: mirrors zh locale copy for the two summary keys.
const t: TranslateFn = (key, opts) => {
  if (key === "chat.itemsTotal") return `共 ${opts?.count} 项`;
  if (key === "chat.itemsMore") return `…另有 ${opts?.count} 项`;
  return key;
};

test("① scalar array → count header + first 3 previews + more tail", () => {
  expect(summarizeToolPayload(["alpha", "beta", "gamma", "delta", "epsilon"], t)).toBe(
    "共 5 项\n- alpha\n- beta\n- gamma\n…另有 2 项"
  );
});

test("① array of records → previews flattened to key: value, no JSON", () => {
  const out = summarizeToolPayload([{ path: "a.go", line: 1 }, { path: "b.go", line: 2 }], t)!;
  expect(out).toBe("共 2 项\n- path: a.go, line: 1\n- path: b.go, line: 2");
  expect(out).not.toContain("{");
});

test("② path-led string array → verbatim lines, no count header", () => {
  expect(summarizeToolPayload(["/src/a.go", "/src/b/c.ts"], t)).toBe("/src/a.go\n/src/b/c.ts");
});

test("② grep-style path:line:content array → verbatim lines", () => {
  const items = ["src/a.go:12: fn()", "src/b.go:3: var x"];
  expect(summarizeToolPayload(items, t)).toBe(items.join("\n"));
});

test("③ record with matches array → same as array summary", () => {
  expect(summarizeToolPayload({ matches: ["x.go", "y.go"], total: 2 }, t)).toBe("共 2 项\n- x.go\n- y.go");
});

test("④ path + content record → path on first line, body verbatim", () => {
  expect(summarizeToolPayload({ path: "/x/a.go", content: "fn() {}\nreturn\n" }, t)).toBe("/x/a.go\nfn() {}\nreturn\n");
});

test("⑤ flat record → key: value lines", () => {
  expect(summarizeToolPayload({ status: "ok", count: 3 }, t)).toBe("status: ok\ncount: 3");
});

test("⑥ nested record → recursive flattening, never JSON.stringify", () => {
  const out = summarizeToolPayload({ changes: { file: "a.go", lines: [1, 2] } }, t)!;
  expect(out).toBe("changes: file: a.go, lines: 1, 2");
  expect(out).not.toContain("{");
});

test("formatHuman on nested shapes contains no JSON braces", () => {
  expect(formatHuman({ a: { b: { c: 1 } }, d: [{ e: "x" }] })).toBe("a: b: c: 1\nd: e: x");
  expect(formatInline({ deep: { deeper: [1, { k: "v" }] } })).toBe("deep: deeper: 1, k: v");
});

test("primitives / empty shapes → null (caller keeps last resort)", () => {
  expect(summarizeToolPayload("plain string", t)).toBeNull();
  expect(summarizeToolPayload(42, t)).toBeNull();
  expect(summarizeToolPayload(null, t)).toBeNull();
  expect(summarizeToolPayload([], t)).toBeNull();
  expect(summarizeToolPayload({}, t)).toBeNull();
});

test("preview lines clip at 200 chars with ellipsis", () => {
  const long = "x".repeat(500);
  const out = summarizeToolPayload([long], t)!;
  const line = out.split("\n")[1];
  expect(line!.startsWith("- ")).toBe(true);
  expect(line!.length).toBeLessThanOrEqual(3 + 200);
  expect(line!.endsWith("…")).toBe(true);
});
