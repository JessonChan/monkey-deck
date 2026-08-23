import { describe, test, expect } from "bun:test";
import { parseLaunchAction } from "./launchAction";

// Contract: only the three manifest shortcut actions are recognized; anything
// else (absent, unknown, duplicated keys) must be a no-op null so the app
// never navigates on a random query param (desktop never carries one).

describe("parseLaunchAction", () => {
  test("known actions parse from a shortcut-style query", () => {
    expect(parseLaunchAction("?action=new-session")).toBe("new-session");
    expect(parseLaunchAction("?action=settings")).toBe("settings");
    expect(parseLaunchAction("?action=switch-project")).toBe("switch-project");
  });

  test("absent / empty / unknown → null (inert)", () => {
    expect(parseLaunchAction("")).toBeNull();
    expect(parseLaunchAction("?")).toBeNull();
    expect(parseLaunchAction("?foo=1")).toBeNull();
    expect(parseLaunchAction("?action=")).toBeNull();
    expect(parseLaunchAction("?action=delete-everything")).toBeNull();
  });

  test("extra params alongside the action are tolerated", () => {
    expect(parseLaunchAction("?utm_source=homescreen&action=settings&x=1")).toBe("settings");
  });
});
