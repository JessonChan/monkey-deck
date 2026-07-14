// diff 文本染色工具(Task #15088 抽取,供 ChatView 编辑卡片 + GitPanel diff 阅读器共用)。
// 规则:首字符判定 +/-/@@ → 增/删/hunk,其余为上下文行;与 unified diff 前缀约定一致。

// 统计 diff 文本里的增删行数(以「+」「-」开头,但忽略「+++」「---」文件头)。
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

// diff 行 className:可直接作为 CollapsibleText.lineClassName 传参(签名兼容 idx)。
export function diffLineCls(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line diff-hunk";
  if (line.startsWith("@@")) return "diff-line diff-hunk";
  if (line.startsWith("+")) return "diff-line diff-add";
  if (line.startsWith("-")) return "diff-line diff-del";
  return "diff-line";
}
