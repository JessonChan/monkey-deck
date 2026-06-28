import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root") as HTMLElement | null;
if (root) {
  createRoot(root).render(<App />);
}
