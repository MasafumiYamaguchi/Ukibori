import { useCallback, useEffect, useRef, useState } from "react";
import type { BakeHandle, Material } from "ukibori";
import { Bake, Surface, Ukibori, UkiboriText } from "ukibori";
import { DebugSnapshotPanel } from "./DebugSnapshotPanel";
import { SliderControl } from "./SliderControl";
import type { ReadyLayer } from "./useDebugSnapshot";
import { useDebugSnapshot } from "./useDebugSnapshot";

/**
 * Feature Lab — every feature is exercised through the public React API only
 * (<Ukibori>, <Surface>, <UkiboriText>, <Bake>).
 *
 * Sections:
 *   1. ordered physical composition (chassis -> inset cutter -> raised knob)
 *   2. profile curves and raised/inset modes
 *   3. roundedRect vs SVG gear path shapes with a fillRule control
 *   4. nested Bake boundaries with dynamic/inner/outer invalidation actions
 *   5. event-driven debugState snapshot (never polled)
 *   6. UkiboriText color fidelity, including the documented alpha fallback
 */

type ProfileKind = "step" | "linear" | "smooth" | "convex" | "concave" | "power";
type ProfileMode = "raised" | "inset";
type PowerBias = "in" | "out";
type FillRule = "nonzero" | "evenodd";
type TextColorId = "ink" | "red" | "blue" | "white" | "alpha";

const PROFILE_KINDS: readonly ProfileKind[] = [
  "step",
  "linear",
  "smooth",
  "convex",
  "concave",
  "power",
];

const FEATURE_MATERIALS: Record<string, Material> = {
  panel: { baseColor: { r: 0.34, g: 0.35, b: 0.38 }, roughness: 0.8, metallic: 0 },
};

const TEXT_COLORS: readonly { id: TextColorId; label: string; value: string; note: string }[] = [
  { id: "ink", label: "#111", value: "#111111", note: "opaque — physical glyph" },
  { id: "red", label: "red", value: "red", note: "opaque — physical glyph" },
  { id: "blue", label: "blue", value: "blue", note: "opaque — physical glyph" },
  { id: "white", label: "white", value: "white", note: "opaque — physical glyph" },
  {
    id: "alpha",
    label: "red @ 35% alpha",
    value: "rgba(255, 0, 0, 0.35)",
    note: "alpha — intentional DOM-visible fallback",
  },
];

/**
 * A 12-tooth gear with a same-winding hub. Nonzero fills the hub; evenodd
 * punches it out, so the fillRule control has a visibly different result.
 */
function gearPathData(): string {
  const cx = 50;
  const cy = 50;
  const teeth = 12;
  const outer = 46;
  const root = 35;
  const steps = teeth * 4;
  const parts: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    const radius = i % 4 < 2 ? outer : root;
    parts.push(
      `${i === 0 ? "M" : "L"}${(cx + radius * Math.cos(angle)).toFixed(2)} ${(
        cy +
        radius * Math.sin(angle)
      ).toFixed(2)}`,
    );
  }
  parts.push("Z");
  const hub = 16;
  parts.push(`M${(cx + hub).toFixed(2)} ${cy.toFixed(2)}`);
  for (let i = 1; i <= 48; i += 1) {
    const angle = (i / 48) * Math.PI * 2;
    parts.push(
      `L${(cx + hub * Math.cos(angle)).toFixed(2)} ${(cy + hub * Math.sin(angle)).toFixed(2)}`,
    );
  }
  parts.push("Z");
  return parts.join(" ");
}

const GEAR_PATH = gearPathData();
const GEAR_VIEWBOX = [0, 0, 100, 100] as const;

export function FeatureLab() {
  const [layer, setLayer] = useState<ReadyLayer>(null);

  // --- profile bench ---
  const [profileKind, setProfileKind] = useState<ProfileKind>("smooth");
  const [profileMode, setProfileMode] = useState<ProfileMode>("raised");
  const [powerExponent, setPowerExponent] = useState(2);
  const [powerBias, setPowerBias] = useState<PowerBias>("in");

  // --- shape comparison ---
  const [shapeRadius, setShapeRadius] = useState(22);
  const [gearFillRule, setGearFillRule] = useState<FillRule>("evenodd");

  // --- nested Bake demo ---
  const outerBakeRef = useRef<BakeHandle>(null);
  const innerBakeRef = useRef<BakeHandle>(null);
  const [outerRev, setOuterRev] = useState(0);
  const [innerRev, setInnerRev] = useState(0);
  const [dynamicRev, setDynamicRev] = useState(0);
  const [bakeStatus, setBakeStatus] = useState(
    "No action yet — pick an action to see how the snapshot counters respond.",
  );

  // --- UkiboriText colors ---
  const [textColor, setTextColor] = useState<TextColorId>("red");

  const { snapshot, refreshNow, refreshAfterRender } = useDebugSnapshot(layer);

  // Every explicit Feature Lab control operation — profile kind/mode, power
  // exponent/bias, rounded radius, SVG fill rule, text color and the three
  // Bake actions — triggers exactly one event-driven refresh once React and
  // Ukibori's scheduled render have settled. The hook waits through
  // requestAnimationFrame + a macrotask; there is no polling or interval.
  useEffect(() => {
    refreshAfterRender();
  }, [
    profileKind,
    profileMode,
    powerExponent,
    powerBias,
    shapeRadius,
    gearFillRule,
    textColor,
    dynamicRev,
    innerRev,
    outerRev,
    refreshAfterRender,
  ]);

  const dynamicElevation = 6 + (dynamicRev % 3) * 4;

  const benchProfile =
    profileKind === "power"
      ? { kind: "power" as const, exponent: powerExponent, bias: powerBias, mode: profileMode }
      : { kind: profileKind, mode: profileMode };

  const gearShape = {
    kind: "svgPath" as const,
    d: GEAR_PATH,
    viewBox: GEAR_VIEWBOX,
    fillRule: gearFillRule,
  };

  const selectedTextColor = TEXT_COLORS.find((entry) => entry.id === textColor)!;

  const changeDynamicOnly = useCallback(() => {
    setDynamicRev((rev) => rev + 1);
    setBakeStatus(
      "Dynamic-only change: the dynamic surface outside Bake updates; baked boundaries stay retained (lastRebakeSurfaceCount should remain 0).",
    );
  }, []);

  const invalidateInnerOnly = useCallback(() => {
    setInnerRev((rev) => rev + 1);
    innerBakeRef.current?.invalidate();
    setBakeStatus(
      "Inner invalidate only: the inner boundary rebakes and the outer boundary is untouched (inner invalidation never cascades upward).",
    );
  }, []);

  const invalidateOuterCascade = useCallback(() => {
    setOuterRev((rev) => rev + 1);
    outerBakeRef.current?.invalidate();
    setBakeStatus(
      "Outer invalidate: the outer boundary rebakes and cascades into the nested inner boundary.",
    );
  }, []);

  return (
    <Ukibori
      light={{ x: -0.5, y: -0.7, z: 1 }}
      intensity={1}
      materials={FEATURE_MATERIALS}
      // Demo-local shadow bias: the 1px-scale glyph relief (thickness 2) is
      // still thinner than the renderer's 0.5 default acne guard, so the thin
      // PLAY silhouette needs the same reduced bias as the Playground (0.15).
      // The renderer default itself is unchanged.
      shadow={{ bias: 0.15 }}
      gpuProfiling
      className="fl-root"
      onReady={setLayer}
    >
      <header className="dash-view-head">
        <h2>Feature lab</h2>
        <p>
          Every surface below is registered through the public React API: <code>Ukibori</code>,{" "}
          <code>Surface</code>, <code>UkiboriText</code> and <code>Bake</code>. Scene order,
          profile curves, shape rasterization, bake boundaries and the on-demand debug snapshot
          are all driven by real physical surfaces.
        </p>
      </header>

      <section className="fl-section" aria-labelledby="fl-composition-heading">
        <h3 id="fl-composition-heading">Ordered physical composition</h3>
        <p>
          Scene order is physical: the chassis is composed first, the inset cutter carves the
          surfaces composed before it, and the raised knob sits above both and casts its own
          shadow.
        </p>
        <div className="fl-stage fl-composition-stage" aria-label="Ordered composition stage">
          <Surface
            sceneId="fl-chassis"
            shape={{ kind: "roundedRect", radius: 18 }}
            elevation={0}
            thickness={5}
            bevelWidth={12}
            profile={{ kind: "smooth" }}
            material="matte"
            className="fl-layer fl-chassis"
          >
            chassis — composed first
          </Surface>
          <Surface
            sceneId="fl-cutter"
            shape={{ kind: "roundedRect", radius: 28 }}
            elevation={0}
            thickness={4}
            bevelWidth={18}
            profile={{ kind: "smooth", mode: "inset" }}
            material="silicone"
            className="fl-layer fl-cutter"
          >
            inset cutter — carves earlier surfaces
          </Surface>
          <Surface
            sceneId="fl-knob"
            shape={{ kind: "roundedRect", radius: 14 }}
            elevation={12}
            thickness={5}
            bevelWidth={8}
            profile={{ kind: "smooth" }}
            material="metal"
            className="fl-layer fl-knob"
          >
            raised knob
          </Surface>
        </div>
      </section>

      <section className="fl-section" aria-labelledby="fl-profile-heading">
        <h3 id="fl-profile-heading">Profile curves and height modes</h3>
        <div className="fl-columns">
          <div className="fl-stage fl-bench-stage" aria-label="Profile preview stage">
            <Surface
              sceneId="fl-bench-base"
              shape={{ kind: "roundedRect", radius: 16 }}
              elevation={0}
              thickness={5}
              bevelWidth={10}
              profile={{ kind: "smooth" }}
              material="matte"
              className="fl-layer fl-bench-base"
            >
              base plate
            </Surface>
            <Surface
              sceneId="fl-bench-preview"
              shape={{ kind: "roundedRect", radius: 20 }}
              elevation={0}
              thickness={7}
              bevelWidth={18}
              profile={benchProfile}
              material="silicone"
              className="fl-layer fl-bench-preview"
            >
              {profileKind} · {profileMode}
            </Surface>
          </div>
          <div className="fl-controls">
            <div className="field">
              <div className="field-head">
                <label htmlFor="fl-profile-kind">Profile kind</label>
              </div>
              <select
                id="fl-profile-kind"
                value={profileKind}
                onChange={(event) => setProfileKind(event.target.value as ProfileKind)}
              >
                {PROFILE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="fl-fieldset">
              <legend>Mode</legend>
              <label className="radio">
                <input
                  type="radio"
                  name="fl-profile-mode"
                  checked={profileMode === "raised"}
                  onChange={() => setProfileMode("raised")}
                />
                raised
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="fl-profile-mode"
                  checked={profileMode === "inset"}
                  onChange={() => setProfileMode("inset")}
                />
                inset
              </label>
              <p className="hint">
                Raised profiles add height above the base; inset profiles carve earlier
                surfaces in scene order.
              </p>
            </fieldset>
            <SliderControl
              label="Power exponent"
              value={powerExponent}
              min={0.25}
              max={4}
              step={0.05}
              format={(value) => value.toFixed(2)}
              disabled={profileKind !== "power"}
              hint="Only used by the power curve."
              onChange={setPowerExponent}
            />
            <fieldset className="fl-fieldset" disabled={profileKind !== "power"}>
              <legend>Power bias</legend>
              <label className="radio">
                <input
                  type="radio"
                  name="fl-power-bias"
                  checked={powerBias === "in"}
                  onChange={() => setPowerBias("in")}
                />
                in
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="fl-power-bias"
                  checked={powerBias === "out"}
                  onChange={() => setPowerBias("out")}
                />
                out
              </label>
              <p className="hint">Only used by the power curve.</p>
            </fieldset>
          </div>
        </div>
      </section>

      <section className="fl-section" aria-labelledby="fl-shape-heading">
        <h3 id="fl-shape-heading">Shapes: rounded rect vs SVG gear path</h3>
        <div className="fl-columns">
          <div className="fl-stage fl-shape-stage" aria-label="Shape comparison stage">
            <Surface
              sceneId="fl-shape-rounded"
              shape={{ kind: "roundedRect", radius: shapeRadius }}
              elevation={4}
              thickness={6}
              bevelWidth={7}
              profile={{ kind: "smooth" }}
              material="silicone"
              className="fl-layer fl-shape-rounded"
            >
              roundedRect
            </Surface>
            <Surface
              sceneId="fl-shape-gear"
              shape={gearShape}
              elevation={4}
              thickness={6}
              bevelWidth={7}
              profile={{ kind: "smooth" }}
              material="metal"
              className="fl-layer fl-shape-gear"
            >
              {gearFillRule}
            </Surface>
          </div>
          <div className="fl-controls">
            <SliderControl
              label="Rounded-rect radius"
              value={shapeRadius}
              min={0}
              max={48}
              step={1}
              format={(value) => `${value}px`}
              onChange={setShapeRadius}
            />
            <fieldset className="fl-fieldset">
              <legend>SVG fill rule</legend>
              <label className="radio">
                <input
                  type="radio"
                  name="fl-fill-rule"
                  checked={gearFillRule === "nonzero"}
                  onChange={() => setGearFillRule("nonzero")}
                />
                nonzero
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="fl-fill-rule"
                  checked={gearFillRule === "evenodd"}
                  onChange={() => setGearFillRule("evenodd")}
                />
                evenodd
              </label>
              <p className="hint">
                The gear outline and hub are drawn in the same winding direction: nonzero fills
                the hub, evenodd punches it out. The DOM layer rasterizes the path data into a
                coverage mask and reports it in svgRasterizationCount / svgCacheSize.
              </p>
            </fieldset>
          </div>
        </div>
      </section>

      <section className="fl-section" aria-labelledby="fl-bake-heading">
        <h3 id="fl-bake-heading">Nested Bake boundaries</h3>
        <p>
          The outer surface lives directly in the outer <code>Bake</code>; the inner surface
          lives in a nested <code>Bake</code>; the dynamic surface is outside every boundary.
          All of them still share the same physical scene, lighting and cast shadows.
        </p>
        <div className="btn-row fl-actions">
          <button type="button" className="btn" onClick={changeDynamicOnly}>
            Dynamic-only change
          </button>
          <button type="button" className="btn" onClick={invalidateInnerOnly}>
            Invalidate inner Bake only
          </button>
          <button type="button" className="btn" onClick={invalidateOuterCascade}>
            Invalidate outer Bake (cascade)
          </button>
        </div>
        <p className="hint" role="status" aria-live="polite">
          {bakeStatus}
        </p>
        <div className="fl-stage fl-bake-stage" aria-label="Nested bake stage">
          <Bake ref={outerBakeRef}>
            <Surface
              sceneId="fl-bake-outer"
              shape={{ kind: "roundedRect", radius: 16 }}
              elevation={0}
              thickness={5}
              bevelWidth={10}
              profile={{ kind: "smooth" }}
              material="matte"
              className="fl-layer fl-bake-outer"
            >
              outer Bake · content rev {outerRev}
            </Surface>
            <Bake ref={innerBakeRef}>
              <Surface
                sceneId="fl-bake-inner"
                shape={{ kind: "roundedRect", radius: 16 }}
                elevation={0}
                thickness={5}
                bevelWidth={10}
                profile={{ kind: "smooth" }}
                material="silicone"
                className="fl-layer fl-bake-inner"
              >
                inner Bake · content rev {innerRev}
              </Surface>
            </Bake>
          </Bake>
          <Surface
            sceneId="fl-bake-dynamic"
            shape={{ kind: "roundedRect", radius: 16 }}
            elevation={dynamicElevation}
            thickness={5}
            bevelWidth={10}
            profile={{ kind: "smooth" }}
            material="metal"
            className="fl-layer fl-bake-dynamic"
          >
            dynamic · elevation {dynamicElevation}px
          </Surface>
        </div>
        <p className="hint">
          The snapshot below reports bakeBoundaryCount, bakedSurfaceCount,
          dynamicSurfaceCount and lastRebakeSurfaceCount so each action&apos;s effect is
          observable: dynamic-only updates keep lastRebakeSurfaceCount at 0, the inner action
          rebakes the inner boundary only, and the outer action cascades into the nested inner
          boundary.
        </p>
      </section>

      <DebugSnapshotPanel snapshot={snapshot} refreshNow={refreshNow} />

      <section className="fl-section" aria-labelledby="fl-text-heading">
        <h3 id="fl-text-heading">UkiboriText color fidelity</h3>
        <div className="fl-columns">
          <Surface
            sceneId="fl-text-panel"
            shape={{ kind: "roundedRect", radius: 18 }}
            elevation={0}
            thickness={4}
            bevelWidth={10}
            profile={{ kind: "smooth" }}
            material="panel"
            className="fl-text-panel"
          >
            <UkiboriText
              id="fl-text"
              text="PLAY"
              // Absolute scene z (#13): the panel top is elevation 0 +
              // thickness 4 = z 4, so the glyph base must be 4 (not a
              // parent-relative offset) and thickness 2 puts its top at z 6.
              elevation={4}
              thickness={2}
              bevelWidth={1.4}
              material="metal"
              style={{ color: selectedTextColor.value }}
              className="fl-text"
            />
          </Surface>
          <fieldset className="fl-fieldset">
            <legend>Text color</legend>
            {TEXT_COLORS.map((entry) => (
              <label key={entry.id} className="radio">
                <input
                  type="radio"
                  name="fl-text-color"
                  checked={textColor === entry.id}
                  onChange={() => setTextColor(entry.id)}
                />
                <span>{entry.label}</span>
                <span className="fl-radio-note"> — {entry.note}</span>
              </label>
            ))}
            <p className="hint" role="note">
              Opaque computed colors are converted once to linear RGB and become the physical
              glyph&apos;s base color, so the DOM ink is suppressed while the raster is
              faithful. The partially transparent choice is the documented fallback: the
              renderer is RGB-only, so the physical glyph is excluded and the DOM text stays
              visible — alpha is intentional and DOM-visible. Text, selection, copy, labels and
              focus all remain semantic DOM.
            </p>
          </fieldset>
        </div>
      </section>
    </Ukibori>
  );
}
