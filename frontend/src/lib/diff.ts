// diff text helpers (Task #15088). countDiffLines powers the +N / −N stat badges in
// GitPanel and ChatView edit cards. Line-by-line prefix coloring (diffLineCls) was
// removed when diff rendering moved to react-diff-viewer-continued (real LCS diff).

// Count added/removed lines in a unified diff (lines starting with +/-, ignoring
// the +++/--- file headers). Used for stat badges — lighter than running a full diff.
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
