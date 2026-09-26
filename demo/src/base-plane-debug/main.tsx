import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Surface, Ukibori } from "ukibori";
import type { UkiboriDom } from "ukibori-dom";
import type { Material, UkiboriBackend } from "ukibori";
import "./style.css";

declare global { interface Window { __basePlaneLayers: Record<string, UkiboriDom>; } }
window.__basePlaneLayers = {};
const query = new URLSearchParams(location.search);
const legacy = query.has("legacy");
const backend = (query.get("backend") ?? "auto") as UkiboriBackend;
const floorColor = "#aeb9c4";
const linear = (n: number) => n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + 0.055) / 1.055) ** 2.4;
const floorMaterial: Material = { baseColor: { r: linear(174), g: linear(185), b: linear(196) }, roughness: 0.9, metallic: 0, ior: 1.5 };
const cases = [
  { id: "A", title: "Short shadow", caption: "Emission off · bloom off", short: true, emission: false, bloom: false },
  { id: "B", title: "Long shadow", caption: "Emission off · bloom off", short: false, emission: false, bloom: false },
  { id: "C", title: "Emission + bloom", caption: "Long shadow · emitted light + optical halo", short: false, emission: true, bloom: true },
  { id: "D", title: "Illumination, bloom off", caption: "Light reaches the floor inside the shadow", short: false, emission: true, bloom: false },
  { id: "E", title: "Receiver meets the floor", caption: "Same albedo · same height · same lighting", short: false, emission: true, bloom: false, receiver: true },
  { id: "F", title: "Legacy comparison", caption: "Fixed shadow tint · same scene as D", short: false, emission: true, bloom: false, legacy: true },
];

function Study({ study }: { study: typeof cases[number] }) {
  const [actualBackend, setActualBackend] = useState("starting");
  const [clicks, setClicks] = useState(0);
  const old = legacy || study.legacy;
  const emission = study.emission ? 18 : 0;
  const materials: Record<string, Material> = {
    floor: floorMaterial,
    blocker: { baseColor: { r: 0.12, g: 0.16, b: 0.2 }, roughness: 0.6, metallic: 0 },
    led: { baseColor: { r: 0.025, g: 0.025, b: 0.025 }, roughness: 0.9, metallic: 0,
      emissive: { r: emission * 0.04, g: emission * 0.5, b: emission } },
  };
  return <article data-case={study.id}>
    <header><span className="case-id">{study.id}</span><h2>{study.title}</h2><span className="backend">{actualBackend}</span></header>
    <Ukibori backend={backend} gpuProfiling materials={materials} basePlaneColor={old ? undefined : floorColor}
      light={{ x: -1, y: -0.15, z: study.short ? 1 : 0.2 }} intensity={2} environment={{ intensity: 0.2 }}
      angularRadius={0.035} shadow={{ samples: 8, reconstruction: { enabled: true } }} dpr={1} margin={0}
      compositing={{ emissive: { illumination: { radius: 140, intensity: 2 }, ...(study.bloom ? { bloom: { radius: 28, intensity: 0.5, threshold: 1 } } : {}), quality: 4 } }}
      className="floor-stage" style={{ background: floorColor }}
      onReady={layer => { if (layer) { window.__basePlaneLayers[study.id] = layer; setActualBackend(layer.debugState().backend); } else { delete window.__basePlaneLayers[study.id]; } }}>
      {study.receiver && <Surface sceneId="receiver" material="floor" elevation={0} thickness={0} profile={{ kind: "flat" }} radius={0}
        style={{ position: "absolute", left: 0, right: 0, top: 147, height: 77 }} />}
      <Surface sceneId="blocker" material="blocker" elevation={42} thickness={0} profile={{ kind: "flat" }} radius={0}
        aria-label="Raised blocker" style={{ position: "absolute", left: 94, top: 56, width: 21, height: 105 }} />
      <Surface sceneId="led" material="led" elevation={14} thickness={0} profile={{ kind: "flat" }} radius={0}
        aria-label="Emissive surface" style={{ position: "absolute", left: 228, top: 91, width: 42, height: 42 }} />
      {study.receiver && <div className="join"><span>base plane</span><span>owned receiver</span></div>}
      <span className="floor-label">{old ? "TRANSPARENT OVERLAY" : "PHYSICAL RECEIVER"}</span>
      {study.id === "D" && <button className="dom-button" onClick={() => setClicks(n => n + 1)} aria-label="DOM interaction check">DOM · {clicks}</button>}
    </Ukibori>
    <p>{study.caption}</p>
  </article>;
}
function App() {
  return <main>
    <div className="eyebrow">UKIBORI / ISSUE 75 / RENDERING STUDY</div>
    <h1>{legacy ? "Before · fixed shadow tint" : "Light belongs on the floor, too."}</h1>
    <p className="intro">One visibility field. Independent direct and emissive lighting. Bloom is optional.</p>
    <section className="studies">{cases.map(study => <Study key={study.id} study={study} />)}</section>
    <footer>Directional light + matte floor + one cyan emitter. D isolates physical illumination; E checks continuity. Text and controls remain ordinary DOM.</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
