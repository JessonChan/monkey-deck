// panelDrop.ts: contract for the in-app FilePanel → chat-area HTML5 drag
// channel (issue #149).
//
// Panel rows write a JSON payload under one agreed MIME so the chat area can
// tell these drags apart from OS file drags — OS files stay on the Wails native
// channel (internal/chat/drop.go → chat:files-dropped) and must never be
// intercepted here. During dragover only `dataTransfer.types` is readable (the
// payload data is protected until drop), so the MIME string itself doubles as
// the "is ours" discriminator on both sides.

export const PANEL_FILE_MIME = "application/x-md-panel-file";

export interface PanelFilePayload {
  // Session the dragged panel belongs to. The receiving ChatView compares this
  // against its own session and ignores the drop on mismatch (cross-window
  // guard): the drop target is whoever is visible, not whoever started the drag.
  sessionId: string;
  // Panel node's original path — root-relative, forward slashes (FileNode.path).
  path: string;
}

// writePanelFilePayload serializes the payload onto a drag. Called from the
// row's onDragStart; the browser then renders the row snapshot as the drag ghost.
export function writePanelFilePayload(dt: DataTransfer, p: PanelFilePayload): void {
  dt.setData(PANEL_FILE_MIME, JSON.stringify(p));
}

// hasPanelFilePayload is the dragover-side check (types only — no getData).
export function hasPanelFilePayload(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = dt.types as ArrayLike<string> | null;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === PANEL_FILE_MIME) return true;
  }
  return false;
}

// readPanelFilePayload parses the payload on drop. Returns null when the drag
// is not ours or the payload is malformed — the caller must then leave the
// drop to the other channels (Wails native / browser default).
export function readPanelFilePayload(dt: DataTransfer | null): PanelFilePayload | null {
  if (!dt || !hasPanelFilePayload(dt)) return null;
  try {
    const raw = JSON.parse(dt.getData(PANEL_FILE_MIME)) as Partial<PanelFilePayload> | null;
    if (
      raw !== null &&
      typeof raw === "object" &&
      typeof raw.sessionId === "string" && raw.sessionId !== "" &&
      typeof raw.path === "string" && raw.path !== ""
    ) {
      return { sessionId: raw.sessionId, path: raw.path };
    }
  } catch {
    // malformed JSON → treated as not-ours below
  }
  return null;
}
