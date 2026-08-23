// Android back gesture for the installed PWA (M2): with no history entries
// the back gesture EXITS the app even while a drawer or modal is open — the
// most jarring "this is a webpage" tell. Each open UI layer pushes a history
// entry here; popstate closes the top layer instead of leaving the app.
//
// Pushes are gated to ≤768px viewports (M2 hard rule: desktop history is
// untouched — the desktop webview has no back affordance, and a desktop
// remote-browser user must keep native back = leave page). A popstate that no
// pushed layer owns is left to the browser (exit), which is the desired end.
//
// Closing a NON-top layer calls history.back() once to consume its own entry;
// history entries are anonymous LIFO, so that actually pops the top entry and
// leaves one orphan below — a rare edge (all our layers close top-first)
// whose worst case is one extra back press before exit.

export interface BackStackEnv {
  pushState(): void;
  back(): void;
  onPopState(fn: () => void): () => void;
  isMobileViewport(): boolean;
}

interface Layer {
  id: string;
  close: () => void;
  /** We own a history entry for this layer (mobile push). */
  pushed: boolean;
  /** Our entry was already consumed by a popstate (back gesture closed us). */
  poppedByBack: boolean;
}

export interface BackStack {
  /** Register an open layer; returns its remover (call on close/unmount). */
  push(id: string, close: () => void): () => void;
  dispose(): void;
}

export function createBackStack(env: BackStackEnv): BackStack {
  const layers: Layer[] = [];
  // Set when WE call back() to consume our own entry: the resulting popstate
  // must not be treated as a user back gesture (which would close a layer).
  let ignoreNextPop = false;
  const off = env.onPopState(() => {
    if (ignoreNextPop) { ignoreNextPop = false; return; }
    const top = layers[layers.length - 1];
    // Only layers that pushed an entry own this popstate; anything else
    // (desktop-registered layer, foreign navigation) keeps default behavior.
    if (!top || !top.pushed) return;
    top.poppedByBack = true;
    top.close();
  });
  return {
    push(id, close) {
      if (layers.some((l) => l.id === id)) return () => {};
      const layer: Layer = { id, close, pushed: env.isMobileViewport(), poppedByBack: false };
      layers.push(layer);
      if (layer.pushed) env.pushState();
      return () => {
        const i = layers.indexOf(layer);
        if (i === -1) return;
        layers.splice(i, 1);
        // Consume our history entry unless a popstate already did (back
        // gesture close: the entry is gone; cleanup must not back() again).
        if (layer.pushed && !layer.poppedByBack) {
          ignoreNextPop = true;
          env.back();
        }
      };
    },
    dispose() {
      off();
      layers.length = 0;
    },
  };
}

// App-wide singleton against the real History API. Lazy so importing the
// module stays side-effect free (unit tests import createBackStack directly).
let stack: BackStack | null = null;
export function backStack(): BackStack {
  if (!stack) {
    stack = createBackStack({
      pushState: () => window.history.pushState({ mdBackStack: true }, ""),
      back: () => window.history.back(),
      onPopState: (fn) => {
        window.addEventListener("popstate", fn);
        return () => window.removeEventListener("popstate", fn);
      },
      isMobileViewport: () => window.matchMedia("(max-width: 768px)").matches,
    });
  }
  return stack;
}
