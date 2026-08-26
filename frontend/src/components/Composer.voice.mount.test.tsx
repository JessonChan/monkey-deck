// Mount-test Composer voice dictation (#131 stage 2).
//
// Pins the mic-button contract end to end (with the stt lib + i18n mocked):
//   1. click → startDictation → button enters recording state (data-state)
//   2. click again → stop() blob → transcribeAudio → transcript inserted AT
//      THE CARET with smart space padding (not appended)
//   3. classified failures render a localized inline error row (voiceErr.*)
//      without touching the draft: transcribe notReady / mic denied / empty
//      transcript (noSpeech); × dismisses the row
//   4. #24317 P3: zero-size blob → noSpeech row (no silent idle); fatal
//      recorder error → stop() still resolves partial audio; dictation icon
//      distinct from the adjacent audio-attachment mic
//
// Harness mirrors Composer.mount.test.tsx (happy-dom + thin radix/cmdk/i18n
// mocks). MediaRecorder itself is covered by src/lib/sttClient.test.ts; here
// the whole stt lib is mocked so the test exercises only the Composer wiring.

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

// ---- happy-dom setup ----
const window = new Window();
const document = window.document;
globalThis.window = window;
globalThis.document = document;
globalThis.navigator = window.navigator;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.MouseEvent = window.MouseEvent;
window.React = React;

// ---- mock @radix-ui/react-popover / cmdk / react-i18next (see Composer.mount.test) ----
mock.module("@radix-ui/react-popover", () => {
  const Ctx = React.createContext({ open: false, setOpen: () => {} });
  const Root = ({ children, open: controlled, defaultOpen, onOpenChange }) => {
    const [internal, setInternal] = React.useState(defaultOpen ?? false);
    const open = controlled !== undefined ? controlled : internal;
    const setOpen = (v) => {
      if (controlled === undefined) setInternal(v);
      if (onOpenChange) onOpenChange(v);
    };
    return React.createElement(Ctx.Provider, { value: { open, setOpen } }, children);
  };
  const Trigger = ({ children, asChild, ...props }) => {
    const { setOpen } = React.useContext(Ctx);
    const handler = (e) => { if (e && e.preventDefault) e.preventDefault(); setOpen(true); };
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, { onClick: handler });
    }
    return React.createElement("button", { onClick: handler, ...props }, children);
  };
  const Portal = ({ children }) => React.createElement(React.Fragment, null, children);
  const Content = ({ children, ...props }) => {
    const { open } = React.useContext(Ctx);
    if (!open) return null;
    return React.createElement("div", { ...props }, children);
  };
  const Anchor = ({ children }) => children ?? null;
  const Arrow = () => null;
  const Close = ({ children }) => children ?? null;
  return {
    default: { Root, Trigger, Portal, Content, Anchor, Arrow, Close },
    Root, Trigger, Portal, Content, Anchor, Arrow, Close,
  };
});
mock.module("cmdk", () => {
  const Command = React.forwardRef(({ children, ...props }, ref) =>
    React.createElement("div", { ref, ...props }, children));
  Command.Input = (props) => React.createElement("input", props);
  Command.List = ({ children, ...props }) => React.createElement("div", props, children);
  Command.Empty = () => null;
  Command.Group = ({ children, ...props }) => React.createElement("div", props, children);
  Command.Item = ({ children, onSelect, ...props }) =>
    React.createElement("div", { ...props, onClick: onSelect }, children);
  Command.Loading = () => null;
  Command.Separator = () => null;
  return { Command };
});
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: (k) => k }),
  initReactI18next: { type: "3rd-party" },
  default: { useTranslation: () => ({ t: (k) => k }) },
}));

// Chat service binding mock (McpChip queries MCP servers on mount).
mock.module("../../bindings/github.com/jessonchan/monkey-deck/internal/chat/chatservice", () => ({
  PickFiles: mock(async () => []),
  SessionFuzzyFind: mock(async () => []),
  GetSessionMcpServers: mock(async () => []),
}));

// ---- mock the stt lib (../lib/sttClient from Composer's perspective) ----
// FakeSttError mirrors the real class shape (kind + instanceof check).
class FakeSttError extends Error {
  constructor(public kind: string, detail: string) { super(detail); }
}
// Mutable mock state (codebase pattern): reassign between tests.
let dictationResult: { stop: () => Promise<Blob>; cancel: () => void } | null = null;
let dictationErr: unknown = null;
let transcript = "hello world";
let transcribeErr: unknown = null;
// When set, transcribeAudio parks on this promise before resolving — lets a
// test hold the transcription in flight, advance the draft mid-flight, then
// release (stale-closure regression below).
let transcribeGate: Promise<void> | null = null;
const startDictationMock = mock(async () => {
  if (dictationErr !== null) throw dictationErr;
  if (!dictationResult) throw new Error("test bug: no handle installed");
  return dictationResult;
});
const transcribeAudioMock = mock(async (blob: Blob) => {
  if (transcribeGate) await transcribeGate;
  if (transcribeErr !== null) throw transcribeErr;
  expect(blob).toBeInstanceOf(Blob);
  return transcript;
});
mock.module("../lib/sttClient", () => ({
  SttError: FakeSttError,
  startDictation: startDictationMock,
  transcribeAudio: transcribeAudioMock,
  blobToBase64: async () => "",
  pickRecorderMime: () => undefined,
}));

const Composer = (await import("./Composer.tsx")).default;

function mount(jsx) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(jsx);
  return { host, root };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

// Minimal prop stubs (same as Composer.mount.test; no audio/image support so
// only the dictation mic button renders).
const STUB_PROPS = {
  onChange: () => {},
  disabled: false,
  prompting: false,
  configOptions: [],
  onSetConfig: () => {},
  onRefreshConfig: () => {},
  history: [],
  sessionId: "",
  attachments: [],
  onAttachmentsChange: () => {},
  mentions: [],
  onMentionsChange: () => {},
  images: [],
  onImagesChange: () => {},
  imageSupported: false,
  audios: [],
  onAudiosChange: () => {},
  audioSupported: false,
  usage: { used: 0, size: 0, cost: 0 } as any,
  branch: "",
  onSend: () => {},
  onEnqueue: () => {},
  onStop: () => {},
};

// A recording handle whose stop() resolves the given fake audio payload.
function makeHandle(audio = "fake-audio") {
  return {
    stop: mock(async () => new Blob([audio], { type: "audio/webm;codecs=opus" })),
    cancel: mock(() => {}),
  };
}

// Position the caret inside the textarea (selectionchange drives handleSelect
// → cursorRef sync — same trick as Composer.mount.test).
function positionCursor(ta: HTMLTextAreaElement, pos: number) {
  ta.focus();
  ta.selectionStart = ta.selectionEnd = pos;
  document.dispatchEvent(new window.Event("selectionchange", { bubbles: true }));
}

function voiceBtn(host: HTMLElement) {
  return host.querySelector('[data-testid="voice-btn"]') as HTMLElement;
}

function click(el: HTMLElement) {
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
}

describe("Composer voice dictation (#131 stage 2)", () => {
  beforeEach(() => {
    startDictationMock.mockClear();
    transcribeAudioMock.mockClear();
    dictationResult = null;
    dictationErr = null;
    transcript = "hello world";
    transcribeErr = null;
    transcribeGate = null;
  });

  test("mic button always renders (errors surface on use, not by hiding the entry)", async () => {
    const { host } = mount(<Composer value={"hi"} {...STUB_PROPS} />);
    await flush();
    const btn = voiceBtn(host);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("data-state")).toBe("idle");
    // Not gated on the agent's audio prompt capability (dictation is a client-
    // side input aid, unlike the audio ATTACHMENT button which is hidden).
    expect(host.querySelector('[data-testid="audio-btn"]')).toBeNull();
  });

  test("click → recording state; click again → transcribe → insert at caret", async () => {
    const handle = makeHandle();
    dictationResult = handle;
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={""} {...STUB_PROPS} onChange={onChange} />);
    await flush();

    click(voiceBtn(host));
    await flush();
    expect(startDictationMock).toHaveBeenCalledTimes(1);
    expect(voiceBtn(host).getAttribute("data-state")).toBe("recording");

    click(voiceBtn(host));
    await flush();

    // The blob from handle.stop() flows into transcribeAudio verbatim.
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(transcribeAudioMock).toHaveBeenCalledTimes(1);
    const sent = transcribeAudioMock.mock.calls[0][0] as Blob;
    expect(await sent.text()).toBe("fake-audio");
    // Empty draft + caret at 0 → the transcript IS the next value (no padding).
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(last).toBe("hello world");
    // Back to idle, no error row.
    expect(voiceBtn(host).getAttribute("data-state")).toBe("idle");
    expect(host.querySelector('[data-testid="voice-error"]')).toBeNull();
  });

  test("transcript is inserted AT THE CARET with smart space padding (not appended)", async () => {
    dictationResult = makeHandle();
    transcript = "hello world";
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={"foo bar"} {...STUB_PROPS} onChange={onChange} />);
    await flush();

    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 3); // caret between "foo" and "bar"
    await flush();

    click(voiceBtn(host));
    await flush();
    click(voiceBtn(host));
    await flush();

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(last).toBe("foo hello world bar");
  });

  test("transcript at end of existing text pads only the left side", async () => {
    dictationResult = makeHandle();
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={"fix this"} {...STUB_PROPS} onChange={onChange} />);
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(ta, 8);
    await flush();

    click(voiceBtn(host));
    await flush();
    click(voiceBtn(host));
    await flush();

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(last).toBe("fix this hello world");
  });

  test("transcribe failure (notReady) shows the localized error row, draft untouched", async () => {
    dictationResult = makeHandle();
    transcribeErr = new FakeSttError("notReady", "whisper-server not found (…)");
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={""} {...STUB_PROPS} onChange={onChange} />);
    await flush();

    click(voiceBtn(host));
    await flush();
    click(voiceBtn(host));
    await flush();

    // i18n mock returns the key verbatim → assert the kind is rendered via key.
    const row = host.querySelector('[data-testid="voice-error"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("voiceErr.notReady");
    // No transcript insertion happened.
    expect(onChange).not.toHaveBeenCalled();
    expect(voiceBtn(host).getAttribute("data-state")).toBe("idle");
  });

  test("mic denied (startDictation rejects) → error row, never enters recording", async () => {
    dictationErr = new FakeSttError("micDenied", "NotAllowedError");
    const { host } = mount(<Composer value={""} {...STUB_PROPS} />);
    await flush();

    click(voiceBtn(host));
    await flush();

    expect(voiceBtn(host).getAttribute("data-state")).toBe("idle");
    const row = host.querySelector('[data-testid="voice-error"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("voiceErr.micDenied");
  });

  test("empty transcript → noSpeech error row, draft untouched", async () => {
    dictationResult = makeHandle();
    transcript = "";
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={""} {...STUB_PROPS} onChange={onChange} />);
    await flush();

    click(voiceBtn(host));
    await flush();
    click(voiceBtn(host));
    await flush();

    const row = host.querySelector('[data-testid="voice-error"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("voiceErr.noSpeech");
    expect(onChange).not.toHaveBeenCalled();
  });

  // #24317 P3: stopping before the first 250ms timeslice yields a zero-size
  // blob. That used to return to idle SILENTLY — same feedback gap as noSpeech
  // (§4.4); now it shows the same localized hint.
  test("zero-size blob (stopped before the first timeslice) → noSpeech row, not a silent idle", async () => {
    dictationResult = makeHandle(""); // Blob([""]) → size 0
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={""} {...STUB_PROPS} onChange={onChange} />);
    await flush();

    click(voiceBtn(host));
    await flush();
    click(voiceBtn(host));
    await flush();

    const row = host.querySelector('[data-testid="voice-error"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("voiceErr.noSpeech");
    expect(transcribeAudioMock).not.toHaveBeenCalled(); // nothing to transcribe
    expect(onChange).not.toHaveBeenCalled();
    expect(voiceBtn(host).getAttribute("data-state")).toBe("idle");
  });

  // #24317 P3: a fatally-errored MediaRecorder never dispatches a stop event;
  // startDictation's onerror guard makes stop() resolve with the chunks
  // recorded before the error. Pin the Composer wiring on that contract: the
  // partial audio still flows to transcription and the button returns to idle
  // (the hang itself is pinned in src/lib/sttClient.test.ts).
  test("fatal recorder error mid-recording → stop() resolves partial audio, flow completes", async () => {
    dictationResult = makeHandle("partial-audio");
    transcript = "partial words";
    const onChange = mock(() => {});
    const { host } = mount(<Composer value={""} {...STUB_PROPS} onChange={onChange} />);
    await flush();

    click(voiceBtn(host));
    await flush();
    expect(voiceBtn(host).getAttribute("data-state")).toBe("recording");

    click(voiceBtn(host));
    await flush();

    const sent = transcribeAudioMock.mock.calls[0][0] as Blob;
    expect(await sent.text()).toBe("partial-audio");
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string;
    expect(last).toBe("partial words");
    expect(voiceBtn(host).getAttribute("data-state")).toBe("idle");
    expect(host.querySelector('[data-testid="voice-error"]')).toBeNull();
  });

  // #24317 P3: with audioSupported the audio-ATTACHMENT button (Mic) sits
  // next to the dictation button. They must not render the same glyph — a
  // regression back to Mic would make both outerHTMLs identical.
  test("dictation icon differs from the adjacent audio-attachment mic", async () => {
    const { host } = mount(<Composer value={""} {...STUB_PROPS} audioSupported={true} />);
    await flush();
    const voiceIcon = host.querySelector('[data-testid="voice-btn"] svg') as SVGElement;
    const audioIcon = host.querySelector('[data-testid="audio-btn"] svg') as SVGElement;
    expect(voiceIcon).not.toBeNull();
    expect(audioIcon).not.toBeNull();
    expect(voiceIcon.outerHTML).not.toBe(audioIcon.outerHTML); // AudioLines vs Mic
    // Labels stay distinct too (dictation aid vs agent audio attachment).
    expect(voiceBtn(host).getAttribute("aria-label")).toBe("composer.voiceDictateTip");
    expect((host.querySelector('[data-testid="audio-btn"]') as HTMLElement).getAttribute("title")).toBe("composer.addAudioTip");
  });

  test("× dismisses the error row; Esc on the textarea dismisses too", async () => {
    dictationErr = new FakeSttError("micDenied", "NotAllowedError");
    const { host } = mount(<Composer value={""} {...STUB_PROPS} />);
    await flush();
    click(voiceBtn(host));
    await flush();
    expect(host.querySelector('[data-testid="voice-error"]')).not.toBeNull();

    click(host.querySelector('[data-testid="voice-error-dismiss"]') as HTMLElement);
    await flush();
    expect(host.querySelector('[data-testid="voice-error"]')).toBeNull();

    // Esc path: re-trigger, then Esc on the textarea clears it.
    click(voiceBtn(host));
    await flush();
    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(host.querySelector('[data-testid="voice-error"]')).toBeNull();
  });

  test("starting a new dictation clears a stale error row", async () => {
    dictationErr = new FakeSttError("micDenied", "NotAllowedError");
    const { host } = mount(<Composer value={""} {...STUB_PROPS} />);
    await flush();
    click(voiceBtn(host));
    await flush();
    expect(host.querySelector('[data-testid="voice-error"]')).not.toBeNull();

    // Next attempt succeeds → error row must be gone (setVoiceError(null) on toggle).
    dictationErr = null;
    dictationResult = makeHandle();
    click(voiceBtn(host));
    await flush();
    expect(host.querySelector('[data-testid="voice-error"]')).toBeNull();
    expect(voiceBtn(host).getAttribute("data-state")).toBe("recording");
  });

  test("disabled composer (no session) disables the mic button", async () => {
    const { host } = mount(<Composer value={""} {...STUB_PROPS} disabled={true} />);
    await flush();
    const btn = voiceBtn(host) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  // Stale-closure regression: insertAtCursor used the `value` captured when
  // stop was clicked; if the user keeps typing while whisper inference runs
  // (textarea stays editable during "transcribing"), the transcript insert
  // rewound the draft to that snapshot and silently clobbered the typing.
  // Controlled wrapper mirrors App: value lives in wrapper state, onChange
  // feeds back; `typed` simulates keystrokes landing mid-transcription
  // (happy-dom cannot dispatch real input events through React's tracker).
  test("typing during transcription survives the transcript insert (not clobbered)", async () => {
    dictationResult = makeHandle();
    transcript = "hello world";
    let releaseTranscribe!: () => void;
    transcribeGate = new Promise<void>((r) => { releaseTranscribe = r; });
    const onChange = mock(() => {});

    function Shell({ typed }: { typed: boolean }) {
      const [v, setV] = React.useState("fix the ");
      React.useEffect(() => { if (typed) setV("fix the bug now"); }, [typed]);
      // STUB_PROPS first so the real onChange (setV) wins over the stub.
      return <Composer {...STUB_PROPS} value={v} onChange={(next) => { onChange(next); setV(next); }} />;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(<Shell typed={false} />);
    await flush();

    click(voiceBtn(host));
    await flush();
    expect(voiceBtn(host).getAttribute("data-state")).toBe("recording");
    click(voiceBtn(host));
    await flush();
    expect(voiceBtn(host).getAttribute("data-state")).toBe("transcribing");

    // User types while the inference is in flight → the value prop advances
    // (typing at the end also moves the caret, like handleChange would).
    root.render(<Shell typed={true} />);
    await flush();
    const taMid = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    positionCursor(taMid, taMid.value.length);
    await flush();

    releaseTranscribe();
    await flush();
    await flush();

    const ta = host.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    // Both must survive: the mid-flight typing AND the inserted transcript.
    expect(ta.value).toContain("bug now");
    expect(ta.value).toContain("hello world");
    // Anchored: caret at the (advanced) end → transcript appends after typing.
    expect(ta.value).toBe("fix the bug now hello world");
    expect(voiceBtn(host).getAttribute("data-state")).toBe("idle");
    root.unmount();
  });
});
