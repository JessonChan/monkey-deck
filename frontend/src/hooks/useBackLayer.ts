import { useEffect, useRef } from "react";
import { backStack } from "../lib/backStack";

let nextLayerId = 0;

// Map an open UI layer (drawer, modal, dialog) onto the PWA back stack: while
// `active`, the Android back gesture closes THIS layer instead of exiting the
// app. Close-by-UI (scrim tap, Esc, button) runs the same remover, which
// consumes the pushed history entry — both paths converge on one cleanup, so
// history and UI can't drift apart. Pushes are ≤768px-gated inside the stack;
// on desktop the hook registers a layer that owns no history entry (no-op).
export function useBackLayer(active: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const idRef = useRef<string>("");
  if (!idRef.current) idRef.current = `back-layer-${++nextLayerId}`;
  useEffect(() => {
    if (!active) return;
    return backStack().push(idRef.current, () => closeRef.current());
  }, [active]);
}
