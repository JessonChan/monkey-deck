// Tag color assignment (#150 MVP): a tag name deterministically maps into an
// 8-color Gmail label palette (light chip variants: tomato, tangerine, banana,
// sage, mint, blueberry, grape, flamingo — dark text stays legible on every
// chip, including on the dark sidebar). The hash is FNV-1a 32-bit over the
// UTF-16 code units of the name, so the same tag gets the same color across
// sessions, projects, restarts and windows — no color management UI anywhere.
//
// idx = FNV1a32(name) mod 8
export const TAG_PALETTE = [
  "#f28b82", // tomato
  "#fcad70", // tangerine
  "#fbbc04", // banana
  "#ccff90", // sage
  "#a1e4cb", // mint
  "#aecbfa", // blueberry
  "#d7aefb", // grape
  "#fdcfe8", // flamingo
] as const;

export function tagColor(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return TAG_PALETTE[(h >>> 0) % TAG_PALETTE.length];
}

// Union of tags across a project's sessions, first-seen order — feeds the
// per-project filter chip row.
export function collectTags(sessions: { tags?: string[] }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    for (const tag of s.tags ?? []) {
      if (!seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
    }
  }
  return out;
}
