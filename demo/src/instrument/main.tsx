import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Instrument } from "./Instrument";
import "./instrument.css";

createRoot(document.getElementById("root")!).render(<StrictMode><Instrument /></StrictMode>);
