// dropFiles.test.ts:routing of dropped OS file paths (Task #24255). bun test.

import { test, expect } from "bun:test";
import { relativeToRoot, routeDroppedFiles, type ReadImageFn } from "./dropFiles";

const ROOT = "/Users/me/proj";

test("relativeToRoot: inside → relative path", () => {
  expect(relativeToRoot(ROOT, "/Users/me/proj/src/a.ts")).toBe("src/a.ts");
});

test("relativeToRoot: nested dir inside", () => {
  expect(relativeToRoot(ROOT, "/Users/me/proj/a/b/c.txt")).toBe("a/b/c.txt");
});

test("relativeToRoot: the root itself → empty string", () => {
  expect(relativeToRoot(ROOT, ROOT)).toBe("");
  expect(relativeToRoot(ROOT, ROOT + "/")).toBe("");
});

test("relativeToRoot: outside → null", () => {
  expect(relativeToRoot(ROOT, "/Users/other/x.ts")).toBeNull();
  expect(relativeToRoot(ROOT, "/Users/me/project-x/a.ts")).toBeNull(); // sibling prefix, not a child
});

test("relativeToRoot: rejects ../ escapes (prefix must be a full segment)", () => {
  // "/Users/me/proj-evil" shares a substring prefix but is NOT a child of ROOT.
  expect(relativeToRoot(ROOT, "/Users/me/proj-evil/x.ts")).toBeNull();
});

test("relativeToRoot: backslash / trailing-slash tolerant", () => {
  expect(relativeToRoot("C:\\dev\\proj", "C:\\dev\\proj\\src\\a.ts")).toBe("src/a.ts");
  expect(relativeToRoot(ROOT + "/", "/Users/me/proj/src/a.ts")).toBe("src/a.ts");
});

test("relativeToRoot: case-insensitive (drive-letter / HFS+ tolerance)", () => {
  expect(relativeToRoot("C:/Dev/Proj", "c:/dev/proj/x.ts")).toBe("x.ts");
});

const noImages: ReadImageFn = async () => ({ dataUrl: "" });

test("external files → attachments (absolute paths)", async () => {
  const r = await routeDroppedFiles(["/etc/hosts", "/tmp/x.txt"], { root: ROOT, imageSupported: false, sessionId: "s1" }, noImages);
  expect(r.attachments).toEqual(["/etc/hosts", "/tmp/x.txt"]);
  expect(r.mentions).toEqual([]);
  expect(r.images).toEqual([]);
  expect(r.mentionText).toBe("");
});

test("internal non-image → @mention with relative path + draft token", async () => {
  const r = await routeDroppedFiles([ROOT + "/src/a.ts"], { root: ROOT, imageSupported: false, sessionId: "s1" }, noImages);
  expect(r.mentions).toEqual([{ path: "src/a.ts", name: "a.ts" }]);
  expect(r.mentionText).toBe("@src/a.ts ");
  expect(r.attachments).toEqual([]);
});

test("internal image + imageSupported → inline image (read via readImage)", async () => {
  const read: ReadImageFn = async () => ({ dataUrl: "data:image/png;base64,QkFEBg==" });
  const r = await routeDroppedFiles([ROOT + "/img/diagram.png"], { root: ROOT, imageSupported: true, sessionId: "s1" }, read);
  expect(r.images).toEqual([{ name: "diagram.png", data: "QkFEBg==", mimeType: "image/png" }]);
  expect(r.mentions).toEqual([]);
});

test("internal image but agent !imageSupported → falls back to @mention", async () => {
  const r = await routeDroppedFiles([ROOT + "/img/diagram.png"], { root: ROOT, imageSupported: false, sessionId: "s1" }, noImages);
  expect(r.mentions).toEqual([{ path: "img/diagram.png", name: "diagram.png" }]);
  expect(r.images).toEqual([]);
});

test("internal image read fails (too big / not image) → falls back to @mention", async () => {
  const read: ReadImageFn = async () => { throw new Error("too big"); };
  const r = await routeDroppedFiles([ROOT + "/img/big.png"], { root: ROOT, imageSupported: true, sessionId: "s1" }, read);
  expect(r.mentions).toEqual([{ path: "img/big.png", name: "big.png" }]);
  expect(r.images).toEqual([]);
});

test("non-ACP image ext (bmp/svg/ico) → @mention even when imageSupported", async () => {
  const r = await routeDroppedFiles([ROOT + "/a.bmp", ROOT + "/b.svg"], { root: ROOT, imageSupported: true, sessionId: "s1" }, noImages);
  expect(r.mentions).toEqual([
    { path: "a.bmp", name: "a.bmp" },
    { path: "b.svg", name: "b.svg" },
  ]);
  expect(r.images).toEqual([]);
});

test("root dir itself dropped → skipped (no @. token, no attachment)", async () => {
  const r = await routeDroppedFiles([ROOT], { root: ROOT, imageSupported: true, sessionId: "s1" }, noImages);
  expect(r.mentions).toEqual([]);
  expect(r.attachments).toEqual([]);
  expect(r.images).toEqual([]);
});

test("mixed batch: internal file + internal image + external → split across all three", async () => {
  const read: ReadImageFn = async (_sid, rel) => rel === "shot.png" ? { dataUrl: "data:image/png;base64,QUFB" } : { dataUrl: "" };
  const files = [ROOT + "/src/a.ts", ROOT + "/shot.png", "/tmp/external.log"];
  const r = await routeDroppedFiles(files, { root: ROOT, imageSupported: true, sessionId: "s1" }, read);
  expect(r.mentions).toEqual([{ path: "src/a.ts", name: "a.ts" }]);
  expect(r.mentionText).toBe("@src/a.ts ");
  expect(r.images).toEqual([{ name: "shot.png", data: "QUFB", mimeType: "image/png" }]);
  expect(r.attachments).toEqual(["/tmp/external.log"]);
});

test("preserves order within each category (stable per-file routing)", async () => {
  const files = [ROOT + "/a.ts", ROOT + "/b.ts", "/ext/1.log", "/ext/2.log"];
  const r = await routeDroppedFiles(files, { root: ROOT, imageSupported: false, sessionId: "s1" }, noImages);
  expect(r.mentions.map((m) => m.path)).toEqual(["a.ts", "b.ts"]);
  expect(r.attachments).toEqual(["/ext/1.log", "/ext/2.log"]);
});
