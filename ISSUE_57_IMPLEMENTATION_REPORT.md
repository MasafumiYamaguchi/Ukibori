# Issue #57 implementation report

Issue: [#57 — Optimize dynamic soft-shadow rendering for real-time lighting](https://github.com/MasafumiYamaguchi/Ukibori/issues/57)

Implementation commit: `aba9d4f495026c825ace824c07b3334ac9b1de26`

## Production-shaped acceptance workload

The acceptance case models the main DOM demo after UkiboriDom's production
DPR transform. A 768x720 CSS-pixel region at display DPR 2 becomes a
1536x1440 device-space scene; the renderer receives pipeline DPR 1 because
the DOM layer has already scaled the scene and CSS-space shadow lengths.

| Parameter | Value |
| --- | ---: |
| Render extent | 1536x1440 |
| Display DPR / pipeline DPR | 2 / 1 |
| Render texels | 2,211,840 |
| Surfaces / casters | 9 / 9 |
| Caster union AABB coverage | 68.52% |
| Angular radius | 0.15 |
| Shadow samples | 8 |
| Effective stepSize | 1 device px (= 0.5 CSS px at DPR 2) |
| Effective maxDistance | 3827.5542 device px |
| maxDistance source | production default `sceneDiagonal / abs(light.xy)` |
| Reconstruction | enabled, radius 4 device px (= 2 CSS px) |
| Samples | 10 warmups + 100 measured continuously changing light frames |

Every measured frame asserts that exactly
`upload,shadow,reconstruction,lighting,presentation` executes. Mask SDF,
HeightPass, and NormalPass remain retained. The prior 640x360 three-surface
case remains in the same suite as a non-acceptance micro/regression case.

Reference machine: MacBook Pro Mac16,8, Apple M4 Pro (12 CPU / 16 GPU
cores), 24 GB, macOS 26.5.1, Chrome 152, Metal WebGPU.

## Clean before / after results

All values are real GPU timestamps in milliseconds from the committed JSON
artifacts. The base is master `068248d`, which already contains #48's exact
prefix binary search and per-step caster-AABB empty-space culling. The after
algorithm adds #57's exact discrete caster-AABB interval clipping and the
rising-ray max-height early exit.

| Stage | Before median / p95 | After median / p95 | Median change |
| --- | ---: | ---: | ---: |
| ShadowPass | 7.899 / 8.865 | 6.300 / 7.204 | -20.2% |
| ReconstructionPass | 2.535 / 2.786 | 2.536 / 2.786 | unchanged |
| LightingPass | 0.287 / 0.313 | 0.287 / 0.295 | unchanged |
| PresentationPass | 10.822 / 11.701 | 9.150 / 10.018 | -15.5% (run variance; shader does not alter this pass) |
| Total dynamic-light GPU | 21.740 / 23.499 | 18.324 / 20.132 | -15.7% |

The controlled ShadowPass speedup is 1.25x (20.2% lower median; 18.7% lower
p95). Total median 18.324 ms is below the 33.3 ms 30-FPS-class gate; p95 is
20.132 ms. Samples remain 8.

Artifacts and provenance:

- `packages/renderer/benchmark-results-issue-57-before.json`: measured
  renderer commit `068248d71ff833b7a7ee376f196476b0dee0f81c`,
  `workingTreeDirty=false`.
- `packages/renderer/benchmark-results-issue-57-after.json`: measured
  renderer commit `aba9d4f495026c825ace824c07b3334ac9b1de26`,
  `workingTreeDirty=false`.
- Both use benchmark harness commit
  `aba9d4f495026c825ace824c07b3334ac9b1de26` with
  `benchmarkHarnessWorkingTreeDirty=false`.
- Before metadata names the code actually executed:
  `exact-prefix-binary-search+caster-aabb-empty-space`, exact prefix search,
  and caster-AABB culling enabled. After metadata names the interval clip.

## Relationship to the historical approximately 70 ms observation

The historical 70 ms ShadowPass value cannot be reproduced exactly because
the issue did not record its commit, exact render extent, DPR transform,
surface/caster layout, caster-union coverage, effective maxDistance,
stepSize, browser build, or raw artifact. It therefore cannot serve as a
controlled before result.

The reproducible base used here is master `068248d`, which already includes
#48 acceleration, and it measures 7.899 ms on the now-pinned 2.21M-texel
workload. The after value of 6.300 ms is about 91% below the historical
observation, but only the controlled 20.2% same-harness improvement is
attributed to #57. The benchmark does not weaken its conditions to recreate
or hide the old number.

## Optimization and semantics

The shader uses the exact historical f32 coordinate expression in monotone
binary searches to find the first and last integer steps intersecting each
axis of the conservative padded caster union. It intersects the two discrete
intervals and skips only proven-zero prefixes/suffixes. Endpoint validation
turns a narrow interval crossed between integer samples into an explicit
empty interval. A rising ray whose first threshold already reaches the
host-derived caster maximum returns lit because the strict comparison can
never succeed.

Sample count/directions, per-texel kernel variants, step coordinates,
stepSize, maxDistance, bias, bilinear sampling, strict comparison, hard/soft
visibility, and reconstruction semantics are unchanged.

## GPU profiling API

`UkiboriDom.create({ gpuProfiling: true })` explicitly enables diagnostic GPU
timestamps.

- Default (`false`/omitted): does not request `timestamp-query`; normal
  production rendering has no timestamp resolve/readback overhead.
- Explicit `true`: requests `timestamp-query` only when the adapter advertises
  it. Resolved Shadow/Reconstruction/Lighting/Presentation timings remain
  available from `debugState().gpuFrame.gpuTiming`.
- Unsupported adapters and timestamp feature-negotiation failures continue
  with an ordinary WebGPU device. Profiling never becomes a rendering
  requirement.

## Verification

- Real WebGPU: `UKIBORI_WEBGPU_PASS`, 121 fixtures, 85,533 scene texels, zero
  mismatches; raw shadow 0/85,024 exact; reconstructed visibility within the
  established 0.000002 tolerance; lighting/presentation exact.
- #48 adversarial matrix: all 17 fixtures pass.
- Deterministic prefix and caster-AABB interval sweeps pass, including
  non-dyadic steps, equality boundaries, narrow missed intervals, and
  falling rays.
- Retained/partial renderer contracts pass; CPU fallback and DOM GPU tests
  pass. Renderer and DOM typechecks pass.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| Continuous changing light, angularRadius > 0 | PASS |
| 8 soft-shadow samples remain active | PASS |
| Mask SDF / Height / Normal skipped on light-only frames | PASS |
| Production-shaped median total GPU <= 33.3 ms | PASS (18.324 ms) |
| p95 reported separately | PASS (20.132 ms total) |
| ShadowPass substantial improvement | PASS (20.2% controlled; 7.899 -> 6.300 ms) |
| Established visual/parity contract | PASS |
| No default production GPU readback | PASS |
| Explicit diagnostics remain available | PASS (`gpuProfiling: true`) |
| Retained/static scenes remain idle | PASS |
| CPU fallback remains correct | PASS |

## Changed files

- `packages/renderer/src/gpu/shadow-pass-wgsl.ts`
- `packages/renderer/src/gpu/shadow-pass.test.ts`
- `packages/renderer/src/gpu/shadow-prefix.test.ts`
- `packages/renderer/test-browser/bench-gpu.mjs`
- `packages/renderer/scripts/bench-gpu.mjs`
- `packages/renderer/scripts/bench/lib/scenes.mjs`
- `packages/renderer/scripts/bench/lib/env-node.mjs`
- `packages/renderer/scripts/bench/lib/bench-harness-contract.test.mjs`
- `packages/ukibori-dom/src/dom-layer.ts`
- `packages/ukibori-dom/src/dom-layer-gpu.test.ts`
- the two benchmark JSON artifacts and this report
