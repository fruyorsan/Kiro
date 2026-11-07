import "./migrate";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initPerfMode } from "./perfMode";

initPerfMode();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
