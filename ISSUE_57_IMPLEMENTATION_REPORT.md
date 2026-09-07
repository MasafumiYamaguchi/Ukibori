# Issue #57 implementation report

Issue: [#57 — continuously changing soft-shadow performance](https://github.com/MasafumiYamaguchi/Ukibori/issues/57)
Branch: `issue-57-optimize-dynamic-soft-shadows` (base: master `068248d`)

## 1. Adopted optimization

The retained light-only dependency chain is unchanged:

`Upload -> Shadow -> Reconstruction -> Lighting -> Presentation`

`Height` and `Normal` remain retained. The ShadowPass keeps the same eight
area-light directions, march step size, maximum distance, f32 sample
coordinates, bilinear caster-height reads, bias, and strict
`sample > threshold` test.

The optimization removes only work that is provably unable to occlude:

- For rising rays, two exact discrete binary searches per axis locate the
  first and last historical march indices intersecting the conservatively
  padded caster-union AABB. Known-zero prefixes and suffixes are skipped as
  loop iterations rather than visited one step at a time.
- If the first rising-ray threshold is already greater than or equal to the
  host-derived maximum caster height, strict occlusion is impossible for the
  entire ray and it returns lit immediately.
- Falling rays and negative-threshold cases keep the historical per-step
  behavior. No analytic intersection or epsilon is introduced.

No pass, dispatch, upload, storage allocation, sample, or quality setting was
added. The optimization reuses the retained host-derived caster bounds
already present in the ShadowPass uniform.

## 2. Production GPU readback

The normal DOM WebGPU path no longer requests the optional `timestamp-query`
device feature. Consequently, normal rendering cannot allocate timestamp
resolve/readback buffers or call `mapAsync()` for per-frame telemetry.

The dedicated benchmark path still opts into `timestamp-query` explicitly,
so performance evidence remains based on GPU timestamps rather than host
proxies.

## 3. Production-shaped benchmark

A new `dynamic-light` suite renders a continuously rotating directional
light while geometry remains byte-identical. It fails unless every measured
frame uses:

- 640x360 at DPR 1;
- angular radius 0.15 and exactly 8 shadow samples;
- max distance 200 and step size 0.5;
- enabled reconstruction with radius 2;
- exactly `upload,shadow,reconstruction,lighting,presentation`;
- no Height or Normal execution.

Reference machine: MacBook Pro Mac16,8, Apple M4 Pro (12 CPU / 16 GPU
cores), 24 GB, macOS 26.5.1, Chrome 152 / Metal WebGPU. Each result uses 10
warmups and 100 measured frames. Before and after use the same harness and
scene; the before run uses the master `068248d` shader.

| GPU timestamp metric | Before median / p95 | After median / p95 | Change |
| --- | ---: | ---: | ---: |
| Full dynamic frame | 2.957 / 3.929 ms | 2.026 / 2.385 ms | median -31.5%, p95 -39.3% |
| ShadowPass | 1.389 / 1.834 ms | 0.864 / 1.018 ms | median -37.8%, p95 -44.5% |
| ReconstructionPass | — | 0.164 / 0.167 ms | reported separately |
| LightingPass | — | 0.043 / 0.045 ms | reported separately |
| PresentationPass | — | 1.071 / 1.171 ms | reported separately |

The acceptance threshold is 33.3 ms median. The measured full dynamic frame
is 2.244 ms median and 2.432 ms p95. The issue's earlier approximately 70 ms
profile is retained as historical context, but the table above deliberately
uses only an identical before/after harness for the claimed speedup.

Raw evidence:

- `packages/renderer/benchmark-results-issue-57-before.json`
- `packages/renderer/benchmark-results-issue-57-after.json`

## 4. Correctness and regression evidence

- Real WebGPU parity: `UKIBORI_WEBGPU_PASS`; 121 fixtures, 85,533 scene
  texels, zero mismatches. Shadow visibility is exact for 85,024 texels.
  Reconstructed visibility stays within the existing 0.000002 tolerance;
  lighting RGBA8 and presentation remain exact.
- The #48 adversarial shadow matrix passes all 17 fixtures, including thin
  caster AABB edges, bilinear support boundaries, non-dyadic steps, height
  equality, falling rays, and XY/height boundary coincidence.
- Renderer targeted contracts: 155/155 pass (`shadow-pass`, `shadow-prefix`,
  `dirty`, and `pipeline`).
- Renderer and DOM TypeScript checks pass.
- DOM GPU contracts: 11/11 pass, including the production no-timestamp-query
  device request and CPU fallback behavior.

Static idle frames and the CPU renderer are not changed. Light-only frames
continue to retain Mask SDF, Height, and Normal outputs.
