# Issue #75 implementation report — physically shade the base plane

Issue: [#75](https://github.com/MasafumiYamaguchi/Ukibori/issues/75)
Branch: `codex/glyph-supersampling-shadow` (continued)

## Previous base-plane composition

- The renderer already computed a physical `color` for every pixel, including
  `NO_OWNER` (base plane), using the fixed `BASE_MATERIAL` (linear 0.6 gray,
  roughness 0.5): `ambient + direct*visibility + environment`.
- The **DOM compositor / GPU presentation** discarded that color for
  `NO_OWNER`: lit base-plane pixels were transparent (the page background shows
  through) and shadowed pixels were a fixed `shadowColor * shadowAlpha`
  premultiplied tint (`compositePixelBytes` / `presentation-pass-wgsl.ts`).
- Emissive incident light was added on top of that tint
  (`emissive-effects.ts` / `emissive-effects-wgsl.ts` / bloom passes).

So a long cast shadow on the base plane was a fixed dark wedge over the page
background and did not participate in the receiver equation — the #74 artifact.

## Final base-plane composition

```
base-plane material   = { baseColor: scene.background (linear), roughness 0.9, metallic 0, normal (0,0,1) }
basePlaneRadiance     = ambient/environment + direct * shadowVisibility + emissiveIncidentLight
presented base plane  = encode(basePlaneRadiance)  (opaque, when physicalBasePlane is active)
```

The base plane now uses the **same** `shadePreparedFields` equation as owned
surfaces; emissive incident light is added independently of `visibility`;
`shadowVisibility` is never rewritten.

## Base-plane color source (explicit contract)

- Renderer: `Scene.background?: LinearRgb` (LINEAR albedo, clamped to [0,1]).
  `undefined` keeps the historical base material + legacy tint presentation.
- DOM: `UkiboriDomOptions.background?: LinearRgb`. When set, the layer passes
  it to `buildScene` and sets `compositing.physicalBasePlane = true`.
  Deriving it from the page/stage CSS background (sRGB -> linear, once) is a
  caller/DOM concern; the renderer never reads DOM state.
- GPU ABI v5 encodes the base-plane material in the header: offsets 52/56/60 =
  linear albedo RGB, offset 92 = roughness. Without `background` the encoder
  writes the historical 0.6 gray / 0.5 so non-background scenes keep their
  exact base-plane lighting bytes.

## Required semantics

- Direct light: base-plane direct is scaled by the existing `visibility` (same
  field as normal receivers).
- Emissive incident: accumulated by the screen-space illumination pass and
  added to the base-plane color independently of `visibility`.
- Surface emission: unchanged (owned emissive surfaces).
- Ambient/environment: unchanged meaning (still added independently, not
  tinted by light color or visibility). Documented decision: the base plane's
  ambient/background ownership is explicit via `Scene.background`.
- Bloom: unchanged post-process; turning it off still leaves the physically
  shaded emissive illumination on the base plane (the illumination pass runs
  without bloom).

## Changes

- `scene.ts`: `Scene.background` / `SceneInput.background` + `BASE_PLANE_ROUGHNESS`.
- `lighting.ts`: `shadePreparedFields` uses the physical base-plane material.
- `gpu/composite.ts`, `ukibori-dom/compositor.ts`, `ukibori-dom/types.ts`:
  `CompositeOptions.physicalBasePlane` (opaque physical base plane).
- `gpu/presentation-pass-wgsl.ts` / `presentation-pass.ts`: present the physical
  base-plane color when the flag is set (params slot 28).
- `emissive-effects.ts` / `gpu/emissive-effects-wgsl.ts` /
  `emissive-bloom-pass.ts` / `emissive-effects-pass.ts` / `pipeline.ts`:
  the physical base plane follows the owned-surface composition (glow added to
  the receiver color, alpha 1).
- `gpu/layout.ts` (ABI v5), `gpu/encode.ts`, `gpu/validate.ts`, `gpu/wgsl.ts`,
  `gpu/lighting-pass-wgsl.ts`: encode/validate/consume the header base-plane
  material.
- `ukibori-dom/scene-builder.ts` / `dom-layer.ts`: `background` contract.
- Tests: `base-plane.test.ts` (6), updated ABI/rounding/presentation tests,
  `emissive-effects-parity.mjs` physical + directional cases.

## Results

- Hard / soft / reconstructed shadow: the shadow algorithm only changes
  `visibility`; the base plane consumes the same `color`, so the shadow result
  is consistent (the #74 test already pins that the emissive incident field is
  identical across the three modes; the physical base plane reuses `color`).
- Emissive off/on, bloom off/on: base plane brightens by the incident
  contribution; intensity/falloff unmatched to any new parameter.
- Owned receiver vs base plane: with ambient/environment 0 both are exactly
  `direct * visibility` (shadowed pixels are exactly black) — same equation,
  different albedo only.
- CPU/WebGPU parity: `emissive-effects-parity.mjs` now runs 88 fixtures /
  1,014,784 bytes with `physical` false/true, dpr 1/1.5, exposure 0/1,
  illumination and illumination+bloom; **max byte error 1** (tolerance 1).
- Existing non-background scenes: `physicalBasePlane` defaults to false and the
  encoder writes the historical base material, so owned-surface and legacy
  base-plane bytes are unchanged (renderer 1032 tests, DOM 213 tests, ukibori
  215 tests pass; only the 4 pre-existing `.mjs` collection-SyntaxError suites
  fail as before).

## Performance

- No new full-screen pass, buffer or texture: base-plane shading is the
  existing lighting pass; the presentation/effects passes only branch on a
  flag they already receive. No GPU->CPU readback.
- Update behavior is unchanged: `physicalBasePlane` is part of
  `composite-options` (presentation-only invalidation); light/shadow changes
  already re-run the lighting/effects path.

## Unresolved / follow-up

- React `<Ukibori background={...}>` prop and automatic resolution of the
  page/stage CSS background color are not wired yet (the DOM/renderer contract
  exists; demos can pass `UkiboriDomOptions.background`).
- Before/after screenshots were not captured in this pass.
- `Scene.background` is a flat solid albedo (gradients/background images are
  explicit non-goals).
