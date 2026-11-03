import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { applyTheme, savedTheme } from "./store.tsx";

// Before the first paint, so a saved Light or Dark does not flash the system theme.
applyTheme(savedTheme());
createRoot(document.getElementById("root")!).render(<App />);
