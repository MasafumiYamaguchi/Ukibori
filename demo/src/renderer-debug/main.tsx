import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RendererDebug } from "./RendererDebug";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RendererDebug />
  </StrictMode>,
);
