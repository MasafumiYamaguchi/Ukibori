# Issue #48 ShadowPass ray-march optimization

このレポートは、同一条件の clean な #46 実機WebGPUベンチマーク2本から機械生成したものです。数値は手入力していません。

## Provenance

- Baseline commit: `3c315d2b6ca95432e87f5367a10370a0b8b4f399` (workingTreeDirty=false)
- Optimized commit: `da2b2b6fb184da76b6545a4b95dd27b70506b836` (workingTreeDirty=false)
- Benchmark artifact commit: `777943c0d710c28003acd52a92eac8913906cd69`
- Adapter: nvidia / blackwell / backend unknown
- Browser: chrome 151.0; timestamp-query=true

## Conditions and resource contract

- Resolution 640x360, DPR 1, warmups 5, timed samples 20.
- Shadow options: stepSize 0.5, bias 0.5; GPU timestamps are kept separate from host/wall timing.
- Algorithm: ray-bound-prefix-binary-search+caster-aabb-empty-space; no extra ShadowPass passes/dispatches/uploads/storage ({"extraShadowPasses":0,"extraShadowDispatches":0,"extraShadowUploads":0,"extraShadowStorageBytes":0}).

## Measured GPU timings

Values are `median / p95` milliseconds; Δ is after vs before (negative is faster). The frame column is the full submitted frame where available.

| Case | Shadow before → after | Δ | Frame before → after | Δ |
|---|---:|---:|---:|---:|
| stage/shadow | 0.390 / 0.404 → 0.228 / 0.229 | -41.5% | n/a → n/a | n/a |
| stage/frame-total | n/a → n/a | n/a | 0.454 / 0.603 → 0.292 / 0.296 | -35.6% |
| shadow/samples-8/radius-0.15 | 0.911 / 1.047 → 0.322 / 0.334 | -64.7% | 0.946 / 1.083 → 0.357 / 0.369 | -62.3% |
| shadow/travel-short | 0.729 / 0.861 → 0.269 / 0.277 | -63.1% | n/a → n/a | n/a |
| shadow/travel-medium | 0.909 / 0.929 → 0.322 / 0.329 | -64.6% | n/a → n/a | n/a |
| shadow/travel-long | 0.911 / 0.931 → 0.323 / 0.337 | -64.5% | n/a → n/a | n/a |
| shadow/worst/dense-caster | 0.107 / 0.131 → 0.087 / 0.106 | -18.4% | 0.142 / 0.164 → 0.122 / 0.140 | -14.0% |
| shadow/worst/near-blocker | 0.092 / 0.111 → 0.035 / 0.040 | -61.7% | 0.106 / 0.126 → 0.049 / 0.055 | -53.5% |
| shadow/worst/max-height-fast-exit | 0.005 / 0.005 → 0.005 / 0.015 | +14.4% | 0.019 / 0.019 → 0.020 / 0.029 | +4.0% |
| shadow/worst/dense-overlap | 0.039 / 0.056 → 0.044 / 0.055 | +11.5% | 0.073 / 0.091 → 0.078 / 0.089 | +6.9% |

## Worst-case workload metadata

AABB coverage is `clamp(unionCasterAabbArea / frameLogicalArea, 0, 1)`. Both artifacts retain min/max/samples/warmups and all resource counters in the compact JSON and full JSON files.

| Scenario | Samples / angular radius | Steps | AABB coverage | Before search | After search |
|---|---:|---:|---:|---|---|
| dense-caster (shadow-worst-dense-caster) | 8 / 0.150 | 200 / 0.5 (400) | 0.9649 | per-step-bounds-check | monotone-prefix-binary-search (9 iters) |
| near-blocker (shadow-worst-near-blocker) | 1 / 0.000 | 200 / 0.5 (400) | 0.0249 | per-step-bounds-check | monotone-prefix-binary-search (9 iters) |
| max-height-fast-exit (shadow-worst-max-height-fast-exit) | 1 / 0.000 | 300 / 0.5 (600) | 0.9913 | per-step-bounds-check | monotone-prefix-binary-search (10 iters) |
| dense-overlap (shadow-worst-dense-overlap) | 8 / 0.150 | 200 / 0.5 (400) | 0.9913 | per-step-bounds-check | monotone-prefix-binary-search (9 iters) |

### Worst-case complete timing summaries

Each cell is `median / p95 / min / max ms (n=samples, w=warmups)`; these are the raw timestamp summaries used for the deltas above.

| Scenario | Shadow before | Shadow after | Frame before | Frame after | Extra resources (after) |
|---|---:|---:|---:|---:|---|
| dense-caster | 0.107/0.131/0.098/0.135 ms (n=20, w=5) | 0.087/0.106/0.082/0.107 ms (n=20, w=5) | 0.142/0.164/0.132/0.170 ms (n=20, w=5) | 0.122/0.140/0.116/0.141 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |
| near-blocker | 0.092/0.111/0.089/0.112 ms (n=20, w=5) | 0.035/0.040/0.034/0.045 ms (n=20, w=5) | 0.106/0.126/0.101/0.126 ms (n=20, w=5) | 0.049/0.055/0.047/0.059 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |
| max-height-fast-exit | 0.005/0.005/0.005/0.005 ms (n=20, w=5) | 0.005/0.015/0.005/0.015 ms (n=20, w=5) | 0.019/0.019/0.018/0.019 ms (n=20, w=5) | 0.020/0.029/0.019/0.029 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |
| dense-overlap | 0.039/0.056/0.034/0.056 ms (n=20, w=5) | 0.044/0.055/0.041/0.060 ms (n=20, w=5) | 0.073/0.091/0.068/0.091 ms (n=20, w=5) | 0.078/0.089/0.075/0.094 ms (n=20, w=5) | passes=0, dispatches=0, uploads=0, storageBytes=0 |

## Regression accounting

- Median ShadowPass regressions (reported, not hidden): shadow/worst/max-height-fast-exit +14.4%, shadow/worst/dense-overlap +11.5%.
- Median frame-total regressions (reported, not hidden): shadow/worst/max-height-fast-exit +4.0%, shadow/worst/dense-overlap +6.9%.
- These cases remain in the comparison so the optimization is not presented as universally faster.

## Correctness gate

- The real-WebGPU parity runner executes the explicit #48 adversarial fixture set (thin caster/AABB edge, bilinear support boundary, last valid step, negative-threshold cull guard, dense full-frame hard and soft) and fails on missing IDs, execution errors, or mismatches.
- CPU oracle semantics remain unchanged; the checked-in parity run and unit/build/typecheck results are reported alongside this artifact in the task handoff.
- Issue #48 は閉じていません。merge/close 判定は行っていません。

Generated from: [before artifact](packages/renderer/benchmark-results-issue-48-before.json), [after artifact](packages/renderer/benchmark-results-issue-48-after.json), [compact summary](packages/renderer/benchmark-results-issue-48.json).
