// sttClient.test.ts: dictation client routing + error classification (#131
// stage 2). bun test. The Wails binding module is mocked before import — the
// desktop path never touches the runtime; the remote path stubs fetch.
//
// Coverage matrix:
//   desktop: blob → base64 + mime passthrough → TranscribeAudio
//   remote : POST /api/stt (raw body, Content-Type) → {"text"}
//   errors : binding sentinel texts ↔ HTTP 503/413/415 ↔ SttErrorKind
//   recorder: mime preference (wav first), startDictation mic-denied path

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ---- mock the Wails binding (BEFORE importing the SUT) ----
// Codebase mock pattern (Composer.mount.test): a single mock whose closure
// reads mutable test state — reassigning the variable retargets the mock.
let bindingResult = "hi from binding";
let bindingErr: unknown = null;
const transcribeAudioBinding = mock(async (_b64: string, _mime: string) => {
  if (bindingErr !== null) throw bindingErr;
  return bindingResult;
});
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/stt/service", () => ({
  TranscribeAudio: transcribeAudioBinding,
}));

const { transcribeAudio, blobToBase64, pickRecorderMime, startDictation, SttError } = await import("./sttClient");

// ---- helpers ----
function setRemoteClient(on: boolean) {
  if (on) {
    (globalThis as any).window = { __mdRemote: true };
  } else {
    delete (globalThis as any).window;
  }
}

function stubFetch(resp: unknown) {
  const fetchMock = mock(async () => resp as any);
  (globalThis as any).fetch = fetchMock;
  return fetchMock;
}

const restoreFetch = () => { delete (globalThis as any).fetch; };

// ---- desktop (webview binding) path ----
describe("sttClient desktop path (Wails binding)", () => {
  beforeEach(() => {
    setRemoteClient(false);
    transcribeAudioBinding.mockClear();
    bindingResult = "hi from binding";
    bindingErr = null;
  });

  test("blob → base64 + mime → TranscribeAudio; returns trimmed text", async () => {
    const blob = new Blob(["hello"], { type: "audio/webm;codecs=opus" });
    const text = await transcribeAudio(blob);
    expect(text).toBe("hi from binding");
    expect(transcribeAudioBinding).toHaveBeenCalledTimes(1);
    const [b64, mime] = transcribeAudioBinding.mock.calls[0];
    expect(b64).toBe(Buffer.from("hello").toString("base64"));
    expect(mime).toBe("audio/webm;codecs=opus"); // params preserved; backend strips them
  });

  test.each([
    ["whisper-server not found (install whisper.cpp…)", "notReady"],
    ["no STT model downloaded (model \"base.en-q5_1\")", "notReady"],
    ["audio too large: 30000000 bytes exceeds the 26214400-byte limit", "tooLarge"],
    ["unsupported audio type \"video/mp4\"", "unsupported"],
    ["stt: inference: status 500: boom", "failed"],
  ])("binding error %j → kind %s", async (msg: string, kind: string) => {
    bindingErr = new Error(msg);
    try {
      await transcribeAudio(new Blob(["x"], { type: "audio/wav" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SttError);
      expect((e as InstanceType<typeof SttError>).kind).toBe(kind);
      expect((e as InstanceType<typeof SttError>).detail).toBe(msg);
    }
  });

  test("Wails-shaped error object ({message}) is unwrapped for classification", async () => {
    bindingErr = { message: "whisper-server not found (…)" };
    try {
      await transcribeAudio(new Blob(["x"], { type: "audio/wav" }));
      expect.unreachable();
    } catch (e) {
      expect((e as InstanceType<typeof SttError>).kind).toBe("notReady");
    }
  });
});

// ---- remote browser / PWA path (/api/stt) ----
describe("sttClient remote path (POST /api/stt)", () => {
  afterEach(() => { setRemoteClient(false); restoreFetch(); });

  test("posts the raw blob with audio Content-Type and returns the text", async () => {
    setRemoteClient(true);
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ text: "  hi from http  " }) });
    const blob = new Blob(["abc"], { type: "audio/wav" });
    const text = await transcribeAudio(blob);
    expect(text).toBe("hi from http"); // trimmed
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/stt");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("audio/wav");
    expect(init.body).toBeInstanceOf(Blob);
    expect((init.body as Blob).type).toBe("audio/wav");
  });

  test.each([
    [503, { error: "whisper-server not found (…)" }, "notReady"],
    [413, { error: "audio too large" }, "tooLarge"],
    [415, { error: "unsupported audio type \"audio/foo\"" }, "unsupported"],
    [500, { error: "inference: boom" }, "failed"],
    [400, {}, "failed"],
  ])("HTTP %d → kind %s", async (status: number, body: unknown, kind: string) => {
    setRemoteClient(true);
    stubFetch({ ok: false, status, json: async () => body });
    try {
      await transcribeAudio(new Blob(["x"], { type: "audio/wav" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SttError);
      expect((e as InstanceType<typeof SttError>).kind).toBe(kind);
    }
  });

  test("network failure (fetch rejects) → failed, not a bare Error", async () => {
    setRemoteClient(true);
    stubFetch(new Error("connection refused"));
    try {
      await transcribeAudio(new Blob(["x"], { type: "audio/wav" }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SttError);
      expect((e as InstanceType<typeof SttError>).kind).toBe("failed");
    }
  });

  test("non-JSON error body still classifies by status", async () => {
    setRemoteClient(true);
    stubFetch({ ok: false, status: 503, json: async () => { throw new Error("not json"); } });
    try {
      await transcribeAudio(new Blob(["x"], { type: "audio/wav" }));
      expect.unreachable();
    } catch (e) {
      expect((e as InstanceType<typeof SttError>).kind).toBe("notReady");
      expect((e as InstanceType<typeof SttError>).detail).toBe("HTTP 503");
    }
  });
});

// ---- recorder helpers ----
describe("pickRecorderMime", () => {
  afterEach(() => { delete (globalThis as any).MediaRecorder; });

  test("prefers WAV when the engine supports it (whisper-native, no ffmpeg)", () => {
    (globalThis as any).MediaRecorder = class {
      static isTypeSupported(m: string) { return m === "audio/wav" || m === "audio/webm;codecs=opus"; }
    };
    expect(pickRecorderMime()).toBe("audio/wav");
  });

  test("falls back through webm/opus → webm → mp4", () => {
    (globalThis as any).MediaRecorder = class {
      static isTypeSupported(m: string) { return m === "audio/mp4"; }
    };
    expect(pickRecorderMime()).toBe("audio/mp4");
  });

  test("no candidate supported → undefined (browser default container)", () => {
    (globalThis as any).MediaRecorder = class {
      static isTypeSupported(_m: string) { return false; }
    };
    expect(pickRecorderMime()).toBeUndefined();
  });

  test("MediaRecorder missing (older webview) → undefined", () => {
    expect(pickRecorderMime()).toBeUndefined();
  });
});

describe("startDictation", () => {
  const restoreNavigator = () => {
    // bun ships a read-only navigator; tests overwrite it via defineProperty.
    delete (globalThis as any).navigator;
  };
  afterEach(() => { restoreNavigator(); delete (globalThis as any).MediaRecorder; });

  function installNavigator(gUM: (() => Promise<unknown>) | undefined) {
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: gUM ? { getUserMedia: gUM } : undefined },
      configurable: true,
      writable: true,
    });
  }

  test("mic denied / getUserMedia rejection → SttError(micDenied)", async () => {
    installNavigator(async () => { throw new Error("NotAllowedError"); });
    try {
      await startDictation();
      expect.unreachable();
    } catch (e) {
      expect((e as InstanceType<typeof SttError>).kind).toBe("micDenied");
    }
  });

  test("getUserMedia missing entirely → micDenied", async () => {
    installNavigator(undefined);
    try {
      await startDictation();
      expect.unreachable();
    } catch (e) {
      expect((e as InstanceType<typeof SttError>).kind).toBe("micDenied");
    }
  });

  test("happy path: stop() resolves the recorded blob and releases tracks", async () => {
    const trackStop = mock(() => {});
    const stream = { getTracks: () => [{ stop: trackStop }] };
    installNavigator(async () => stream);

    class FakeRecorder {
      static last: FakeRecorder | undefined;
      mimeType = "audio/webm;codecs=opus";
      state = "inactive";
      ondataavailable: ((ev: { data: Blob }) => void) | undefined;
      onstop: (() => void) | undefined;
      onerror: (() => void) | undefined;
      constructor(_stream: unknown, public opts?: { mimeType?: string }) { FakeRecorder.last = this; }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["abc"], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    (globalThis as any).MediaRecorder = FakeRecorder;
    (FakeRecorder as any).isTypeSupported = (m: string) => m === "audio/webm;codecs=opus";

    const handle = await startDictation();
    expect(FakeRecorder.last?.opts?.mimeType).toBe("audio/webm;codecs=opus");
    expect(FakeRecorder.last?.state).toBe("recording");

    const blob = await handle.stop();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(await blob.text()).toBe("abc");
    expect(trackStop).toHaveBeenCalledTimes(1); // mic released
  });

  // Fatal MediaRecorder error path (#24317 P3): a fatal error may never
  // dispatch a stop event, and stop() awaiting only onstop would hang forever
  // (phase stuck busy, tracks leaked). Before the fix this test times out;
  // after it, the chunks recorded before the error still flow to transcription.
  test("fatal onerror without onstop → stop() resolves with recorded chunks, tracks released", async () => {
    const trackStop = mock(() => {});
    const stream = { getTracks: () => [{ stop: trackStop }] };
    installNavigator(async () => stream);

    class FakeRecorder {
      static last: FakeRecorder | undefined;
      mimeType = "audio/webm;codecs=opus";
      state = "inactive";
      ondataavailable: ((ev: { data: Blob }) => void) | undefined;
      onstop: (() => void) | undefined;
      onerror: (() => void) | undefined;
      constructor(_stream: unknown, _opts?: { mimeType?: string }) { FakeRecorder.last = this; }
      start() { this.state = "recording"; }
      stop() { throw new Error("cannot stop after fatal error"); } // never reached: state is inactive
      // Fatal error mid-recording: state flips to inactive, a final chunk may
      // land, onerror fires — onstop never does.
      fail(chunk?: string) {
        this.state = "inactive";
        if (chunk !== undefined) this.ondataavailable?.({ data: new Blob([chunk], { type: this.mimeType }) });
        this.onerror?.();
      }
    }
    (globalThis as any).MediaRecorder = FakeRecorder;
    (FakeRecorder as any).isTypeSupported = (m: string) => m === "audio/webm;codecs=opus";

    const handle = await startDictation();
    FakeRecorder.last!.fail("par"); // timeslice chunk landed, then the recorder died

    const blob = await handle.stop(); // must resolve (hangs without the onerror guard)
    expect(await blob.text()).toBe("par"); // partial audio survives
    expect(trackStop).toHaveBeenCalledTimes(1); // mic released
  });
});

// blobToBase64 sanity (shared with the composer image convention).
describe("blobToBase64", () => {
  test("returns standard base64 without the data: prefix", async () => {
    const b64 = await blobToBase64(new Blob(["hello"], { type: "audio/wav" }));
    expect(b64).toBe(Buffer.from("hello").toString("base64"));
    expect(b64.startsWith("data:")).toBe(false);
  });
});
