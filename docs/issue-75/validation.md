# Issue #75 validation

Base commit: `d3e8b65a05ebd54616114841977e6080b96cc9bf`.
Local environment: Linux, Chromium 153.0.8010.0, SwiftShader Vulkan software
WebGPU (native Dawn reports SwiftShader driver 5.0.0). These are real WebGPU
executions, including shader compilation and readback, but **not hardware GPU
performance evidence**.

## Correctness

| Check | Result |
| --- | --- |
| Full `npm test` | Passed: renderer 1,113; DOM 215; React 217 tests, plus the development-loop checks |
| Additional SSR hydration regression | New React file: all 3 tests passed, including the subsequently added hydration/click test |
| Final DOM verification | All 216 tests passed, including a new stage-movement regression that failed before the correction |
| `npm run typecheck` / `npm run build` | Passed |
| Static CPU goldens | All 31 fixtures / 258 buffer digests unchanged |
| Existing native emission parity | 126 cases / 77,952 bytes, exact |
| Existing native emissive effects parity | 72 cases / 801,792 bytes, maximum byte error 0; 5 retained transitions passed |
| New physical-floor CPU/WebGPU parity | 74 fixtures / 4,915,200 bytes; maximum RGB byte error 1 (tolerance 1), exact alpha |
| Existing browser WebGPU correctness | 121 compute fixtures and 22 presentation fixtures; no normal, shadow, caster, lighting or presentation mismatches; no retained/partial problems |
| New parity in the browser gate | Same 74 physical-floor fixtures passed |
| Browser DOM verification | All 6 cases render on requested GPU and CPU backends; no GPU fallback or console/page errors |

The new parity matrix covers DPR 1 / 1.5 / 2, light/dark albedo, hard/soft/
reconstructed shadows, emission off/on and bloom off/on. The CPU oracle shades
the actual GPU geometry/normal/visibility fields, isolating lighting and final
composition from already-covered geometry tolerances. Unit tests additionally
pin owned/floor receiver equivalence at visibility 0 / 0.25 / 1, flat floor
normals, unchanged owned pixels, and independence from legacy shadow tint.

Emission and bloom changes leave visibility byte-for-byte unchanged. With bloom
off, 42,074 compared shadowed floor pixels brighten from incident illumination.
Retained base-color, emission, light, partial geometry, combined geometry/color,
effect-disable and floor-disable results match forced full renders. Static frames
dispatch no GPU work; retained presentation reuses the image.

The browser check exercises focus, pointer click, text selection, inert overlay
attributes, stage resize, DPR change and scroll alignment. React tests preserve
the semantic element and layer across color updates; SSR output is unchanged and
hydration retains the original button with no recoverable errors.

## Existing WebGPU speed gate: failed locally

The complete `npm run test:webgpu` command returned **FAIL**, solely at the
existing performance gate: 0.54× versus the required 2× CPU speedup
(CPU 359.40 ms; GPU 664.650 ms; 640 × 360; 10 samples). This run used SwiftShader
and overlapped another validation workload. All correctness comparisons above
passed. The gate and thresholds are unchanged; this result must not be reported
as a passing full WebGPU gate. See [golden-gate.json](golden-gate.json).

The isolated measurements below replace an earlier concurrent benchmark run.
Hardware GPU validation and the repository CI gate remain required before merge.

## Isolated same-extent performance

The same deterministic scene renders at 320 × 192, DPR 1, with reconstructed
soft shadows, emissive illumination and bloom enabled. Each row uses 3 warmup
iterations followed by 8 measured iterations, with queue completion awaited.
Variants run sequentially on one adapter, without concurrent browser validation.
The master variant imports the separately built base commit. Branch legacy and
physical-floor variants use identical current code with the floor disabled or
enabled. Rendering area is held constant.

**Queue-completion median (ms; includes host submission):**

| Update | Master | Branch legacy | Physical floor |
| --- | ---: | ---: | ---: |
| Full frame | 174.96 | 181.57 | 170.98 |
| Static | 0.10 | 0.07 | 0.05 |
| Light only | 96.60 | 113.25 | 97.05 |
| Emission only | 97.33 | 97.44 | 104.29 |
| Partial geometry | 117.84 | 136.82 | 141.86 |

**GPU timestamp median (ms; summed pipeline stages):**

| Update | Master | Branch legacy | Physical floor |
| --- | ---: | ---: | ---: |
| Full frame | 166.40 | 179.90 | 164.82 |
| Static | — | — | — |
| Light only | 90.51 | 98.83 | 92.54 |
| Emission only | 86.05 | 88.15 | 97.32 |
| Partial geometry | 116.26 | 128.25 | 126.03 |

A single software-adapter run cannot establish a hardware regression budget.
The measured physical-floor completion times are approximately +7% for emission
updates and +20% for partial geometry versus master; full-frame and light-only
times are similar. Report these observations without claiming a speedup or
hardware performance pass. Raw host times and all measurements are in
[performance.json](performance.json).

| Update | Compute dispatches | Queue submissions | New allocations |
| --- | ---: | ---: | ---: |
| Full frame | 12 | 8 | 0 |
| Static | 0 | 0 | 0 |
| Light only | 4 | 4 | 0 |
| Emission only | 4 | 4 | 0 |
| Partial geometry | 12 | 8 | 0 |

These counts are identical for all three variants. Light/emission edits retain
height, normals, shadows and reconstruction. Geometry uses the existing partial
plan; effects still cover the full field to avoid stale spill. A base-color change
invalidates lighting/presentation only, and combined geometry/color changes
correctly prevent a partial lighting update.

No added fullscreen pass, texture, per-pixel buffer or normal-rendering readback.
Additional storage is 16 bytes each for lighting, illumination and bloom
uniforms; the 32-byte presentation uniform uses existing padding. Readbacks in
the parity harness and timestamp profiler are validation-only. DOM physical-floor
coverage extends to the stage padding box, so total scene area can differ from
legacy surface-bounds rendering; that separate cost is excluded here.

## Screenshots

All images use the same deterministic fixture and 1200 × 860 browser viewport.
The before image uses a separate checkout of the base SHA with only the fixture
files copied in. Images were visually checked for illumination under the long
shadow, bloom-independent lighting, floor/owned continuity and stage coverage.

- [Before: master WebGPU](base-plane-before.png)
- [After: physical floor WebGPU](base-plane-after.png)
- [Bloom off: WebGPU detail](base-plane-bloom-off.png)
- [Bloom off: CPU detail](base-plane-bloom-off-cpu.png)

The lower contrast and brightness of a physically lit albedo versus the unlit CSS
swatch are intentional and documented; ambient/exposure were not silently raised.
See [the implementation report](README.md) for the API, equations, reproduction
commands, explicit extent contract and remaining limitations.
