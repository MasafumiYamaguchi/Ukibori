# Scene encoding performance

The production GPU pipeline calls `encodeScene` before upload/diff planning.
Previously it copied each mask into a temporary payload and then into the final
scene allocation, and scanned the material reference array twice per surface.
Scenes with many distinct materials therefore performed quadratic lookups.

This change writes mask payloads directly into the final zero-initialized scene
buffer and uses a local Map for first-appearance material indices. It removes
one payload-sized temporary allocation/copy per unique mask (4 MiB for sixteen
256x256 f32 masks), plus the redundant explicit zero fill of the new buffer.
No persistent cache is introduced: in-place scene/mask edits remain visible.

The ABI, material order, mask identity deduplication, padding, f32 little-endian
packing and encoded byte length remain unchanged. This PR is based directly on
master and does not require PR #64 or #65. It does not implement Issue #12.

## Measurement

Baseline: `11ad3984c260cd124ac72b2678774d956c734f07`.
Candidate: this PR's encoder, built with the same dependencies and environment.
Both bundle SHA-256 digests and all timing samples are recorded in
`packages/renderer/benchmark-results-encoding.json`.

Node v24.19.0 on INTEL(R) XEON(R) PLATINUM 8573C. Each case uses 200 warmup calls per
implementation, followed by 15 alternating-order paired rounds. Each round
contains 100 encodes (20 for 256x256 masks); the table reports the median
per-encode milliseconds. Scene validation is outside the timed section.
The harness compares the complete output bytes for all 12 workloads at DPR
1, 1.5 and 2 before measuring: all 36 comparisons are exact.

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| surfaces-9-shared | 0.0100 | 0.0092 | 1.09x |
| surfaces-9-unique | 0.0077 | 0.0061 | 1.28x |
| surfaces-64-shared | 0.0181 | 0.0166 | 1.09x |
| surfaces-64-unique | 0.0315 | 0.0290 | 1.09x |
| surfaces-512-shared | 0.1232 | 0.1125 | 1.10x |
| surfaces-512-unique | 0.5717 | 0.2293 | 2.49x |
| surfaces-2048-shared | 0.4725 | 0.4618 | 1.02x |
| surfaces-2048-unique | 6.6350 | 1.3754 | 4.82x |
| masks-16-32-u8 | 0.0408 | 0.0227 | 1.80x |
| masks-16-256-u8 | 0.4792 | 0.1281 | 3.74x |
| masks-16-32-f32 | 0.0829 | 0.0422 | 1.96x |
| masks-16-256-f32 | 4.6027 | 2.5348 | 1.82x |

These are CPU encoding microbenchmarks, not end-to-end FPS measurements.
Small shared-material workloads show little absolute benefit. The 2048-unique
case is a scaling stress case, not a claim about a typical UI. Software/hardware
GPU rendering performance was not measured; shaders are unchanged.

## Reproduce

Build the baseline renderer in a separate checkout using the lockfile and copy
its self-contained `packages/renderer/dist/index.js` to `/tmp/encode-before.mjs`.
Then build the candidate and run from the repository root:

```sh
npm run build -w ukibori-renderer
node packages/renderer/scripts/bench-encoding.mjs /tmp/encode-before.mjs /tmp/encoding-results.json
```

The output path is optional. Keep other CPU-intensive tasks idle during timing.

## Validation

- Renderer: 52 test files, 1065 tests passed.
- Workspace typecheck and full build passed.
- Existing ABI/material ordering and mask packing tests passed.
- Added u8/f32 subview tests cover shared-mask deduplication, zero padding,
  source mutation after encoding, and fresh encoding after that mutation.
- Complete baseline/candidate byte equality: 36 cases.
