import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";
import { startDesktopBridge, startMarbleBackground } from "./desktop.ts";
startMarbleBackground();
startDesktopBridge();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
