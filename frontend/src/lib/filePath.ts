// 对话文本里的文件路径识别(Task #15084 / AGENTS.md §4.4)。
//
// 把 src/foo.ts、./bar.go:10、../pkg/x.py:42:3、/abs/path.ts 等识别成可点击项,
// 点击在文件面板预览 / 定位行号。仅识别「明显的文件路径」,避免误伤普通词。
//
// 识别策略(收敛误伤):
//   1. 末段必须带扩展名(字母开头,后跟字母数字,1-8 位)—— 排除 "src/foo"、"node_modules"。
//   2. 整体必须含 '/'(以前缀 ./ ../ ~// / 或中间段提供)—— 排除裸单词 "foo.ts"、"e.g."。
//   3. 前导边界:前一字符不能是 字母/数字/_/./-///,避免在更长 token 中部截断匹配
//      (同时自然跳过 http(s):// —— 协议段后的 '/' 会作为前导边界阻断)。
//   4. 后继边界:下一字符不能是 字母/数字/_//,避免吞掉更长路径 / 扩展名。
//
// 纯逻辑(无 React 依赖),便于 bun test 单测。

export interface PathSpan {
  start: number; // 原文起始下标(含前导 @ when isMention)
  end: number; // 终止下标(不含)
  raw: string; // 原文整段(含前导 @ + :line when present)
  path: string; // 纯路径(不含前导 @、不含 :line)
  line?: number; // 可选行号
  isMention?: boolean; // 前导 @ 触发的 mention(Task #118b):渲染走 @basename 分支
}

export type TextPart =
  | { type: "text"; text: string }
  | { type: "path"; raw: string; path: string; line?: number; isMention?: boolean };

// 路径主体:可选前缀(./ ../ / ~/)+ 段(至少一段)+ 末段扩展名,后接可选 :line[:col]。
// group1 = path,group2 = line。
const PATH_RE =
  /(?<![\w./-])((?:\.\.\/|\.\/|\/|~\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d{1,6})(?::\d{1,6})?)?(?![\w/])/g;

export function findPathSpans(text: string): PathSpan[] {
  const spans: PathSpan[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    const path = m[1];
    // 必须含 '/',排除裸单词(如 foo.ts、e.g.)。
    if (!path.includes("/")) continue;
    const line = m[2] ? parseInt(m[2], 10) : undefined;
    const matchStart = m.index;
    // @mention detection (Task #118b): a '@' immediately precedes the path and sits at a
    // token boundary (start-of-text or after a non-word, non-'@' char). The composer inserts
    // @<path> tokens; we consume the '@' into the span so the whole @basename renders as one
    // clickable unit (full path stays in tooltip + click target).
    const at = matchStart - 1;
    const isMention =
      at >= 0 && text[at] === "@" && (at === 0 || !/[\w@]/.test(text[at - 1]));
    spans.push({
      start: isMention ? at : matchStart,
      end: matchStart + m[0].length,
      raw: isMention ? "@" + m[0] : m[0],
      path,
      line,
      // Only carry the flag when true so non-mention spans stay shape-stable
      // (legacy callers / toEqual against {start,end,raw,path,line} still pass).
      ...(isMention ? { isMention: true } : {}),
    });
  }
  return spans;
}

export function splitByPaths(text: string): TextPart[] {
  const spans = findPathSpans(text);
  if (spans.length === 0) return [{ type: "text", text }];
  const parts: TextPart[] = [];
  let last = 0;
  for (const s of spans) {
    if (s.start > last) parts.push({ type: "text", text: text.slice(last, s.start) });
    parts.push({
      type: "path",
      raw: s.raw,
      path: s.path,
      line: s.line,
      // Only carry the flag when true so non-mention parts stay shape-stable
      // (toEqual against the legacy {type,raw,path,line} form still passes).
      ...(s.isMention ? { isMention: true } : {}),
    });
    last = s.end;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

// Inline display label for a path part (Task #118b). @mentions collapse to @basename
// (full path lives in tooltip + click target, mirroring the composer mention chip);
// regular paths show raw as before. Pure, tested — shared by PathLinkified & CollapsibleText.
export function pathPartLabel(part: {
  isMention?: boolean;
  path: string;
  line?: number;
  raw: string;
}): string {
  if (part.isMention) {
    const i = part.path.lastIndexOf("/");
    const base = i === -1 ? part.path : part.path.slice(i + 1);
    return "@" + base + (part.line ? `:${part.line}` : "");
  }
  return part.raw;
}
