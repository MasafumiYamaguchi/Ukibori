# Issue #28 implementation brief — GPU BRDF/material lighting

## Context

Issue #24 froze the byte-exact WebGPU scene ABI and direct GPU upload.
Issue #25 produces GPU-resident height, coverage, object-id, material-id and
caster-height fields. Issue #26 produces a tightly packed GPU normal field.
Issue #27 produces binary GPU shadow visibility. Treat those implementations,
the #13 coordinate contract, the #16 Cook-Torrance model, and the #22
environment/exposure behavior as fixed semantic inputs.

The TypeScript reference is `packages/renderer/src/lighting.ts`, together
with `brdf.ts`, `environment.ts`, and `material.ts`. This issue moves only
material evaluation and final color generation to WebGPU. Keep
`WebGpuBackend.capabilities.compute` false until #29 presentation and the
later parity/default-backend checkpoints are complete. Preserve DOM/React
behavior and do not implement #29 in this checkpoint.

## Objective

Add a real WebGPU compute stage that consumes the exact GPU-resident normal,
material ownership and shadow visibility fields plus the uploaded scene
header/material table, evaluates the existing BRDF/environment/exposure
model, and leaves final encoded color GPU-resident for #29. Normal execution
must not read any intermediate or color buffer back to JavaScript.

## Fixed lighting and color semantics

Mirror `shadeHeightField` and the #22 regression suite without redesign:

1. Coordinates are `+x right`, `+y down`, `+z toward viewer`; the encoded
   normalized light direction points from the receiver toward the light.
   The fixed view direction is `V = (0, 0, 1)`.
2. Per texel, consume the #26 tightly packed f32 xyz normal, #25 u32
   material-id, and #27 f32 visibility directly. Do not recompute normals,
   ownership or shadows and do not upload host replacements.
3. `materialId == NO_OWNER` uses the fixed `BASE_MATERIAL`. A valid material
   id indexes the uploaded ABI `MaterialRecord`. Invalid non-sentinel ids are
   a defensive base-material fallback; valid #25 output never emits them.
4. Preserve the #16 direct BRDF exactly:
   - GGX/Trowbridge-Reitz NDF with `alpha = max(roughness^2, 1e-4)`;
   - height-correlated Smith visibility;
   - Schlick Fresnel at `V dot H`;
   - dielectric F0 from `((ior - 1) / (ior + 1))^2`;
   - metallic workflow F0 mix;
   - Lambert diffuse with `1 / PI`; metals have no diffuse term.
5. Direct contribution is scaled by `lightIntensity * max(N dot L, 0) *
   clamp(visibility, 0, 1)`. Visibility affects only direct light. Ambient
   and environment remain visible in cast shadow.
6. Preserve #22 environment exactly:
   - diffuse = `baseColor * (1 - metallic) * envIntensity * diffuseShare`;
   - specular = `envIntensity * (F0 + (1 - F0) *
     (1 - roughness)^5) * specularShare`.
7. Preserve the existing ambient default `0.08`, clamped to `[0, 1]` after
   finite/f32 sanitization. Expose the effective packed ambient in the pass
   snapshot. Changing ambient may rewrite params and redispatch while
   reusing all allocations/pipelines.
8. Accumulate in linear RGB, apply encoded scene exposure to the whole
   linear result, clamp per channel to `[0, 1]`, then apply the exact sRGB
   transfer function and `floor(encoded * 255 + 0.5)` so it mirrors
   JavaScript `Math.round` for non-negative channels. Alpha is 255.
9. Output one packed RGBA8 texel (4 logical bytes) in byte order R,G,B,A.
   The host representation may be `array<u32>` as long as little-endian
   readback yields those exact bytes and the public snapshot documents it.
10. Preserve the CPU debug meanings:
    - diffuse output = raw `max(N dot L, 0)`;
    - specular output = `min(luminance(brdf.specular) * NdotL * visibility,
      1)` before light intensity.
    Keep both as tightly packed f32 GPU-resident outputs so mismatches can be
    localized without changing the final-color shader path.
11. The degenerate half vector (`L = -V`) produces zero direct BRDF and no
    NaN. Every valid ABI/f32 input, including zero exposure/environment,
    roughness/metallic endpoints and largest-finite-f32 stress values, must
    produce finite deterministic outputs. Implement overflow-safe saturated
    non-negative add/multiply before exposure so `0 * overflow` cannot turn
    into NaN. The ABI is f32: raw CPU scene values that cannot be represented
    as finite f32 remain an encoder/validation fallback concern, not a reason
    to weaken ABI validation.

## CPU oracle seam

The real-GPU oracle must use the actual TypeScript lighting implementation,
not a second JavaScript copy of the formulas. A narrow refactor may expose a
prepared-field shading helper (normal + object/material ownership +
visibility) and have `shadeHeightField` call it, provided all existing CPU
tests and byte results remain unchanged. This lets the harness feed the same
render extent, f32-packed scene values, effective normal options and stable
visibility into the semantic reference.

## LightingPass contract

Add focused host/WGSL modules under `packages/renderer/src/gpu/`.

1. Own one cached shader module, explicit bind-group/pipeline layouts,
   reusable/growing params and output allocations, stable snapshots/dispatch
   statistics, and idempotent `dispose()`.
2. Bind the exact uploaded scene header and material table, the exact #25
   material-id allocation, exact #26 normal allocation, and exact #27
   visibility allocation. A suitable single-pass binding plan is five
   read-only storage inputs plus three output storage buffers, exactly the
   WebGPU minimum storage-buffer budget of eight, plus a uniform params
   binding. Do not exceed the reported per-stage limit.
3. Propagate the unique per-HeightPass-dispatch provenance through integrated
   NormalPass and ShadowPass snapshots where necessary. All three lighting
   fields must share the same per-dispatch token, whose exact `sceneBytes`,
   width, height and DPR match the encoded scene/upload. Synthetic test-only
   inputs may use an explicitly documented provenance seam. Reject foreign
   or mixed fields before any lighting-device call.
4. Strict-validate the encoded scene and uploader provenance/section lengths.
   Validate positive integer extent, safe/u32 texel arithmetic, formats,
   channels, logical bytes, STORAGE usage, actual buffer coverage, material
   count/table range, workgroup limits, dispatch limits, explicit binding
   ranges, output allocation limits and `maxStorageBuffersPerShaderStage >=
   8` before any device call.
5. Every `GPUBufferBinding` must carry an explicit validated `size`. For an
   empty logical material table bind the uploader's one-record ABI floor
   (`MATERIAL_STRIDE`) while avoiding all shader reads from it.
6. Use one invocation per render texel, a 1D workgroup size of 64 and a
   ceil-divided dispatch with an in-shader texel guard.
7. Outputs are tightly packed row-major:
   - diffuse: scalar f32, 4 bytes/texel;
   - specular: scalar f32, 4 bytes/texel;
   - color: packed RGBA8, 4 bytes/texel.
   All production outputs use `STORAGE | COPY_SRC | COPY_DST`, are never
   mapped, and remain GPU-resident for #29.
8. Document and test the params uniform byte layout, WGSL scalar widths,
   output byte order, f32 sanitization, little-endian packing, allocation
   reuse/growth and pipeline caching.
9. Use actual WebGPU compute calls. Production code must contain no
   `mapAsync`, mapped-range or staging-readback path; test-only real-adapter
   readback stays in `test-browser/parity.mjs`.
10. Export the internal-stage API from `packages/renderer/src/index.ts`.
    Do not add a Canvas/render presentation API or select WebGPU publicly.

## Node verification

Add focused tests for:

- explicit layout/pipeline creation, storage budget, command order,
  workgroup ceil division, caching and direct input-buffer identity;
- scene/upload/height-normal-shadow provenance, including fields mixed from
  two dispatches of the exact same EncodedScene;
- exact uniform packing and ambient sanitization (NaN, infinities, negative,
  f32 overflow and ordinary custom values);
- RGBA byte order, sRGB transfer/rounding source pins, alpha 255, output
  formats/bytes/usages, stable snapshot, allocation reuse/growth/disposal;
- WGSL pins for GGX, shared alpha regularization, Smith, Schlick, dielectric
  F0, metallic mix, Lambert `1/PI`, environment diffuse/specular, visibility
  only on direct light, exposure order and degenerate half-vector handling;
- base-plane material and invalid-id fallback without an out-of-bounds
  material read, including a zero-material scene;
- zero exposure/environment, share endpoints, roughness/metallic endpoints,
  largest-finite-f32 stress values and finite output guarantees;
- every pre-device structural/device/binding/allocation rejection path;
- absence of map/readback APIs and `WebGpuBackend.capabilities.compute`
  remaining false.

Mocks prove host orchestration only. Numeric shader claims require the real
adapter harness.

## Real-GPU CPU parity

Extend `npm run test:webgpu -w ukibori-renderer` so every integrated fixture
runs:

```text
SceneUploader -> HeightPass -> NormalPass -> ShadowPass -> LightingPass
```

Use staging only after submission in the test harness. Compare diffuse,
specular and RGBA8 against the actual TypeScript oracle at the same render
extent with f32-packed scene/material values and effective options.

- Require alpha and byte-order invariants exactly.
- Use an explicit tight f32 tolerance for diffuse/specular and report the
  maximum errors.
- Require exact RGBA8 where fixtures have stable quantization margins;
  otherwise permit at most one encoded byte with a documented rounding-error
  justification, report per-channel maxima, and fail any larger difference.
- Add #22 color fixtures covering silicone/matte/metal, environment OFF/ON,
  exposure 0/low/default/high, visibility 0/1, light movement, base plane,
  material overrides, degenerate half vector, DPR 1/1.5/2, and finite f32
  stress inputs. Assert that environment/exposure do not mutate upstream
  height/normal/ownership/visibility buffers.
- Any shader compilation message, validation error, fixture throw,
  non-finite debug output, source-buffer mutation or mismatch emits the
  anchored FAIL marker.

Update the 640x360 benchmark to include LightingPass in the timed GPU chain
and the equivalent CPU final-color work. Keep 5 warmups, 10 samples,
submission-to-`queue.onSubmittedWorkDone()` timing, parity outside the timed
region and the existing >=2x requirement. Report effective ambient and final
color parity with the existing pass metrics.

## Verification commands

Run and report all of:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:webgpu -w ukibori-renderer`

## Non-goals

- No Canvas/context configuration, render pipeline, texture presentation,
  DOM compositing or backend selection (#29+).
- No BRDF/material/environment/public API redesign, HDRI/cubemap/IBL LUT,
  tone mapper, postprocessing or magic brightness/gamma compensation.
- No CPU readback/re-upload in the production path.
- No change to geometry, normal or shadow semantics to make lighting parity
  easier.
- No #30 default-backend/golden-suite policy change.

## Completion report

Report bindings and uniform layout; exact BRDF/environment/exposure/color
contract; output formats/byte order; provenance and allocation reuse;
workgroups; real-adapter fixture/color mismatch totals and measured errors;
benchmark dimensions/samples/medians/speedup; test totals; and the explicit
#29 presentation work still deferred. Do not commit, push, reset, clean or
discard changes. Stop for Codex review.
