import { createRoot } from "react-dom/client";
import App from "./App";
import { FrontendSettingsProvider } from "./lib/settingsStore";
import "./i18n";
import "./index.css";
import "@xterm/xterm/css/xterm.css";

const root = document.getElementById("root") as HTMLElement | null;
if (root) {
  createRoot(root).render(
    <FrontendSettingsProvider>
      <App />
    </FrontendSettingsProvider>,
  );
}
