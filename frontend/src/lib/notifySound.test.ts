// notifySound.test.ts:#73 权限到达提示音「恰一次」+「开关生效」单测(bun test)。
//
// 用假 AudioContext 计数真实 playNotifySound 的发声路径(每次播放 createGain 一次),
// 断言的是真实播放调用,不是包装函数的返回值形状。happy-dom 提供 localStorage。
//
// 注:被测模块经静态 import 加载;AudioContext 在模块函数体内按需读取
// (typeof 检查 + new AudioContext()),故先替换全局再调用即可,无需动态导入。

import { describe, test, expect, beforeEach } from "bun:test";
import { Window } from "happy-dom";

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;

// 每次 playNotifySound 会 createGain 一次 → 计数即播放次数。
let gainCalls = 0;
class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination: Record<string, never> = {};
  resume(): void {}
  createGain() {
    gainCalls++;
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    };
  }
  createOscillator() {
    return {
      type: "",
      frequency: { setValueAtTime() {} },
      connect() {},
      start() {},
      stop() {},
    };
  }
}
(globalThis as { AudioContext: unknown }).AudioContext = FakeAudioContext;

const { notifyPermissionOnce, setNotifySoundEnabled } = await import("./notifySound");

beforeEach(() => {
  setNotifySoundEnabled(true);
});

describe("notifyPermissionOnce (#73)", () => {
  test("plays exactly once per permission id — re-dispatches stay silent", () => {
    gainCalls = 0;
    expect(notifyPermissionOnce("perm-a")).toBe(true);
    expect(notifyPermissionOnce("perm-a")).toBe(false);
    expect(notifyPermissionOnce("perm-a")).toBe(false);
    expect(gainCalls).toBe(1);
  });

  test("a new permission id plays again", () => {
    gainCalls = 0;
    expect(notifyPermissionOnce("perm-b")).toBe(true);
    expect(notifyPermissionOnce("perm-c")).toBe(true);
    expect(gainCalls).toBe(2);
  });

  test("switch off → never plays; the id still counts as arrived", () => {
    gainCalls = 0;
    setNotifySoundEnabled(false);
    expect(notifyPermissionOnce("perm-d")).toBe(false);
    expect(gainCalls).toBe(0);
    // 开关中途打开:重发同 id 不补响(到达判定只看首次)。
    setNotifySoundEnabled(true);
    expect(notifyPermissionOnce("perm-d")).toBe(false);
    expect(gainCalls).toBe(0);
    // 之后的新 id 正常响。
    expect(notifyPermissionOnce("perm-e")).toBe(true);
    expect(gainCalls).toBe(1);
  });

  test("empty id is ignored", () => {
    expect(notifyPermissionOnce("")).toBe(false);
  });
});
