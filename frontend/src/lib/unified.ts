// Reconstruct old/new file contents from a unified diff patch text.
// Used to feed git diff output / apply_patch tool output into react-diff-viewer-continued,
// which takes two complete strings (not a patch). Uses the `diff` package's parsePatch
// (already a transitive dep of react-diff-viewer-continued) so we don't hand-roll patch
// parsing — git's dialect (rename/binary/index headers) is handled by parsePatch.
//
// Reconstruction rule (per hunk): context + "-" lines → old side; context + "+" lines →
// new side. We DO NOT try to fill lines outside hunks (no access to the original file
// here); react-diff-viewer-continued's showDiffOnly already folds unchanged context, so
// showing only the changed regions is the honest representation when the full file isn't
// available. Callers that have both old/new strings directly should pass them as-is.
import { parsePatch, type StructuredPatch } from "diff";

export interface UnifiedReconstruction {
  oldStr: string;
  newStr: string;
}

// Parse a unified diff string and reconstruct approximate old/new contents.
// Returns { oldStr: "", newStr: "" } for empty/invalid input (caller decides what to do).
export function unifiedToOldNew(unified: string): UnifiedReconstruction {
  const text = unified ?? "";
  if (!text.trim()) return { oldStr: "", newStr: "" };
  let patches: StructuredPatch[];
  try {
    patches = parsePatch(text);
  } catch {
    return { oldStr: "", newStr: "" };
  }
  if (!patches.length) return { oldStr: "", newStr: "" };

  // A single patch may contain multiple files (e.g. `git diff` across files); we merge
  // the first file's hunks. Callers in this app always diff one file at a time
  // (GitPanel per-file, apply_patch single file). If multiple, take the first.
  const p = patches[0];
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const h of p.hunks) {
    for (const raw of h.lines) {
      // Line is prefixed by " " (context), "+" (added), or "-" (removed).
      const mark = raw.charCodeAt(0);
      const body = raw.slice(1);
      if (mark === 0x2b /* + */) {
        newLines.push(body);
      } else if (mark === 0x2d /* - */) {
        oldLines.push(body);
      } else if (mark === 0x5c /* \ — "\ No newline..." marker, not real content */) {
        continue;
      } else {
        // context line — appears on both sides.
        oldLines.push(body);
        newLines.push(body);
      }
    }
  }
  return {
    oldStr: oldLines.join("\n"),
    newStr: newLines.join("\n"),
  };
}
