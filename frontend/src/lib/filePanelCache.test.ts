// Unit tests for the recent file-search history store (#167): project-level
// localStorage keyed by rootPath (per-session fallback when the root is
// unknown), move-to-front dedupe writes, cap-12 retention, and a defensive
// read that degrades corrupt / non-array / non-string payloads to a clean
// list. Same posture as Composer's md:recent-models, but for free-form query
// strings (validity = string-ness, no option list to check against).

import { describe, test, expect, beforeEach } from "bun:test";
import {
  RECENT_FILE_SEARCH_CAP,
  recentFileSearchesKey,
  loadRecentFileSearches,
  rememberRecentFileSearch,
  removeRecentFileSearch,
} from "./filePanelCache";

// Minimal localStorage stub — the store only uses getItem/setItem.
const backing = new Map<string, string>();
const makeStorage = (m: Map<string, string>) => ({
  getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
  setItem: (k: string, v: string) => void m.set(k, v),
});
const installStorage = (s: object) =>
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: s });
installStorage(makeStorage(backing));

const ROOT_KEY = recentFileSearchesKey("/repo", "s1");
const SESSION_KEY = recentFileSearchesKey("", "s1");

const seed = (key: string, queries: string[]) => backing.set(key, JSON.stringify(queries));
const read = (key: string): string[] => JSON.parse(backing.get(key)!);

beforeEach(() => {
  backing.clear();
  installStorage(makeStorage(backing));
});

describe("recentFileSearchesKey (#167 key domain)", () => {
  test("project root key wins; empty rootPath degrades to the per-session key", () => {
    expect(ROOT_KEY).toBe("md:recent-file-searches:/repo");
    expect(SESSION_KEY).toBe("md:recent-file-searches:s1");
  });
});

describe("rememberRecentFileSearch", () => {
  test("writes the query, newest first; blank queries are never recorded", () => {
    rememberRecentFileSearch(ROOT_KEY, "alpha");
    rememberRecentFileSearch(ROOT_KEY, "   ");
    expect(read(ROOT_KEY)).toEqual(["alpha"]);
  });

  test("re-membering an existing query moves it to the front (dedupe)", () => {
    rememberRecentFileSearch(ROOT_KEY, "alpha");
    rememberRecentFileSearch(ROOT_KEY, "beta");
    rememberRecentFileSearch(ROOT_KEY, "alpha");
    expect(read(ROOT_KEY)).toEqual(["alpha", "beta"]);
  });

  test(`cap ${RECENT_FILE_SEARCH_CAP}: the oldest entry is evicted`, () => {
    for (let i = 1; i <= RECENT_FILE_SEARCH_CAP; i++) rememberRecentFileSearch(ROOT_KEY, `q${i}`);
    rememberRecentFileSearch(ROOT_KEY, "q0");
    const all = read(ROOT_KEY);
    expect(all.length).toBe(RECENT_FILE_SEARCH_CAP);
    expect(all[0]).toBe("q0");
    expect(all).not.toContain("q1"); // evicted
    expect(all[all.length - 1]).toBe("q2");
  });
});

describe("loadRecentFileSearches", () => {
  test("missing key reads as an empty list", () => {
    expect(loadRecentFileSearches(ROOT_KEY)).toEqual([]);
  });

  test("corrupt JSON degrades to an empty list", () => {
    backing.set(ROOT_KEY, "{not json");
    expect(loadRecentFileSearches(ROOT_KEY)).toEqual([]);
  });

  test("non-array JSON (object / scalar) degrades to an empty list", () => {
    backing.set(ROOT_KEY, JSON.stringify({ queries: ["a"] }));
    expect(loadRecentFileSearches(ROOT_KEY)).toEqual([]);
    backing.set(ROOT_KEY, JSON.stringify("alpha"));
    expect(loadRecentFileSearches(ROOT_KEY)).toEqual([]);
  });

  test("non-string entries are filtered; strings survive", () => {
    backing.set(ROOT_KEY, JSON.stringify([1, "a", null, "b", { x: 1 }]));
    expect(loadRecentFileSearches(ROOT_KEY)).toEqual(["a", "b"]);
  });

  test("over-long stored lists are clamped to the cap", () => {
    seed(ROOT_KEY, Array.from({ length: RECENT_FILE_SEARCH_CAP + 5 }, (_, i) => `q${i}`));
    expect(loadRecentFileSearches(ROOT_KEY).length).toBe(RECENT_FILE_SEARCH_CAP);
  });
});

describe("removeRecentFileSearch", () => {
  test("removes a single entry; absent entries and foreign keys are untouched", () => {
    seed(ROOT_KEY, ["a", "b", "c"]);
    removeRecentFileSearch(ROOT_KEY, "b");
    expect(read(ROOT_KEY)).toEqual(["a", "c"]);
    removeRecentFileSearch(ROOT_KEY, "zzz");
    expect(read(ROOT_KEY)).toEqual(["a", "c"]);
    removeRecentFileSearch(SESSION_KEY, "a");
    expect(read(ROOT_KEY)).toEqual(["a", "c"]);
  });
});

describe("storage failures", () => {
  test("a throwing localStorage degrades reads/writes to safe no-ops", () => {
    installStorage({
      getItem: () => {
        throw new Error("boom");
      },
      setItem: () => {
        throw new Error("boom");
      },
    });
    expect(loadRecentFileSearches(ROOT_KEY)).toEqual([]);
    expect(() => rememberRecentFileSearch(ROOT_KEY, "a")).not.toThrow();
    expect(() => removeRecentFileSearch(ROOT_KEY, "a")).not.toThrow();
  });
});
