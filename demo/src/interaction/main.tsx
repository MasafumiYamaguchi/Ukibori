import { createRoot } from "react-dom/client";
import { InteractionLab } from "./InteractionLab";
import "../index.css";

createRoot(document.getElementById("root")!).render(
  <main className="interaction-standalone"><a href="/#interaction">← Demo dashboard</a><InteractionLab /></main>,
);
