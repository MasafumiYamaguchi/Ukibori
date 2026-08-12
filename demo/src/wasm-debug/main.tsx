import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WasmDebug } from "./WasmDebug";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WasmDebug />
  </StrictMode>,
);
