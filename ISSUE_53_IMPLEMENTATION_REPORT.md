# Issue #53 implementation report

Issue: [#53 — [Rendering] Improve hard and soft shadow edge quality without changing shadow semantics](https://github.com/MasafumiYamaguchi/Ukibori/issues/53)
Branch: `feat/issue-53-shadow-edge-quality` (base: master `03115b8`)

## 1. Root cause analysis

Measured with `packages/renderer/scripts/shadow-edge-evidence.mjs` (the CPU
oracle is bit-exact with the GPU for the raw visibility field, so the whole
matrix runs in Node; artifacts: `packages/renderer/test-browser/shadow-edge-artifacts/phase1/`).

| Candidate | Contribution | Evidence |
|---|---|---|
| **Hard path: raw binary displayed with zero antialiasing (PRIMARY)** | The historical hard path wrote exact {0, 1} and bypassed reconstruction entirely, so diagonal/curved shadow boundaries displayed as a raw texel staircase. | Every hard case: transition width **0 texels**, **0 intermediate levels** at DPR 1/1.5/2/3 (raw field), while the occlusion boundary itself is exact (0/84624 parity mismatches). |
| **Soft path: sampling speckle + the #43 box average washing out narrow bands (PRIMARY)** | The decorrelated k/n speckle contours wobble, and the plain gated box average averages ACROSS narrow dark bands: a 3-texel band lost ~62% of its depth (minVis 0 → 0.38); glyph strokes washed from minVis 0 → 0.22. | thin/soft8/dpr1: raw minVis 0/area 111 → box recon minVis 0.383/area 48; glyph/soft8/dpr1: raw 0/133 → box 0.216/85. Raw speckle zigzag 1.5-4.3 texels at DPR 1-2. |
| Presentation byte quantization (NOT significant) | The compositor's premultiplied strength byte adds ≤1 LSB. | Byte-space margin analysis (see below); fixing the field quality moved the presented bytes with it. |
| DPR (NOT a cause by itself) | The raw staircase is DPR-invariant in CSS space (the boundary is sampled at (tx+0.5)/dpr). | Hard transition width 0 at every DPR; the CSS-space crossing is constant (crossings.csv). |
| Normals/lighting/ownership/heightGate (NOT significant) | The shading chain is not the source; the boundary-local cost is the 3x3-neighborhood non-uniform fraction (~2-4% of texels). | boundaryTexelFractionRaw per case in summary.json. |

## 2. Adopted solution

**One reconstruction stage, two kernels — selected automatically by the
shadow path, zero new options:**

- **Soft mode (kernel mode 0): value-bilateral box.** The #43 box kernel
  gains a per-tap weight `exp(-(dv)²/(2σ²))`, `σ = RECONSTRUCTION_VALUE_SIGMA
  = 0.25` visibility units (plus the unchanged height/ownership gates, radius
  semantics, DPR mapping). Full-range jumps (thin band edges, 0↔1) get weight
  ~3e-4 — excluded, bands keep their depth; one-to-two sample-level
  differences (the sampling speckle) keep weight ≥ 0.6 — the penumbra still
  smooths. Measured: transition width within one texel of the old box
  (no new softness), thin-band minVis 0.38 → 0.0006 (preserved), glyph-stroke
  minVis 0.216 → 0.099 (preserved), DPR ≥ 2 contour zigzag 3.85 → 0.88 texels.
- **Hard mode (kernel mode 1): ring-rule binomial edge refinement.** A PURE
  POSTPROCESS of the binary field (no extra rays): a texel is refined only
  when its 8-neighbor ring shows exactly two visibility-side transitions with
  both same-side arcs ≥ `RING_EDGE_MIN_ARC = 3` ring texels (exactly one
  locally straight boundary through the 3x3 window), and a 3/5 split is
  accepted only when the center belongs to the majority arc; the refinement value is
  the separable (1,2,1)²/16 binomial — an exact dyadic k/16 rational
  (f32-exact integer sums) producing a 1-2 texel ramp centered on the same
  boundary. Thin features, corners, speckle and the 1-texel frame border stay
  verbatim. Measured: 2-4 texel ramps at DPR 1-3, per-row 50% crossing
  preserved (zigzag 0/0), below-half area identical to the raw field.
- `enabled: false` (and radius 0) bypasses BOTH kernels: the raw field is
  displayed and every historical byte is preserved.

Implementation: `src/shadow-reconstruct.ts` (CPU oracle, both kernels),
`src/gpu/reconstruction-pass-wgsl.ts` (mode-branching WGSL, params
valueSigma@24 f32 + mode@28 u32, 32 bytes unchanged),
`src/gpu/reconstruction-pass.ts` (mode plumbed through packUniform/input/
snapshot), `src/gpu/pipeline.ts` + `src/wasm/pipeline.ts` (mode selection =
`softShadowActive`), `src/lighting.ts` (display-field selection). The hard
halo is fixed at 1 texel (the 3x3 ring); the soft halo is the sanitized
texel radius (unchanged).

## 3. Rejected alternatives (measured, then rejected)

| Candidate | Why rejected |
|---|---|
| Subtexel supersampling (K=4/9 hard-ray tests at boundary texels) | Inherits the march step-phase noise: refined texels show dropouts (visibility flips back to 0 between sub-samples); no staircase win over the ring rule. |
| Hard value-gated reconstruction (gate 1/N, 2/N) | A gate stops the salt-and-pepper smoothing entirely (every neighbor differs by ≥1 level); zigzag worse than the box. |
| Ring rule ON TOP of the recon field | Unstable on smoothed fields (ring arcs fragment; zigzag ~23 texels). |
| Plain corner-coverage supersampling | Equivalent to a blur (adds softness the ray geometry does not own). |

## 4. Shadow semantics — forbidden-change checklist

Unchanged: blocker geometry, caster/receiver semantics, the ray occlusion
test, `maxDistance`, `stepSize`, bias semantics, light direction,
`angularRadius`, penumbra geometry, contact-hardening, `castsShadow`/
`receivesShadow`, retained scheduling, partial-recompute semantics. The RAW
visibility contract is untouched: hard = exact binary {0,1}, soft = dyadic
k/n (zero tolerance on both; real-WebGPU parity 0/84624 mismatches). The
changes are the DISPLAY representation only, documented simultaneously in
the CPU oracle, the WGSL, the policy table and the parity harness.

## 5. Scheduling / retained behavior

- `reconstructionActive` is now true for hard frames too (it was soft-only);
  the partial-planner halo for hard frames is 1 texel (the ring); the parity
  retained-scheduling section verifies partial-vs-forced-full byte equality
  for raw/reconstructed/lighting fields and the canvas (0 problems).
- `enabled: false` keeps the historical bypass (`reconstructionActive`
  false, raw bytes everywhere).
- One extra compute submission per frame when the hard refinement runs
  (the DOM/React submit-count pins were updated: 5 → 6).

## 6. Visual evidence

`packages/renderer/test-browser/shadow-edge-artifacts/phase1/` (README with
the tables): raw/recon/presented PPMs + per-row crossing CSVs + summary.json
for the diagonal/thin/glyph/near/far/rounded/vertical scenarios at DPR
1/1.5/2/3, samples 4/8/16. Headline: hard staircase → 2-4 texel dyadic ramp
with the crossing preserved; thin band and glyph strokes preserved by the
bilateral kernel where the box washed them out.

## 7. Performance (640x360, GPU-timestamp medians, #46/#48 subset; committed `benchmark-results-issue-53-{before,after}.json`)

| case | before | after |
|---|---|---|
| stage/reconstruction (radius 2) | 0.0206 ms | 0.0228 ms (+11%) |
| reconstruction/dpr-1/radius-2 | 0.0345 ms | 0.0365 ms (+6%) |
| reconstruction/dpr-2/radius-2 | 0.182 ms | 0.204 ms (+12%) |
| reconstruction/dpr-1/radius-4 | 0.0621 ms | 0.0696 ms (+12%) |
| stage/shadow (untouched) | 0.389/0.254 ms | 0.256 ms (run noise) |
| e2e/warmed-full (GPU-timed) | 0.119 ms | 0.086 ms (run noise) |
| parity bench shadow+reconstruction (soft, host) | — | 3.45 ms |
| parity bench shadow+reconstruction-HARD (host) | — | 3.60 ms |

The value-bilateral costs ~10% more GPU time than the box at the same
radius (one `exp` per tap); the hard refinement is a 3x3 postprocess at the
1-texel halo. `UKIBORI_BENCH_GPU_PASS` (117 cases) and the full-chain
speedup 127x are unchanged in character. The host-side wall deltas on the
partial/forced-full e2e rows reflect the extra hard-path submission.

## 8. Tests

- Unit (vitest): `shadow-reconstruct.test.ts` — 9 new `refineHardEdgeVisibility`
  tests (constants, dyadic/[0,1] pureness, vertical/diagonal ramp values,
  thin-feature and corner/isolated preservation, uniform fields + frame
  border, determinism/no-mutation, real-scene end-to-end dyadic + identical
  below-half area) + the existing #43 suite (25 in the file);
  `lighting.test.ts` (the hard display field is the refined dyadic field);
  `gpu/pipeline.test.ts` / `gpu/pipeline-partial.test.ts` (6 encoders,
  recon dispatch mode 0/1, halo 1 row for hard, uniform valueSigma/mode
  bytes). Renderer suite: 966 passed / 0 failed (4 pre-existing .mjs
  collection failures unchanged from master).
- Real-WebGPU parity (`UKIBORI_WEBGPU_PASS`): 120 fixtures, 0 mismatches —
  including 4 new hard-refinement fixtures (`shadow-reconstruction-hard-slab-r2`,
  `-hard-mask-caster`, `-hard-thin-caster`, `-hard-dpr2`, exact zero
  tolerance via the `visibility-reconstructed-hard` policy) and the new
  `present-reconstructed-hard` canvas fixture. Soft recon: 0/4800 mismatches
  (max abs 9.5e-7, max ulp 16 — inside the portable 2e-6 tolerance).
- DOM/React: `ukibori-dom` 126/126, `ukibori` 196/196 (submit-count pins
  updated), `UKIBORI_DOM_GPU_PASS` (real adapter, dpr 1/1.5/2).
- CPU goldens: present-canvas digests regenerated via
  `presentationReference` (now mirrors the hard refinement); the compute
  chain digests are unchanged (the golden lighting oracle consumes the raw
  field by design).

## 9. Acceptance criteria

- Hard shadow edges: straight/diagonal/curved boundaries show a 1-2 texel
  dyadic ramp (PPM + CSV evidence); the 50% crossing is preserved
  (zigzag 0/0); thin casters, mask/glyph casters, near/far cases pinned by
  the new fixtures. ✓
- Soft shadows: samples 4/8/16 × angularRadius small/representative/large
  parity exact; the reconstruction is not the softness source (width within
  one texel of the box); penumbra geometry unchanged. ✓
- DPR 1/1.5/2/3: CSS-space invariance held (crossings.csv; the radius maps
  through the DPR exactly once). ✓
- Scheduling: fresh/retained/partial/forced-full byte equality (0 problems). ✓
- Numerical: finite/[0,1] enforced; hard dyadic k/16 exact (zero tolerance);
  soft within the documented 2e-6. ✓
- Forbidden changes: none made (§4). ✓
- Performance: measured before/after (§7); no sample/radius/stepSize
  increases. ✓

## 10. Remaining limitations

- The hard refinement is a screen-space postprocess: at very shallow
  boundary angles the ramp texels can extend 2 texels along the boundary
  (the arcs guard keeps it off thin features; the crossing never moves).
- The soft bilateral does not remove the dpr1 residual wobble entirely
  (zig 0.38 texels vs the box's 0.18 — both sub-texel); the accepted
  trade for narrow-band preservation.
- `presentationReference` re-runs the refinement on the CPU for every
  canvas fixture (cheap: binary ring walk).
- The rejected candidates' PPM artifacts are not committed (metrics only,
  in summary.json).
## PR #55 review corrections (2026-09-06)

### A. Ring-rule bug

- **Root cause:** the old cyclic loop counted the wrap edge as part of `run` and then appended that run to the first arc even when ring index 7 -> 0 was a transition.
- **Old behavior:** `TTFFFFFF` could be classified as 3/6 rather than 2/6, so a narrow feature could pass `RING_EDGE_MIN_ARC = 3` depending on rotation.
- **New behavior:** CPU and WGSL choose a canonical start immediately after a transition, count the eight ring elements exactly once, and derive the second arc as `8 - firstArc`. Wrap continuation merges naturally; wrap transition never merges.
- **Rotation/reflection invariance:** fixed tests cover all eight rotations and their reflections. 2/6 rejects in every orientation; 3/5 and 4/4 accept.
- **CPU/WGSL parity:** both implementations use the same transition-count / canonical-start / eight-element run algorithm. Local real-WebGPU: 120 fixtures, 0 mismatches; hard reconstructed visibility remains exact dyadic k/16.

### B. `radius = 0` semantics

| Backend/path | Result |
| --- | --- |
| hard CPU | raw hard visibility consumed directly |
| hard WASM | raw hard visibility consumed directly |
| hard WebGPU | reconstruction inactive; zero dispatch/submission; raw binding consumed |
| soft CPU | raw soft visibility consumed directly |
| soft WASM | raw soft visibility consumed directly |
| soft WebGPU | reconstruction inactive; zero dispatch/submission; raw binding consumed |

The common gate is now `effective.enabled && effective.radiusTexels > 0`; `enabled = false` has the same bypass result. Tests cover hard samples 1/8, soft samples 8, positive/zero radius, stale-snapshot rejection, and partial scheduling.

### C. GPU performance

Local NVIDIA/Chrome real adapter, 640x360, DPR 1, hard shadow, ring refinement, 3 warmups + 10 samples:

| case | ShadowPass median/p95 | Reconstruction median/p95 | Total GPU median/p95 | Host median/p95 | Wall median/p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| hard ring | 0.0384 / 0.0476 ms | 0.00414 / 0.00442 ms | 0.0844 / 0.0914 ms | 0.300 / 0.400 ms | 4.15 / 5.90 ms |

Counters: 6 submissions, 9 dispatches, 0 new allocations (2 retained allocations), 921,632 reconstruction allocation bytes. Evidence is stored in `packages/renderer/benchmark-results-issue-53-review.json` as `reconstruction/hard-ring/dpr-1`.

### D. Soft numerical portability

- **Tolerance:** 2e-6 for reconstructed soft visibility only. Raw visibility and hard reconstructed k/16 remain zero-tolerance.
- **Measured max abs:** 9.5367431640625e-7 across 4,800 reconstructed texels on the local real adapter.
- **Measured max ULP:** 16.
- **Test matrix:** catalog soft reconstruction fixtures plus the real-WebGPU parity run (120 total fixtures), DPR 1/1.5/2 coverage, and CPU f32-accumulation adversarial evidence.
- **Safety margin:** 2.097x over the measured maximum. This margin covers backend `exp()` variance; semantic/topology differences still fail separately and cannot hide under the tolerance.

### E. CI

- **PR CI:** the observed runs stop during workspace typecheck at `demo/src/scheduler-debug/SchedulerDebug.tsx` TS2366 and do not reach real-WebGPU.
- **Master reproduction:** reproduced by GitHub Actions on master `03115b8a5380f656bdf25f2ea9503694161379fd`, run `33991169381`, at the same lines/errors. It is pre-existing and outside #53, so it was not changed here.
- **Local real-WebGPU:** PASS, 120 fixtures / 85,133 scene texels, 0 mismatches; reconstructed soft max abs 9.537e-7 / 16 ULP.
- **CI real-WebGPU:** not executed because typecheck failed first; no CI GPU result is claimed.

### F. Verification

- Renderer focused regression: 119/119. Full renderer: 968 tests passed; four pre-existing `.mjs` collection failures remain.
- ukibori-dom: 126/126. ukibori: 196/196.
- All package typechecks passed except the documented pre-existing demo TS2366; all four package builds passed.
- CPU golden: 31 fixtures / 258 digests, no changes.
- Local real-WebGPU and DOM real-WebGPU: PASS.
- GPU benchmark subset: PASS, 21 reconstruction cases including hard timestamps.

### G. Files cleaned

BOM and/or mojibake were removed from:

- `packages/renderer/src/gpu/pipeline.test.ts`
- `packages/renderer/src/gpu/reconstruction-pass.ts`
- `packages/renderer/src/lighting.ts`
- `packages/renderer/test-browser/catalog.mjs`

Changed source/test files were rechecked as UTF-8 without BOM and without the reported mojibake sequences.

### H. PR metadata

The PR body uses `Implements #53`; `Closes #53` was removed. The issue is not closed and the PR is not merged.

## PR #55 final hard-tip review (2026-09-06)

### A. Root cause and concrete regression

- The cyclic-arc fix correctly made a 3/5 ring eligible, but that topology is
  ambiguous unless the center side is considered. For the local pattern
  `000 / 101 / 111`, the center is the three-neighbor minority side: it is a
  one-pixel tapered tip, not a straight boundary sample.
- The previous ring-only rule refined that center from raw `0` to `0.5`,
  deleting the tip at the hard-shadow threshold. The final rule preserves it
  at `0`. The inverted pattern is protected symmetrically.

### B. Final hard ring rule

| Ring split | Center side | Result |
| --- | --- | --- |
| 4/4 | either side | refine |
| 3/5 | five-neighbor majority side | refine |
| 3/5 | three-neighbor minority side | preserve raw |
| 2/6 | either side | preserve raw |
| any other topology | either side | preserve raw |

The CPU and WGSL implementations apply the same transition count, canonical
cyclic arcs, minimum-arc test, and center-majority test. Radius-zero bypass,
CPU/WASM consumption, GPU scheduling, and retained-resource behavior are
unchanged.

### C. Exhaustive local invariants

All 512 binary 3x3 neighborhoods are enumerated. Every refined center is
finite, remains in `[0, 1]`, is an exact dyadic `k/16`, and stays on the same
side of the hard `0.5` threshold as the raw center. The classifier is also
checked under all eight cyclic rotations and their reflections. Violations:
range 0, non-dyadic 0, side flips 0, D4 classifier mismatches 0.

### D. CPU/WGSL and real-GPU parity

- CPU and WGSL use the same 4/4 and center-aware 3/5 classification.
- Local NVIDIA/Chrome real-WebGPU: PASS, 121 fixtures / 85,533 scene texels,
  0 mismatches. Hard visibility and hard reconstruction remain exact.
- The new `shadow-reconstruction-hard-thin-tip` fixture passed 400/400 texels
  with zero mismatches.
- Reconstructed soft visibility passed 5,200 texels with max absolute error
  `9.537e-7` and max ULP 16 under the documented `2e-6` tolerance. This is a
  measurement from the current local NVIDIA/Chrome backend, not a portability
  guarantee; additional backend coverage remains desirable.
- DOM real-WebGPU lifecycle coverage also passed at DPR 1, 1.5, and 2.

### E. Added regression coverage

- Direct and inverted one-pixel tips across rotations and reflections.
- Explicit 3/5 center-majority acceptance and center-minority rejection.
- Exhaustive 512-pattern range, dyadic, side-preservation, and D4 invariants.
- Thin glyph-like stem, tapered end, T-junction, L-corner, isolated texel, and
  short-line footprint preservation.
- A real-WebGPU tapered mask-caster fixture; existing vertical and diagonal
  hard-edge ramp tests continue to verify intended refinement.

### F. Numerical contract documentation

Remaining stale `1e-6` reconstructed-soft comments in source, tests, and the
catalog safety-factor note were corrected to `2e-6`. Raw visibility and hard
reconstructed visibility retain zero-tolerance comparison.

### G. Clean benchmark provenance

The dedicated artifact is
`packages/renderer/benchmark-results-issue-53-review.json`. It is regenerated
from the clean source commit after this review, without `--allow-dirty`; the
artifact's embedded `commit` and `workingTreeDirty=false` are the authoritative
provenance. The measured hard-ring reconstruction and total-GPU median/p95
values are recorded in that artifact and summarized in the PR body.

### H. Known limitation

The classifier protects hard-shadow side topology only within a local 3x3
window. It prevents a refined texel from crossing the hard threshold and
preserves common thin tips/strokes, but it does not infer or reconstruct
subtexel geometry beyond that neighborhood.

Final verification: 972 renderer tests pass; the same four pre-existing `.mjs`
collection failures remain. Renderer typecheck/build, package tests/builds,
CPU goldens (31 fixtures / 258 digests), renderer real-WebGPU, and DOM
real-WebGPU pass. The demo TS2366 failure remains untouched. The PR is not
merged and issue #53 is not closed.
