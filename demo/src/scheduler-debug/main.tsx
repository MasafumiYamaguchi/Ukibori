import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SchedulerDebug } from "./SchedulerDebug";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SchedulerDebug />
  </StrictMode>,
);
