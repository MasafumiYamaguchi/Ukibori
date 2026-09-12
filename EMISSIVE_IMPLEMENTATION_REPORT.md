# Emissive material implementation

This report describes the self-emission PR. Optional nearby illumination and bloom
are documented in [the subsequent effects report](EMISSIVE_EFFECTS_IMPLEMENTATION_REPORT.md).

This PR is stacked on **PR #65** (`codex/issue-61-height-profiles`), so the profile
ABI v3 precedes the material ABI v4. It does not include performance PRs #66–#68,
and Issue #12 remains excluded. Merge #65 before this PR (or retain their order
when rebasing). The existing CSS text-color material overlay in #64 spreads its
resolved base material, so it also preserves the new emissive property.

## API and rendering semantics

`Material.emissive?: LinearRgb` is self-emitted linear RGB radiance. Missing values
mean black and preserve the historical material descriptor/rendered output.
For supplied channels, missing/negative/non-finite/f32-overflow values become 0;
finite HDR values above 1 are preserved and canonicalized to f32. Inputs are not
mutated. Emission adds to reflected lighting **before exposure and sRGB encoding**.
It is independent of directional light color/intensity, environment, surface
normal and shadow visibility. Diffuse/specular diagnostic fields retain their
original meaning. Nonzero addition saturates at the GPU's finite f32 maximum;
zero channels preserve the original arithmetic path.

Self-emission does not illuminate neighboring surfaces or implement bloom. The
current final color target is RGBA8: exposure is applied before display clipping.
CSS approximation rendering does not implement physical emission.

## Data path

- Renderer: `createScene({ materials })` / `Material.emissive`.
- DOM: existing `UkiboriDom.create({ materials })` and `setMaterials` pass the
  same table through to both renderers, with no DPR scaling of radiance.
- React: new `<Ukibori materials={...}>` prop, with Material/LinearRgb type exports.
  Canonical content keys detect in-place channel edits on re-render; removing
  the prop clears the overrides. Layers and surface registrations stay retained.
  Imperative onReady/setMaterials usage is preserved when no prop is supplied.
- Emission edits classify as material-value changes: upload, lighting and
  presentation only. Retained geometry, normals, raw shadows and reconstruction
  are not recomputed.

## ABI

ABI v4 assigns material bytes 32–43 to emissive RGB. Bytes 28, 44–63 remain zero
padding/reserved. Material records stay 64 bytes, surface records stay 128 bytes;
no new bindings, passes, GPU allocations, readbacks or transfer bytes are required.
Encoded v1/v2/v3 input is rejected and must be re-encoded. The descriptor API is
backward-compatible for non-emissive materials. Strict validation checks each
emission channel and all remaining reserved words.

## Verification

- Full `npm test`: renderer 1090, DOM 161, React 208 tests passed, plus dev-loop gates.
- Full workspace build and typecheck passed.
- Historical CPU golden digests pass without regeneration.
- CPU tests cover darkness, occlusion, normal independence, HDR, exposure zero,
  sanitization, invalid ABI input, emission removal and retained scheduling.
- React test covers initial material input, in-place emissive channel edits,
  prop removal and stable layer/registration identities.
- Native Dawn + SwiftShader 5.0.0: 126 cases, 77,952 RGBA8 bytes exactly equal to CPU.
- Chromium 153.0.8010.0 + WebGPU: same 126 cases and 77,952 exact bytes, no browser errors.
- Matrix: zero/threshold/ordinary/HDR/F32_MAX emission; exposures 0/0.125/1;
  DPR 1/1.5/2; completely shadowed/unshadowed lighting inputs; isolated emission
  and emission combined with reflection/environment illumination. Controlled
  visibility values isolate lighting semantics; these are not shadow-physics tests.
- Browser demo visually checked with emission 0, 0.8 and 4 at external light 0.

The GPU devices used software Vulkan/SwiftShader. This proves executable WebGPU
shader parity on those runtimes; hardware-vendor performance is not claimed.
Raw verification summaries: `packages/renderer/emissive-validation.json`.

## Demo and reproduction

`npm run dev` then `/emissive-debug.html`: cyan/coral/lime materials with emission,
external light and exposure sliders. Documentation includes a React usage example.

Build the renderer, then run `npm run test:emissive:webgpu -w ukibori-renderer`.
The optional native runner requires the separately installed `webgpu` Dawn package
or `UKIBORI_WEBGPU_MODULE` pointing to it, and fails rather than using a null backend.
The shared `test-browser/emissive-parity.mjs` runner also accepts a browser GPUDevice.
