import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Surface, Ukibori } from "ukibori";
import type { Material } from "ukibori";
import "./style.css";

function App() {
  const [emission, setEmission] = useState(2);
  const [light, setLight] = useState(0);
  const [exposure, setExposure] = useState(1);
  const [spill, setSpill] = useState(1.5);
  const [bloom, setBloom] = useState(0.6);
  const [backend, setBackend] = useState("starting");
  const materials: Record<string, Material> = {};
  for (const [name, rgb] of Object.entries({ cyan: [0.03, 0.65, 1], coral: [1, 0.12, 0.06], lime: [0.3, 1, 0.03] })) {
    materials[name] = { baseColor: { r: 0.025, g: 0.025, b: 0.025 }, roughness: 0.5, metallic: 0,
      emissive: { r: rgb[0] * emission, g: rgb[1] * emission, b: rgb[2] * emission } };
  }
  return <main>
    <header><p className="eyebrow">UKIBORI / MATERIAL STUDY</p><h1>Color that emits light.</h1>
      <p>Visible emitters illuminate nearby surfaces. Bloom spreads their HDR color into a soft halo.</p></header>
    <div className="scene-wrap"><Ukibori backend="auto" materials={materials} intensity={light} light={{ x: 0, y: 0, z: 1 }}
      environment={{ intensity: 0 }} exposure={exposure} dpr={1} margin={0}
      compositing={{ emissive: { illumination: { intensity: spill, radius: 72 }, bloom: { intensity: bloom, radius: 32, threshold: 1 }, quality: 4 } }}
      onReady={layer => setBackend(layer?.debugState().backend ?? "starting")}>
      <div className="scene">
        {Object.keys(materials).map(name => <div className="sample" key={name}>
          <Surface as="div" sceneId={name} material={name} elevation={2} thickness={6}
            bevelWidth={4} radius={18} className="light-tile" aria-label={`${name} emissive surface`} />
          <Surface as="div" sceneId={`${name}-receiver`} material="matte" elevation={1} thickness={2}
            bevelWidth={2} radius={6} className="receiver" aria-label={`${name} receiving surface`} />
          <span>{name.toUpperCase()}</span>
        </div>)}
      </div>
    </Ukibori></div>
    <section className="controls" aria-label="Emission controls">
      <label>Emission <output>{emission.toFixed(2)}</output><input aria-label="Emission" type="range" min="0" max="4" step="0.05" value={emission} onChange={e => setEmission(+e.target.value)} /></label>
      <label>External light <output>{light.toFixed(2)}</output><input aria-label="External light" type="range" min="0" max="3" step="0.05" value={light} onChange={e => setLight(+e.target.value)} /></label>
      <label>Exposure <output>{exposure.toFixed(2)}</output><input aria-label="Exposure" type="range" min="0" max="2" step="0.05" value={exposure} onChange={e => setExposure(+e.target.value)} /></label>
      <label>Nearby light <output>{spill.toFixed(2)}</output><input aria-label="Nearby light" type="range" min="0" max="3" step="0.05" value={spill} onChange={e => setSpill(+e.target.value)} /></label>
      <label>Bloom <output>{bloom.toFixed(2)}</output><input aria-label="Bloom" type="range" min="0" max="2" step="0.05" value={bloom} onChange={e => setBloom(+e.target.value)} /></label>
    </section>
    <footer><span>{backend}</span><p>The small bars receive light without emitting. Nearby light uses a screen-space approximation; bloom uses emission above the HDR threshold.</p></footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
