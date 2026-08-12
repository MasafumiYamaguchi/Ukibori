import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NeumorphismDemo } from "./NeumorphismDemo";
import "./neumorphism.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NeumorphismDemo />
  </StrictMode>,
);
