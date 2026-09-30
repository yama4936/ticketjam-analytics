import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Admin } from "./Admin.js";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname === "/admin" ? <Admin /> : <App />}
  </React.StrictMode>,
);
