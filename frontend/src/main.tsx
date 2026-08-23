import { createRoot } from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { FrontendSettingsProvider } from "./lib/settingsStore";
import { applyFontScale, readFontScale } from "./lib/fontScale";
import "./i18n";
import "./index.css";
import "@xterm/xterm/css/xterm.css";

// Apply persisted font scale BEFORE React mounts so the very first paint uses
// the saved value (no 1-frame flash of --font-scale:1). Slider live updates go
// through settingsStore.setFontScale → applyFontScale. (issue #102)
applyFontScale(readFontScale());

const root = document.getElementById("root") as HTMLElement | null;
if (root) {
  createRoot(root).render(
    <AppErrorBoundary>
      <FrontendSettingsProvider>
        <App />
      </FrontendSettingsProvider>
    </AppErrorBoundary>,
  );
}
