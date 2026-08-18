import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { installSafeToast } from "./lib/safe-toast";
import {
  applyAppearance,
  loadStoredTheme,
  loadStoredThemePreset,
} from "./lib/theme";

applyAppearance(loadStoredTheme(), loadStoredThemePreset());
installSafeToast();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
