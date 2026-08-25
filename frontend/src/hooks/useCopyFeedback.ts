import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";

// Shared transient feedback for copy buttons: `copied` / `failed` flip from
// copyText's boolean result and auto-reset after `resetMs`. Replaces the old
// per-component `await copyText(x); setCopied(true); setTimeout(...)` pattern,
// which lit the Check icon even when the copy actually failed (issue #129).
export function useCopyFeedback(resetMs = 1200) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const copy = useCallback(async (text: string): Promise<boolean> => {
    const ok = await copyText(text);
    setCopied(ok);
    setFailed(!ok);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, resetMs);
    return ok;
  }, [resetMs]);
  return { copied, failed, copy };
}
