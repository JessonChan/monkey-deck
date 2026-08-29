import { describe, test, expect } from "bun:test";
import { collectTags, tagColor, TAG_PALETTE } from "./tagColor";

// Contract: tagColor is a pure deterministic hash into the fixed 8-color
// palette; collectTags unions tags across sessions in first-seen order.
// `null` tags are a real wire shape (Go nil slice → JSON null, typed
// `string[] | null` in the generated binding model) and must degrade to
// "no tags", never throw.

test("tagColor is deterministic and always inside the palette", () => {
  for (const name of ["api", "db", "ui", "Web", "web", "标签"]) {
    expect(TAG_PALETTE).toContain(tagColor(name));
    expect(tagColor(name)).toBe(tagColor(name));
  }
});

describe("collectTags", () => {
  test("unions tags in first-seen order, deduped across sessions", () => {
    expect(
      collectTags([
        { tags: ["api", "db"] },
        { tags: ["db", "ui"] },
        { tags: ["api"] },
      ]),
    ).toEqual(["api", "db", "ui"]);
  });

  test("null/undefined/missing tags degrade to no tags (#28396)", () => {
    // Go nil slice marshals to JSON null — must not throw or emit null entries.
    expect(collectTags([{ tags: null }, { tags: undefined }, {}])).toEqual([]);
    expect(collectTags([{ tags: null }, { tags: ["api"] }])).toEqual(["api"]);
  });

  test("empty input yields empty output", () => {
    expect(collectTags([])).toEqual([]);
  });
});
