# Exact byte comparison performance

The retained-frame scheduler, semantic scene classifier, partial-scene diff and
height-field reuse checks compare scene bytes repeatedly. Mask payloads can
make these ranges megabytes long. The old loops compared one byte per iteration.

This change shares an exact range comparator: small ranges retain scalar
comparison; ranges of at least 256 bytes compare uint32 words through DataView,
then compare the remaining 0–3 tail bytes. A differing first byte returns before
creating views. DataView permits arbitrary underlying buffer/view alignment.
Integer comparisons preserve all bit patterns, including distinct NaN payloads
and signed zeros. Caller bounds checks remain intact; invalid ranges still fail
closed. There are no hashes, payload copies, or persistent caches in this helper.

## Controlled measurements

Baseline: master `11ad3984c260cd124ac72b2678774d956c734f07`.
Node v24.19.0 on INTEL(R) XEON(R) PLATINUM 8573C. Built bundle digests and every sample are in
`packages/renderer/benchmark-results-byte-comparisons.json`. Both implementations
run in one process, 100 warmups each followed by 15 paired rounds alternating
execution order. Each value is median milliseconds per call; batch sizes appear
in the raw artifact. All 20 measured outputs are asserted equal before timing.

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| bytes-16-equal | 0.00004 | 0.00008 | 0.48x |
| bytes-16-first | 0.00005 | 0.00005 | 0.99x |
| bytes-16-last | 0.00006 | 0.00006 | 0.99x |
| bytes-128-equal | 0.00016 | 0.00016 | 1.00x |
| bytes-128-first | 0.00005 | 0.00003 | 1.67x |
| bytes-128-last | 0.00013 | 0.00014 | 0.93x |
| bytes-65536-equal | 0.06691 | 0.03099 | 2.16x |
| bytes-65536-first | 0.00002 | 0.00002 | 0.99x |
| bytes-65536-last | 0.06673 | 0.03060 | 2.18x |
| bytes-4194304-equal | 4.50021 | 2.10497 | 2.14x |
| bytes-4194304-first | 0.00001 | 0.00001 | 0.90x |
| bytes-4194304-last | 4.34282 | 1.99735 | 2.17x |
| classify-16-masks-32-light-only | 0.02369 | 0.01481 | 1.60x |
| diff-16-masks-32-identical | 0.20182 | 0.03278 | 6.16x |
| schedule-16-masks-32-light-only | 0.05361 | 0.04695 | 1.14x |
| diff-16-masks-32-surface-edit | 0.10043 | 0.02446 | 4.11x |
| classify-16-masks-256-light-only | 1.08373 | 0.56365 | 1.92x |
| diff-16-masks-256-identical | 6.05832 | 1.01324 | 5.98x |
| schedule-16-masks-256-light-only | 2.67014 | 2.17718 | 1.23x |
| diff-16-masks-256-surface-edit | 1.09923 | 0.53028 | 2.07x |

The `schedule` cases include the unchanged fingerprint calculation plus exact
semantic classification and invalidation reporting. With sixteen 256x256 masks,
that host work falls from 2.67014 to 2.17718 ms (18.5% less time). The real partial
planner's surface-edit diff falls from 1.09923 to 0.53028 ms (51.8% less time).
Identical-scene diff is an API stress/control case: the normal scheduler skips
that planner path. Do not interpret its approximately 6x result as frame speedup.

Small comparisons show nanosecond-scale variance/overhead (the 16-byte equality
case is slower); this optimization targets long mask ranges. Encoding, GPU
uploads, GPU passes and end-to-end FPS are not measured or claimed improved.

## Validation

- 53 renderer test files / 1066 tests passed.
- Workspace typecheck and full build passed.
- Independent scalar oracle across 16 length cases, every pair of byte
  alignments modulo 4 and every possible single-byte mismatch position.
- Shifted comparison ranges, subviews with different surrounding sentinels,
  tail-byte mutations, invalid ranges, NaN payload and signed-zero bit patterns.
- Existing scheduler, hash-collision hardening, retained provenance and partial
  dirty-region tests pass without changing tolerances or acceptance conditions.

## Reproduce

Build the baseline in a separate checkout using the lockfile and copy its
self-contained renderer `dist/index.js` bundle to `/tmp/byte-before.mjs`. Build
this PR, then run from the repository root while other CPU-heavy tasks are idle:

```sh
npm run build -w ukibori-renderer
node packages/renderer/scripts/bench-byte-comparisons.mjs /tmp/byte-before.mjs /tmp/byte-results.json
```

Based directly on master, independent of PRs #64–#66. Issue #12 is excluded.
