// filePath.test.ts:回归文件路径识别(Task #15084)。bun test 运行。

import { test, expect } from "bun:test";
import { findPathSpans, pathPartLabel, splitByPaths } from "./filePath";

const paths = (text: string) =>
  findPathSpans(text).map((s) => ({ raw: s.raw, path: s.path, line: s.line, isMention: s.isMention }));

test("识别相对路径 + 扩展名", () => {
  expect(paths("看 src/foo.ts 这个文件")).toEqual([
    { raw: "src/foo.ts", path: "src/foo.ts", line: undefined },
  ]);
});

test("识别 path:line", () => {
  expect(paths("在 src/foo.ts:42 有问题")).toEqual([
    { raw: "src/foo.ts:42", path: "src/foo.ts", line: 42 },
  ]);
});

test("识别 ./ 与 ../ 前缀(单段路径)", () => {
  expect(paths("./bar.go:10")).toEqual([
    { raw: "./bar.go:10", path: "./bar.go", line: 10 },
  ]);
  expect(paths("../pkg/x.py:42:3")).toEqual([
    { raw: "../pkg/x.py:42:3", path: "../pkg/x.py", line: 42 },
  ]);
});

test("识别绝对路径", () => {
  expect(paths("/abs/path/to/file.ts")).toEqual([
    { raw: "/abs/path/to/file.ts", path: "/abs/path/to/file.ts", line: undefined },
  ]);
});

test("识别多行 / 多路径", () => {
  const out = paths("改 src/a.ts:1 和 ./b.go:2");
  expect(out).toEqual([
    { raw: "src/a.ts:1", path: "src/a.ts", line: 1 },
    { raw: "./b.go:2", path: "./b.go", line: 2 },
  ]);
});

test("不误伤裸单词(无路径分隔符)", () => {
  expect(paths("see foo.ts and e.g. something")).toEqual([]);
});

test("不误伤无扩展名的路径", () => {
  expect(paths("run src/utils and node_modules")).toEqual([]);
});

test("不误伤 http(s) URL", () => {
  expect(paths("see https://example.com/a.ts and http://x.io/y.py")).toEqual([]);
});

test("不误伤版本号 / 数字串", () => {
  expect(paths("upgrade to v1.2.3 or 0.0.1")).toEqual([]);
});

test("行末标点不吞入", () => {
  expect(paths("edit src/foo.ts, then src/bar.ts.")).toEqual([
    { raw: "src/foo.ts", path: "src/foo.ts", line: undefined },
    { raw: "src/bar.ts", path: "src/bar.ts", line: undefined },
  ]);
});

test("splitByPaths:文本段 + 路径段交错", () => {
  expect(splitByPaths("a src/foo.ts:3 b")).toEqual([
    { type: "text", text: "a " },
    { type: "path", raw: "src/foo.ts:3", path: "src/foo.ts", line: 3 },
    { type: "text", text: " b" },
  ]);
});

test("splitByPaths:无路径时单个文本段", () => {
  expect(splitByPaths("nothing here")).toEqual([{ type: "text", text: "nothing here" }]);
});

test("扩展名边界:src/foo.tsx 不被截成 .ts", () => {
  expect(paths("src/foo.tsx")).toEqual([
    { raw: "src/foo.tsx", path: "src/foo.tsx", line: undefined, isMention: undefined },
  ]);
});

// ─── @mention 检测(Task #118b):前导 @ → isMention,span 吞掉 @ ───

test("前导 @ 标记为 mention(span 吞 @、raw 含 @、path 干净)", () => {
  expect(paths("改 @src/foo.ts 这个")).toEqual([
    { raw: "@src/foo.ts", path: "src/foo.ts", line: undefined, isMention: true },
  ]);
});

test("mention 带 :line 仍识别(line 透传)", () => {
  expect(paths("看 @src/foo.ts:42")).toEqual([
    { raw: "@src/foo.ts:42", path: "src/foo.ts", line: 42, isMention: true },
  ]);
});

test("文本开头的 @mention(at===0 边界)", () => {
  expect(paths("@a/b.go")).toEqual([
    { raw: "@a/b.go", path: "a/b.go", line: undefined, isMention: true },
  ]);
});

test("无前导 @ 的普通路径不标记 isMention", () => {
  expect(paths("改 src/foo.ts")).toEqual([
    { raw: "src/foo.ts", path: "src/foo.ts", line: undefined, isMention: undefined },
  ]);
});

test("word@path 不当 mention(@ 必须在 token 边界,排除类 email)", () => {
  // a@b/c.ts 里 @ 紧跟 word 字母 → 不算 mention,按普通路径识别。
  expect(paths("a@b/c.ts")).toEqual([
    { raw: "b/c.ts", path: "b/c.ts", line: undefined, isMention: undefined },
  ]);
});

test("splitByPaths:@mention 段 isMention=true、@ 不落入文本段", () => {
  expect(splitByPaths("see @src/foo.ts")).toEqual([
    { type: "text", text: "see " },
    { type: "path", raw: "@src/foo.ts", path: "src/foo.ts", line: undefined, isMention: true },
  ]);
});

test("pathPartLabel:mention 显 @basename、普通路径显 raw", () => {
  expect(pathPartLabel({ path: "src/foo.ts", raw: "@src/foo.ts", isMention: true })).toBe("@foo.ts");
  expect(pathPartLabel({ path: "src/foo.ts", raw: "@src/foo.ts:42", line: 42, isMention: true })).toBe("@foo.ts:42");
  expect(pathPartLabel({ path: "src/foo.ts", raw: "src/foo.ts" })).toBe("src/foo.ts");
  expect(pathPartLabel({ path: "a/b.go", raw: "a/b.go:3", line: 3 })).toBe("a/b.go:3");
});
