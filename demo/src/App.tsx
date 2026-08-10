import { useId, useState } from "react";
import type { UkiboriBackend } from "ukibori";
import { Surface, Ukibori, UkiboriText } from "ukibori";

/**
 * #21 React API demo: the physical renderer driven through <Ukibori> /
 * <Surface> / <UkiboriText>. The DOM stays authoritative (real buttons,
 * DOM text); the physical layer (SDF -> height field -> material lighting +
 * cast shadows) renders onto the provider's stage-root overlay.
 */

const MATERIALS = ["silicone", "matte", "metal"] as const;

const TWO_DECIMALS = (value: number) => value.toFixed(2);
const PX = (value: number) => `${value}px`;

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  format = String,
  onChange,
}: SliderControlProps) {
  const id = useId();
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{format(value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

export function App() {
  const [light, setLight] = useState({ x: -0.6, y: -0.8, z: 1 });
  const [intensity, setIntensity] = useState(1);
  const [environment, setEnvironment] = useState(0.5);
  const [environmentSpecular, setEnvironmentSpecular] = useState(1);
  const [exposure, setExposure] = useState(1);
  const [elevation, setElevation] = useState(6);
  const [thickness, setThickness] = useState(2);
  const [radius, setRadius] = useState(16);
  const [material, setMaterial] = useState<(typeof MATERIALS)[number]>("silicone");
  const [backend, setBackend] = useState<UkiboriBackend>("auto");
  const [showPlay, setShowPlay] = useState(true);

  const setLightAxis = (axis: "x" | "y" | "z") => (value: number) =>
    setLight((prev) => ({ ...prev, [axis]: value }));

  const buttonElevation = Math.min(elevation, 16);

  return (
    <Ukibori
      light={light}
      intensity={intensity}
      environment={{ intensity: environment, specularIntensity: environmentSpecular }}
      exposure={exposure}
      backend={backend}
      className="demo-root"
    >
      <div className="demo">
        <header className="demo-header">
          <h1>
            Ukibori <span className="demo-sub">浮彫 — physical 2.5D layer over real DOM</span>
          </h1>
          <p>
            DOM UI → 2.5D height field → physical material lighting + cross-element cast
            shadows. The buttons below are real DOM elements; the physical layer renders onto a
            <code> pointer-events: none </code>
            overlay owned by the provider.
          </p>
        </header>

        <div className="demo-layout">
          <aside className="demo-controls" aria-label="Physical layer controls">
            <h2>Physical layer</h2>
            <div className="field">
              <div className="field-head">
                <label htmlFor="backend-select">Backend</label>
              </div>
              <select
                id="backend-select"
                value={backend}
                onChange={(event) => setBackend(event.target.value as UkiboriBackend)}
              >
                <option value="auto">auto — physical (CPU renderer)</option>
                <option value="cpu">cpu — physical (CPU renderer)</option>
                <option value="css">css — approximation fallback (not physical)</option>
              </select>
              <p className="hint">
                The CSS path is the explicitly labeled box-shadow approximation. WebGPU is not
                selectable: its compute pipeline is not implemented (honest capability policy).
              </p>
            </div>
            <SliderControl
              label="Light x"
              value={light.x}
              min={-1}
              max={1}
              step={0.05}
              format={TWO_DECIMALS}
              onChange={setLightAxis("x")}
            />
            <SliderControl
              label="Light y"
              value={light.y}
              min={-1}
              max={1}
              step={0.05}
              format={TWO_DECIMALS}
              onChange={setLightAxis("y")}
            />
            <SliderControl
              label="Light z (height)"
              value={light.z}
              min={0}
              max={1}
              step={0.05}
              format={TWO_DECIMALS}
              onChange={setLightAxis("z")}
            />
            <SliderControl
              label="Intensity"
              value={intensity}
              min={0}
              max={2}
              step={0.05}
              format={TWO_DECIMALS}
              onChange={setIntensity}
            />
            <SliderControl
              label="Environment"
              value={environment}
              min={0}
              max={2}
              step={0.05}
              format={TWO_DECIMALS}
              onChange={setEnvironment}
            />
            <SliderControl
              label="Environment specular share"
              value={environmentSpecular}
              min={0}
              max={1}
              step={0.05}
              format={TWO_DECIMALS}
              onChange={setEnvironmentSpecular}
            />
            <SliderControl
              label="Exposure"
              value={exposure}
              min={0}
              max={4}
              step={0.05}
              format={TWO_DECIMALS}
              onChange={setExposure}
            />
            <p className="hint">
              Environment is a uniform shared fill (0 = off) applied with exposure before sRGB
              encoding — physical path only, kept independent of the directional light.
            </p>
            <SliderControl
              label="Elevation"
              value={elevation}
              min={0}
              max={100}
              step={1}
              format={PX}
              onChange={setElevation}
            />
            <SliderControl
              label="Thickness"
              value={thickness}
              min={0}
              max={10}
              step={0.5}
              format={PX}
              onChange={setThickness}
            />
            <SliderControl
              label="Radius"
              value={radius}
              min={0}
              max={60}
              step={1}
              format={PX}
              onChange={setRadius}
            />
            <div className="field">
              <div className="field-head">
                <label htmlFor="material-select">Material</label>
              </div>
              <select
                id="material-select"
                value={material}
                onChange={(event) => setMaterial(event.target.value as (typeof MATERIALS)[number])}
              >
                {MATERIALS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <div className="btn-row">
                <button
                  className="btn"
                  type="button"
                  onClick={() => setShowPlay((v) => !v)}
                >
                  {showPlay ? "Hide PLAY glyph" : "Show PLAY glyph"}
                </button>
              </div>
            </div>
            <div className="light-preview" aria-label="Light direction preview">
              <svg viewBox="-1.3 -1.3 2.6 2.6" role="img" aria-label="Light direction from above">
                <circle r={1.1} fill="none" stroke="currentColor" strokeOpacity={0.25} />
                <line
                  x1={0}
                  y1={0}
                  x2={light.x}
                  y2={light.y}
                  stroke="currentColor"
                  strokeOpacity={0.35}
                />
                <circle cx={light.x} cy={light.y} r={0.24} fill="var(--accent, #f2b93b)" />
              </svg>
              <p>
                direction ({light.x.toFixed(2)}, {light.y.toFixed(2)}, {light.z.toFixed(2)})
              </p>
            </div>
          </aside>

          <main className="demo-showcase">
            <section>
              <h2>Live card — {material} / elevation {elevation}px</h2>
              <Surface
                id="live-card"
                shape={{ kind: "roundedRect", radius }}
                variant="raised"
                elevation={0}
                thickness={3}
                bevelWidth={5}
                radius={radius}
                material={material}
                className="demo-card"
              >
                <p className="demo-card-title">The shared light is visible here</p>
                <p>
                  elevation {elevation} · thickness {thickness} · radius {radius} · intensity{" "}
                  {intensity.toFixed(2)}
                </p>
              </Surface>
            </section>

            <section className="demo-section" aria-label="Raised surfaces">
              <h2>Raised surfaces — one shared light</h2>
              <div className="demo-grid">
                {MATERIALS.map((name) => (
                  <Surface
                    key={name}
                    id={`tile-${name}`}
                    shape={{ kind: "roundedRect", radius }}
                    variant="raised"
                    elevation={elevation}
                    thickness={thickness}
                    bevelWidth={3.5}
                    radius={radius}
                    material={name}
                    className="demo-tile"
                  >
                    {name}
                  </Surface>
                ))}
              </div>
            </section>

            <section className="demo-section" aria-label="Buttons and input">
              <h2>Buttons &amp; input — real DOM, physical layer</h2>
              <div className="demo-row">
                <Surface
                  as="button"
                  id="primary"
                  type="button"
                  shape={{ kind: "roundedRect", radius }}
                  variant="raised"
                  elevation={buttonElevation}
                  thickness={thickness}
                  bevelWidth={3.5}
                  radius={radius}
                  material={material}
                  className="demo-btn"
                  onClick={() => alert(`Primary button (${material} / physical layer)`)}
                >
                  Primary
                </Surface>
                <Surface
                  as="button"
                  id="secondary"
                  type="button"
                  shape={{ kind: "roundedRect", radius }}
                  variant="raised"
                  elevation={buttonElevation}
                  thickness={thickness}
                  bevelWidth={3.5}
                  radius={radius}
                  material="matte"
                  className="demo-btn"
                  onClick={() => alert("Secondary button (matte)")}
                >
                  Secondary
                </Surface>
                <Surface
                  as="input"
                  id="field"
                  type="text"
                  placeholder="Type something…"
                  aria-label="Demo text input"
                  shape={{ kind: "roundedRect", radius }}
                  variant="raised"
                  elevation={buttonElevation}
                  thickness={thickness}
                  bevelWidth={3.5}
                  radius={radius}
                  material={material}
                  className="demo-input"
                />
              </div>
            </section>

            <section className="demo-section" aria-label="Glyph demo">
              <h2>Glyph (#19 mask path) — DOM text + physical relief</h2>
              <Surface
                id="glyph-panel"
                shape={{ kind: "roundedRect", radius }}
                variant="raised"
                elevation={0}
                thickness={3}
                bevelWidth={5}
                radius={radius}
                material="matte"
                className="demo-play-panel"
              >
                {showPlay ? (
                  <UkiboriText
                    id="play"
                    text="PLAY"
                    elevation={3}
                    thickness={0.8}
                    bevelWidth={1.1}
                    material="metal"
                    className="ukibori-text"
                  />
                ) : (
                  <span className="ukibori-text">PLAY</span>
                )}
                <p className="plain-note">
                  The text stays DOM-owned and accessible; its glyph is rasterized into a #19
                  mask and renders as physical relief with cast shadows.
                </p>
              </Surface>
            </section>
          </main>
        </div>
      </div>
    </Ukibori>
  );
}
