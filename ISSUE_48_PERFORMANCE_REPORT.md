# Issue #48 ShadowPass ray-march optimization

このレポートは、同一条件の clean な #46 実機WebGPUベンチマーク2本から機械生成したものです。数値は手入力していません。profiling 数値と correctness evidence も、committed artifact から機械的に取り込んでいます。

## Provenance

- Baseline commit: `3c315d2b6ca95432e87f5367a10370a0b8b4f399` (workingTreeDirty=false)
- Optimized commit: `3fc2e70b3b0d69c4592a37bf0afb58484a751824` (workingTreeDirty=false)
- Benchmark artifact commit: `db7d0d8bfe72b309460e069522d671c941f59bb7`
- Adapter: nvidia / blackwell / backend unknown
- Browser: chrome 151.0; timestamp-query=true

## Conditions and resource contract

- Resolution 640x360, DPR 1, warmups 5, timed samples 20.
- Shadow options: stepSize 0.5, bias 0.5; GPU timestamps are kept separate from host/wall timing.
- Algorithm: exact-prefix-binary-search+caster-aabb-empty-space; no extra ShadowPass passes/dispatches/uploads/storage ({"extraShadowPasses":0,"extraShadowDispatches":0,"extraShadowUploads":0,"extraShadowStorageBytes":0}).

## Profiling / bottleneck analysis

All numbers in this section are read mechanically from the #46 baseline artifact (`benchmark-results.json`, commit `412c2234d1648da57c99626f576735b752324aa4`), captured under the same 640x360 / DPR 1 / warmups 5 / timed samples 20 conditions as the before/after comparison below.

### Representative issue #46 baseline case

- ShadowPass median 0.389 ms of a 0.453 ms total GPU frame: ShadowPass alone accounts for 85.9% of the frame GPU time, making it the single dominant stage of the compute chain.
- The remaining stages (upload, height, normal, reconstruction, lighting, presentation) together cost less than the ShadowPass, so ShadowPass march work is where optimization pays off end-to-end.

### Soft-shadow sample scaling (scene `soft-shadow`, angular radius 0.15)

ShadowPass GPU median scales approximately linearly with the per-pixel cone sample count; per-sample cost stays nearly constant:

| Cone samples | ShadowPass median | Per-sample cost |
|---:|---:|---:|
| 1 | 0.101 ms | 0.101 ms |
| 4 | 0.461 ms | 0.115 ms |
| 8 | 0.912 ms | 0.114 ms |
| 16 | 1.806 ms | 0.113 ms |

- Hard-shadow reference (8 samples, angular radius 0, no cone rays): 0.1 ms — the extra cost of soft shadows is the per-sample march work, not the ray setup.
- Therefore any optimization that changes sample positions, sample count, or stepSize would change the measured semantics; the adopted candidate below preserves all of them exactly.

### Travel / step-count impact (8 samples, angular radius 0.15)

| Case | maxDistance (theoretical steps) | ShadowPass median |
|---|---:|---:|
| shadow/travel-short | 40 (80) | 0.729 ms |
| shadow/travel-medium | 120 (240) | 0.909 ms |
| shadow/travel-long | 300 (600) | 0.91 ms |

- Raising the march from 80 to 600 theoretical steps raises the median only from 0.729 ms to 0.91 ms; both values are unmodified artifact medians.
- Once the march is long enough to leave the caster field, the marginal cost of extra steps is small compared with the fixed per-sample work (height-field reads and per-sample cone setup), which dominates in sparse caster scenes.

### Sparse scenes vs worst cases

- In the sparse representative scene the march reads the height field for every cone sample over a long distance; height-field reads plus march length dominate, which is exactly the redundancy the prefix search removes.
- The dense / near-blocker / max-height-fast-exit / dense-overlap worst cases behave differently (mostly-blocked pixels, fast exits, full-frame AABB coverage) and must not be extrapolated from the sparse case; their measured before/after values — including the small absolute regressions — are reported in the tables below rather than hidden.

## Candidate evaluation

Candidates considered for reducing the ShadowPass ray-march cost. Verdicts reflect the #48 scope: a semantic-preserving optimization of the existing marcher (no shadow-quality reduction, no extra passes/resources).

### Hierarchical / mip-based height bounds

**Rejected / deferred.**

- Requires additional preprocessing (mip generation), storage, and synchronization on every scene/height change.
- Complexity is large relative to the #48 scope and risks changing height-field semantics (mip averaging is not an f32-exact bound of bilinear taps without conservative padding).
- End-to-end cost must be re-evaluated (preprocess + upload + read patterns), not just the ShadowPass.
- The simple optimization adopted below already removed the dominant redundancy on the representative workload.

### Tile / cluster spatial blocker bounds

**Rejected / deferred.**

- Requires an additional spatial structure, upload, and memory, plus an invalidation story consistent with the retained/partial scheduler (#31/#32).
- The adopted caster-union AABB already provides zero-extra-resource conservative empty-space culling over the full frame.
- Per-tile bounds would only add precision over the union AABB in scenes whose occupancy is highly non-uniform; the measured representative win did not justify the resource contract change.

### Adaptive stepping

**Rejected.**

- Changing step size or step placement changes the historical sample positions at which the height field is evaluated.
- Thin casters can be skipped entirely between adapted steps, and the exact f32 predicate (`rayZ > maxCasterHeight + bias`) would no longer be evaluated at the same points, breaking strict pixel parity against the CPU oracle.
- Directly conflicts with the #48 requirement "without reducing shadow quality"; correctness risk outweighs the potential win.

### Height-field layout / shared-memory / coalescing redesign

**Deferred.**

- A larger architectural change (texture layout, workgroup-level sharing, or memory-coalescing redesign) with its own profiling and workload-specific validation burden.
- Independent of the march-count redundancy; should be evaluated separately after #48's minimal semantic-preserving optimization.

### Exact prefix binary search + caster AABB empty-space culling

**Adopted.**

- Sample positions, stepSize, maxDistance, and sample count are all unchanged, so every historical f32 predicate is still evaluated at the same points.
- No extra GPU pass, dispatch, upload, or storage (resource contract below).
- Uses the exact historical f32 predicate (shared `rayZAtStep()` arithmetic, no analytic ratios, no epsilon, no magic margin).
- Representative ShadowPass / total frame medians improved substantially (measured tables below), including the sparse scenes where the march is dominant.

## Adopted algorithm

1. **XY scene-bound prefix search**
   - The historical marcher walks steps until the ray leaves the scene bounds in XY; that prefix is monotone, so it is located with an exact binary search over the same f32 arithmetic instead of a linear walk.
   - Historical sample positions are unchanged: the search evaluates the identical predicate at the identical step indices.
2. **Height bound integration**
   - `rayZAtStep()` shares the exact historical f32 arithmetic between the oracle, the optimized prefix search, and the GPU.
   - `dz > 0`: the ray height is monotone non-decreasing, so the XY exit and the `rayZ > maxCasterHeight + bias` bound are combined into a single monotone prefix predicate searched in binary.
   - `dz <= 0`: the height bound can never be crossed upward, so the historical step-1 height check is kept and the remaining prefix is XY-only.
   - No analytic ratio, no epsilon, and no magic step margin: strict f32 equality at the boundary is preserved (including `rayZ == maxCasterHeight + bias`).
3. **Caster union AABB culling**
   - A conservative padded union AABB of all casters is computed from the already-uploaded scene data.
   - Only pixels whose ray is entirely outside the AABB **and** whose threshold is `>= 0` skip the height-field reads: outside a strictly positive threshold there is no blocker, so the march result is provably identical.
   - With a negative threshold the zero base plane itself can act as a blocker, so height reads are retained there.
4. **Resource contract**
   - extra passes = 0
   - extra dispatches = 0
   - extra uploads = 0
   - extra storage bytes = 0

## Measured GPU timings

Values are `median / p95` milliseconds; Δ is after vs before (negative is faster). The frame column is the full submitted frame where available.

| Case | Shadow before → after | Δ | Frame before → after | Δ |
|---|---:|---:|---:|---:|
| stage/shadow | 0.390 / 0.404 → 0.254 / 0.256 | -34.7% | n/a → n/a | n/a |
| stage/frame-total | n/a → n/a | n/a | 0.454 / 0.603 → 0.318 / 0.320 | -29.9% |
| shadow/samples-8/radius-0.15 | 0.911 / 1.047 → 0.345 / 0.362 | -62.1% | 0.946 / 1.083 → 0.380 / 0.398 | -59.9% |
| shadow/travel-short | 0.729 / 0.861 → 0.279 / 0.295 | -61.7% | n/a → n/a | n/a |
| shadow/travel-medium | 0.909 / 0.929 → 0.342 / 0.349 | -62.4% | n/a → n/a | n/a |
| shadow/travel-long | 0.911 / 0.931 → 0.349 / 0.366 | -61.7% | n/a → n/a | n/a |
| shadow/worst/dense-caster | 0.107 / 0.131 → 0.111 / 0.124 | +3.5% | 0.142 / 0.164 → 0.145 / 0.159 | +2.6% |
| shadow/worst/near-blocker | 0.092 / 0.111 → 0.039 / 0.050 | -58.1% | 0.106 / 0.126 → 0.053 / 0.064 | -50.3% |
| shadow/worst/max-height-fast-exit | 0.005 / 0.005 → 0.010 / 0.017 | +117.8% | 0.019 / 0.019 → 0.024 / 0.031 | +28.9% |
| shadow/worst/dense-overlap | 0.039 / 0.056 → 0.061 / 0.063 | +56.3% | 0.073 / 0.091 → 0.096 / 0.097 | +31.4% |

## Worst-case workload metadata

AABB coverage is `clamp(unionCasterAabbArea / frameLogicalArea, 0, 1)`. Both artifacts retain min/max/samples/warmups and all resource counters in the compact JSON and full JSON files.

| Scenario | Samples / angular radius | Steps | AABB coverage | Before search | After search |
|---|---:|---:|---:|---|---|
| dense-caster (shadow-worst-dense-caster) | 8 / 0.150 | 200 / 0.5 (400) | 0.9649 | per-step-bounds-check | exact-combined-prefix-binary-search (9 iters) |
| near-blocker (shadow-worst-near-blocker) | 1 / 0.000 | 200 / 0.5 (400) | 0.0249 | per-step-bounds-check | exact-combined-prefix-binary-search (9 iters) |
| max-height-fast-exit (shadow-worst-max-height-fast-exit) | 1 / 0.000 | 300 / 0.5 (600) | 0.9913 | per-step-bounds-check | exact-combined-prefix-binary-search (10 iters) |
| dense-overlap (shadow-worst-dense-overlap) | 8 / 0.150 | 200 / 0.5 (400) | 0.9913 | per-step-bounds-check | exact-combined-prefix-binary-search (9 iters) |

### Worst-case complete timing summaries

Each cell is `median / p95 / min / max ms (n=samples, w=warmups)`; these are the raw timestamp summaries used for the deltas above.

| Scenario | Shadow before | Shadow after | Frame before | Frame after | Extra resources (after) |
|---|---:|---:|---:|---:|---|
| dense-caster | 0.107/0.131/0.098/0.135 ms (n=20, w=5) | 0.111/0.124/0.104/0.133 ms (n=20, w=5) | 0.142/0.164/0.132/0.170 ms (n=20, w=5) | 0.145/0.159/0.139/0.168 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |
| near-blocker | 0.092/0.111/0.089/0.112 ms (n=20, w=5) | 0.039/0.050/0.037/0.053 ms (n=20, w=5) | 0.106/0.126/0.101/0.126 ms (n=20, w=5) | 0.053/0.064/0.051/0.068 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |
| max-height-fast-exit | 0.005/0.005/0.005/0.005 ms (n=20, w=5) | 0.010/0.017/0.010/0.020 ms (n=20, w=5) | 0.019/0.019/0.018/0.019 ms (n=20, w=5) | 0.024/0.031/0.023/0.034 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |
| dense-overlap | 0.039/0.056/0.034/0.056 ms (n=20, w=5) | 0.061/0.063/0.059/0.075 ms (n=20, w=5) | 0.073/0.091/0.068/0.091 ms (n=20, w=5) | 0.096/0.097/0.093/0.109 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |

## Regression accounting

- Median ShadowPass regressions (reported, not hidden): shadow/worst/dense-caster +3.5%, shadow/worst/max-height-fast-exit +117.8%, shadow/worst/dense-overlap +56.3%.
- Median frame-total regressions (reported, not hidden): shadow/worst/dense-caster +2.6%, shadow/worst/max-height-fast-exit +28.9%, shadow/worst/dense-overlap +31.4%.
- These cases remain in the comparison so the optimization is not presented as universally faster.

## Correctness evidence

### Real-WebGPU adversarial fixture gate (#48)

- The real-WebGPU parity runner gates on an explicit #48 adversarial fixture set of 17 IDs (declared once in `test-browser/catalog.mjs`) and fails the run on any missing ID, execution error, or mismatch.
- Checked run recorded in `parity-results-issue-48.txt`: marker `UKIBORI_WEBGPU_PASS` on a real adapter (nvidia / blackwell); expected 17, executed 17, missing 0, execution errors 0, mismatches 0.
- Full-catalog context of the same run: 116 fixtures, 82704 shadow visibility texels, 0 shadow mismatches.
- Dense pair: hard fixture `shadow-dense-full-frame-hard`, soft fixture `shadow-dense-full-frame-soft`.

Fixture IDs:

- `shadow-thin-caster-aabb-edge`
- `shadow-bilinear-support-boundary`
- `shadow-scene-edge-last-valid-step`
- `shadow-negative-threshold-cull-guard`
- `shadow-dense-full-frame-hard`
- `shadow-dense-full-frame-soft`
- `shadow-prefix-dz-positive-before-boundary`
- `shadow-prefix-dz-positive-after-boundary`
- `shadow-prefix-dz-zero`
- `shadow-prefix-dz-negative`
- `shadow-prefix-receiver-above-height`
- `shadow-prefix-small-positive-dz`
- `shadow-prefix-large-valid-stepcount`
- `shadow-prefix-nondyadic-0.1`
- `shadow-prefix-nondyadic-0.3`
- `shadow-prefix-height-equality`
- `shadow-prefix-xy-height-same-step`

### Historical-vs-optimized prefix equivalence

- `src/gpu/shadow-prefix.test.ts` runs a deterministic seeded 12,000-case sweep (fixed seed, reproducible review evidence) comparing the optimized prefix search against the historical f32 reference on every case.
- The same suite pins the strict-equality boundary (`rayZ == maxCasterHeight + bias`, plus one-ulp-below/above), a large fully valid stepCount without a linear reference loop, and the labeled boundary cases below.
- CPU oracle semantics remain unchanged; the ShadowPass WGSL predicate and the CPU oracle still share the exact historical f32 arithmetic via `rayZAtStep()`.

### Explicit boundary coverage

- `dz > 0` before/after boundary: `shadow-prefix-dz-positive-before-boundary`, `shadow-prefix-dz-positive-after-boundary`
- `dz == 0`: `shadow-prefix-dz-zero`
- `dz < 0`: `shadow-prefix-dz-negative`
- receiver above height bound: `shadow-prefix-receiver-above-height`
- very small positive `dz`: `shadow-prefix-small-positive-dz`
- large valid stepCount: `shadow-prefix-large-valid-stepcount`
- non-dyadic stepSize 0.1 / 0.3: `shadow-prefix-nondyadic-0.1`, `shadow-prefix-nondyadic-0.3`
- strict equality at `rayZ == maxCasterHeight + bias`: `shadow-prefix-height-equality`
- XY / height leave on the same step: `shadow-prefix-xy-height-same-step`
- thin caster at the AABB edge: `shadow-thin-caster-aabb-edge`
- bilinear AABB support boundary: `shadow-bilinear-support-boundary`
- last valid scene edge step: `shadow-scene-edge-last-valid-step`
- negative threshold cull guard: `shadow-negative-threshold-cull-guard`
- dense hard / soft full-frame pair: `shadow-dense-full-frame-hard`, `shadow-dense-full-frame-soft`

### Gate semantics

- The parity runner fails on missing fixture IDs, execution errors, or any policy-table mismatch; a real-adapter PASS is the only accepted outcome (SKIP is a failure).
- The vitest suite additionally executes the 12,000-case historical-vs-optimized sweep and the prefix boundary unit tests on every run; typecheck/build are part of the verification.
- Issue #48 は閉じていません。merge/close 判定は行っていません。

Generated from: [before artifact](packages/renderer/benchmark-results-issue-48-before.json), [after artifact](packages/renderer/benchmark-results-issue-48-after.json), [compact summary](packages/renderer/benchmark-results-issue-48.json), [#46 baseline artifact](packages/renderer/benchmark-results.json), [real-WebGPU parity run](packages/renderer/parity-results-issue-48.txt).
