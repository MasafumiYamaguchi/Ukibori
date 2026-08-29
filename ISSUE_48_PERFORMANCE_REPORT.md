# Issue #48 ShadowPass ray-march acceleration

- Branch: `feat/issue-48-shadow-raymarch`
- Baseline: Issue #46's clean 640x360 run (`packages/renderer/benchmark-results.json`, commit `412c2234d1648da57c99626f576735b752324aa4`)
- Implementation: ray-bound prefix search + conservative casting-surface AABB empty-space culling
- Quality policy: the existing f32 march series, strict comparison, receiver rules, max-height exit, sample directions, DPR convention and retained/partial scheduling are unchanged

## Profile and analysis

The #46 profile identifies ShadowPass as the dominant GPU stage at the reference
resolution (0.389 ms of a 0.453 ms frame, 85.9%). The same run shows the
work grows almost linearly with soft-light samples (0.912 ms at radius 0.15,
8 samples) while the configured travel budget saturates after the scene-bound
and max-height exits (0.729 / 0.909 / 0.910 ms for 40 / 120 / 300 scene units).
The hot loop therefore spends work on rays that have already left the valid
pixel rectangle and on bilinear reads in the guaranteed-zero part of the
caster field.

Candidate review:

| Candidate | Decision | Reason |
|---|---|---|
| Mip/hierarchical height bounds | Rejected | Requires a new reduction/storage path and changes the exact field sampled at each march step. It also adds work to retained/partial updates. |
| Per-tile spatial bounds buffer | Rejected | Adds a new allocation and dispatch/bind-group contract; the issue explicitly excludes a large storage redesign. |
| Adaptive step size | Rejected | Changes sample positions and can miss thin, tall, overlapping or boundary-touching blockers. |
| Layout/coalescing rewrite | Rejected | The existing four storage reads are already tightly packed and are needed for the exact bilinear sample. |
| Ray-bound prefix search + caster AABB hint | **Adopted** | Removes the per-step bounds branch, skips provably empty bilinear reads, and uses no extra pass, allocation, upload or submission. |

## Adopted algorithm

1. `rayBoundsStepLimit` evaluates the historical inclusive pixel-center
   predicate with the historical `f32(stepIndex) * stepSize` arithmetic. Since
   `stepSize > 0` and each projected coordinate is monotone for a fixed light
   direction, valid integer steps are a prefix. A bounded binary search finds
   the last valid step; the march then visits exactly that prefix.
2. The host scans the already validated ABI surface records and computes the
   union of AABBs for surfaces with `FLAG_CASTS_SHADOW`. The four values are
   packed into the otherwise-unused `w` lanes of direction entries 0..3; all
   direction code continues to read `.xyz` only.
3. The shader expands that union by two render-texel widths in logical units
   (`2.0 / dpr`) to cover bilinear support. Outside the padded union the caster
   field is exactly the zero base plane, so the four storage reads are skipped
   whenever `rayZ + bias >= 0`. Negative thresholds still perform the read,
   because zero can then be a strict occluder.

No new GPU resource is created. The uniform remains 2144 bytes, dispatch
dimensions and submission count are unchanged, and the retained/partial
planner still owns the same invalidation closure.

## Correctness and adversarial coverage

- The blocker test remains strict (`sample > f32(rayZ + bias)`); equality is
  lit.
- The max-caster-height early exit is unchanged and remains host-derived from
  casting ABI records.
- The ray-bound search uses the same f32 operations as the old predicate, so
  thin/tall/overlap, short/medium/long travel, hard/soft samples, DPR, floating
  boundaries and zero/empty caster fields retain the old set of sampled steps.
- A no-caster scene still takes the existing uniform-driven early exit; its
  packed AABB sentinel is finite zeroes.
- Structural tests pin the uniform lanes, binary-search contract, conservative
  pad, negative-threshold fallback and unchanged receiver/region guards.

## Benchmark contract and results

The #46 browser harness now records the algorithm and its cost contract on
every ShadowPass case: binary-search iteration upper bound, caster AABB/pad,
and zero extra passes/dispatches/uploads/storage bytes. These are explicit
metadata, not fabricated GPU counters. The full measured result is
[`packages/renderer/benchmark-results-issue-48-after.json`](packages/renderer/benchmark-results-issue-48-after.json);
the compact before/after summary is
[`packages/renderer/benchmark-results-issue-48.json`](packages/renderer/benchmark-results-issue-48.json).

The following table uses the same 640x360, 5 warmup, 20 timed-sample
conditions as #46. GPU values are medians in milliseconds from timestamp
queries; the total column includes all stages in the frame.

| Case | #46 before | #48 after | Change |
|---|---:|---:|---:|
| Stage ShadowPass | 0.389184 | 0.234624 | -39.7% |
| Stage total frame | 0.452992 | 0.298592 | -34.1% |
| Soft shadow, 8 samples, radius 0.15 | 0.912016 | 0.329840 | -63.8% |
| Travel short (40 units) | 0.728528 | 0.264656 | -63.7% |
| Travel medium (120 units) | 0.908704 | 0.324752 | -64.3% |
| Travel long (300 units) | 0.910384 | 0.345136 | -62.1% |

All 19 `shadow/*` cases in the captured suite were non-regressions (median
ShadowPass timestamp improvement range: 59.4%–64.8%).

The measured after run used the same real WebGPU timestamp path. On this
restricted desktop host Chrome needed the explicit diagnostic environment
variable `BENCH_CHROME_NO_SANDBOX=1`; the default runner remains sandboxed.
The committed after artifact records `workingTreeDirty: true` because it was
captured before this branch was committed; it is a measured comparison result,
not a clean #46-style baseline.
Reproduce it with:

```text
npm run build -w ukibori-renderer
# PowerShell
$env:BENCH_CHROME_NO_SANDBOX="1"
node packages/renderer/scripts/bench-gpu.mjs --suite stage,shadow --samples 20 --warmup 5 --width 640 --height 360 --json packages/renderer/benchmark-results-issue-48-after.json --allow-dirty
```

The benchmark keeps GPU timestamp, host and wall timings separate and includes
the total frame, so the acceptance check is `after.gpuTimestampMs <=
before.gpuTimestampMs` for each unchanged #46 case, with visibility parity
checked by the existing browser oracle.

## Verification performed here

- `npm.cmd test -w ukibori-renderer -- --run src/gpu/shadow-pass.test.ts` — 56/56
- `npm.cmd run typecheck -w ukibori-renderer` — passed
- `npm.cmd run build -w ukibori-renderer` — passed
- `node --check packages/renderer/test-browser/bench-gpu.mjs` — passed
- `CHROME_PATH=.../chrome.exe WEBGPU_CHROME_NO_SANDBOX=1 npm.cmd run test:webgpu -w ukibori-renderer` — 99 fixtures, 0 mismatches; shadow 0/77808 exact, retained/partial 0 problems (the existing reconstruction microbenchmark also logs its pre-existing input-shape error while the parity gate remains PASS)
- Full renderer test baseline still has the four pre-existing `.mjs`/WASM
  environment load failures documented by Issue #43; no new failure is caused
  by this change.
