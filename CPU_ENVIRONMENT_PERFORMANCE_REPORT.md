# CPU uniform environment preparation

CPU shading evaluated the same uniform environment response for every pixel.
Prepare it once per visible surface owner (and once for the base plane), alongside
the existing per-call material cache. Hoist the scene light color outside the
pixel loop. Environment, BRDF, saturation, exposure and sRGB formulas are unchanged.
The cache is local to each shading call, so in-place material/environment edits
are visible in the next frame and no persistent cache invalidation is needed.

## Measurement

Baseline master: `11ad3984c260cd124ac72b2678774d956c734f07`.
Node v24.19.0 on INTEL(R) XEON(R) PLATINUM 8573C. Five warmups per implementation, then 15
alternating-order paired samples. Median milliseconds for the complete CPU
`shadePreparedFields` call, including allocations; geometry, normals and
visibility are prepared outside timing. Raw samples and bundle digests are in
`packages/renderer/benchmark-results-lighting-environment.json`.

| Workload | Before ms | After ms | Speedup |
| --- | ---: | ---: | ---: |
| 320x180-1-surfaces-env-0 | 28.819 | 26.586 | 1.08x |
| 320x180-1-surfaces-env-0.5 | 30.815 | 27.317 | 1.13x |
| 320x180-1-surfaces-env-4 | 26.211 | 25.144 | 1.04x |
| 320x180-64-surfaces-env-0 | 33.783 | 28.548 | 1.18x |
| 320x180-64-surfaces-env-0.5 | 30.039 | 26.590 | 1.13x |
| 320x180-64-surfaces-env-4 | 24.446 | 23.748 | 1.03x |
| 640x360-16-surfaces-env-0 | 110.647 | 102.527 | 1.08x |
| 640x360-16-surfaces-env-0.5 | 112.957 | 104.423 | 1.08x |
| 640x360-16-surfaces-env-4 | 97.256 | 90.057 | 1.08x |

The representative 640x360 / 16-surface / default-environment case saves 8.534 ms
(7.6% less CPU shading time). These measurements do not include the other CPU
rendering stages and do not imply an equivalent FPS increase. GPU shaders and
GPU performance are unchanged.

## Validation

- 53 renderer test files / 1064 tests passed.
- Workspace typecheck and full build passed.
- All diffuse/specular f32 values and RGBA8 bytes match the baseline exactly
  for 9 timed cases and 24 in-place mutation cases (light direction, roughness,
  metallic and environment intensity; includes the degenerate back light).
- Regression test checks material/environment edits across repeated calls,
  immutable prior outputs, environment independence from visibility and base
  fallback for absent/invalid owners.

## Reproduce

Build baseline with the lockfile in a separate checkout and copy its renderer
`dist/index.js` to `/tmp/lighting-before.mjs`. Build this PR, then run:

```sh
npm run build -w ukibori-renderer
node packages/renderer/scripts/bench-lighting-environment.mjs /tmp/lighting-before.mjs /tmp/lighting-results.json
```

The output path is optional. Keep competing CPU-heavy work idle during timing.
Independent master-based PR; Issue #12 remains excluded.

## Rejected candidate

A separate prototype compared upload sections against prior encoded bytes to
skip unchanged GPU writes. Native Dawn/SwiftShader measurements showed the extra
CPU scan outweighed the transfer savings (e.g. sixteen 256x256 masks: approximately
0.11 ms unconditional versus 1.71 ms selective upload, including queue completion).
That prototype was discarded; this PR changes neither uploader nor pipeline.
