# Ukibori benchmark report (#46)

- schemaVersion: 1
- commit: bbbf1e5cdb7557be009d5ed2f8bf9e50c932f69e
- generatedAt: 2026-08-28T20:10:59.292Z
- e2e run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query true
- stage run: Windows_NT 10.0.26200 / AMD Ryzen 7 7700 8-Core Processor               / backend unknown / timestamp-query unknown
- dom run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query unknown

## Stage summary (median GPU ms, stage suite)

| Stage | Median GPU ms | Frame share |
|---|---|---|
| upload | n/a | n/a |
| height | 0.025 | 5.6% |
| normal | 0.004 | 0.9% |
| shadow | 0.387 | 85.4% |
| reconstruction | 0.020 | 4.5% |
| lighting | 0.009 | 2.0% |
| presentation | 0.004 | 0.8% |
| total | 0.453 | 100.0% |

## Resolution scaling (median GPU ms, full frame)

| Resolution | GPU ms | host ms | texels |
|---|---|---|---|
| 320 | 0.047 | 0.200 | 57600 |
| 640 | 0.116 | 0.300 | 230400 |
| 1280 | 0.362 | 0.200 | 921600 |
| 1920 | 0.817 | 0.300 | 2073600 |

## Surface-count scaling (median GPU ms)

| Surfaces | Frame GPU ms | Height GPU ms | Encoded bytes |
|---|---|---|---|
| 1 | 0.058 | 0.022 | 512 |
| 4 | 0.078 | 0.033 | 960 |
| 16 | 0.113 | 0.059 | 2496 |
| 64 | 0.232 | 0.178 | 8640 |
| 128 | 0.387 | 0.334 | 16832 |
| 256 | 0.746 | 0.692 | 33216 |
| 512 | 1.404 | 1.351 | 65984 |
| 1000 | 2.946 | 2.892 | 128448 |

## Mask-resolution scaling (16 masks, median GPU ms)

| Mask resolution | Frame GPU ms | Wall ms | Padded cells |
|---|---|---|---|
| 16 | 0.213 | 3.400 | 5184 |
| 32 | 0.562 | 3.900 | 18496 |
| 64 | 3.855 | 6.500 | 69696 |
| 128 | 52.650 | 54.200 | 270400 |
| 256 | 777.064 | 782.200 | 1065024 |

- mask SDF re-run on unrelated geometry update: passes=1, executed=[]

## Shadow sample scaling (median ShadowPass GPU ms)

| Samples | Angular radius | Soft | Shadow GPU ms | March steps |
|---|---|---|---|---|
| 1 | 0 | no | 0.102 | 400 |
| 4 | 0 | no | 0.102 | 400 |
| 8 | 0 | no | 0.101 | 400 |
| 16 | 0 | no | 0.100 | 400 |
| 1 | 0.05 | no | 0.102 | 400 |
| 4 | 0.05 | yes | 0.409 | 400 |
| 8 | 0.05 | yes | 0.815 | 400 |
| 16 | 0.05 | yes | 1.610 | 400 |
| 1 | 0.15 | no | 0.100 | 400 |
| 4 | 0.15 | yes | 0.462 | 400 |
| 8 | 0.15 | yes | 0.913 | 400 |
| 16 | 0.15 | yes | 1.808 | 400 |
| 1 | 0.3 | no | 0.100 | 400 |
| 4 | 0.3 | yes | 0.564 | 400 |
| 8 | 0.3 | yes | 1.128 | 400 |
| 16 | 0.3 | yes | 2.239 | 400 |

## Reconstruction radius × DPR (median GPU ms)

| Radius | DPR | Active | Taps/texel | Recon GPU ms | Frame GPU ms | Recon share |
|---|---|---|---|---|---|---|
| 0 | 1 | false | 0 | 0.000 | 0.013 | 0.0% |
| 1 | 1 | true | 9 | 0.012 | 0.026 | 44.7% |
| 2 | 1 | true | 25 | 0.020 | 0.035 | 59.3% |
| 4 | 1 | true | 81 | 0.048 | 0.061 | 75.6% |
| 0 | 2 | false | 0 | 0.000 | 0.031 | 0.0% |
| 1 | 2 | true | 25 | 0.061 | 0.090 | 68.2% |
| 2 | 2 | true | 81 | 0.149 | 0.179 | 83.0% |
| 4 | 2 | true | 289 | 0.465 | 0.497 | 93.8% |
| 0 | 3 | false | 0 | 0.000 | 0.093 | 0.0% |
| 1 | 3 | true | 49 | 0.219 | 0.301 | 72.9% |
| 2 | 3 | true | 169 | 0.611 | 0.693 | 88.3% |
| 4 | 3 | true | 625 | 2.069 | 2.158 | 95.9% |
| 0 | 4 | false | 0 | 0.000 | 0.186 | 0.0% |
| 1 | 4 | true | 81 | 0.569 | 0.753 | 75.4% |
| 2 | 4 | true | 289 | 1.773 | 1.959 | 91.2% |
| 4 | 4 | true | 1089 | 6.503 | 6.689 | 97.5% |

## Presentation microbenchmark (median wall ms)

| Stage | Wall ms | Canvas format |
|---|---|---|
| P4 | 0.500 | bgra8unorm |
| P0 | 5.000 | bgra8unorm |
| P1 | 2.700 | bgra8unorm |
| P2 | 3.400 | bgra8unorm |
| P3 | 2.600 | bgra8unorm |

## Submission-count overhead (median wall ms)

| Submissions | Wall ms |
|---|---|
| 1 | 0.100 |
| 2 | 0.100 |
| 4 | 0.100 |
| 6 | 0.300 |
| 8 | 0.200 |

## Upload benchmark (median host ms, 64-surface grid)

| Update type | Host ms | Encoded bytes | Uploaded bytes | writeBuffer calls |
|---|---|---|---|---|
| first | 0.100 | 8640 | 8640 | 3 |
| identical | 0.000 | 8640 | 8640 | 3 |
| light-only | 0.100 | 8640 | 8640 | 3 |
| material-values-only | 0.100 | 8640 | 8640 | 3 |
| single-surface-geometry | 0.100 | 8640 | 8640 | 3 |
| mask-change | 0.100 | 2240 | 2240 | 5 |

## Partial recompute (median GPU ms)

| Dirty ratio | Mode | Frame GPU ms | Dirty texels | Dispatch texels | Planning host ms |
|---|---|---|---|---|---|
| 1% | partial | 0.033 | 10200 | 81920 | 0.1000 |
| 5% | partial | 0.034 | 8900 | 81920 | 0.1000 |
| 10% | partial | 0.034 | 7300 | 81920 | 0.0000 |
| 25% | partial | 0.034 | 5700 | 81920 | 0.0000 |
| 50% | partial | 0.034 | 13700 | 81920 | 0.1000 |
| 75% | partial | 0.034 | 21700 | 81920 | 0.0000 |
| 100% | partial | 0.031 | 25650 | 81920 | 0.0000 |

## Retained scheduling (median wall ms per frame)

| Case | Wall ms | Submissions/frame | Executed | Expected |
|---|---|---|---|---|
| no-change | 0.100 | 0.00 |  |  |
| repaint-only | 0.600 | 1.00 | presentation | presentation |
| light-intensity | 0.100 | 0.10 | upload,lighting,presentation| | upload,lighting,presentation |
| light-direction | 0.100 | 0.15 | upload,shadow,reconstruction,lighting,presentation| | upload,shadow,reconstruction,lighting,presentation |
| material-values | 0.100 | 0.15 | upload,shadow,reconstruction,lighting,presentation| | upload,shadow,reconstruction,lighting,presentation |
| geometry | 0.100 | 0.25 | upload,height,normal,shadow,reconstruction,lighting,presentation| | upload,height,normal,shadow,reconstruction,lighting,presentation |

## End-to-end frame cases (median wall ms)

| Case | Wall ms | GPU ms | Executed |
|---|---|---|---|
| cold-first | 7.600 | 0.139 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| warmed-full | 2.900 | 0.118 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| retained | 0.200 | n/a |  |
| repaint | 0.500 | 0.006 | presentation |
| light-intensity | 0.900 | 0.013 | upload,lighting,presentation |
| light-direction | 4.200 | 0.083 | upload,shadow,reconstruction,lighting,presentation |
| material-values | 3.100 | 0.013 | upload,lighting,presentation |
| geometry-move | 4.900 | 0.117 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| partial-geometry | 1.200 | 0.117 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| forced-full | 3.800 | 0.136 | upload,height,normal,shadow,reconstruction,lighting,presentation |

## DOM integration (median wall ms)

| Scenario | Surfaces | Wall ms | Rect calls | Renderer invocations | Skipped render | Executed |
|---|---|---|---|---|---|---|
| stable-page | 1 | 0.500 | 0 | 0.00 | 1.00 |  |
| one-surface-resize | 1 | 0.700 | 3 | 1.00 | 0.00 |  |
| unrelated-mutation | 1 | 0.100 | 1 | 0.00 | 1.00 |  |
| frequent-mutations | 1 | 0.200 | 1 | 0.00 | 1.00 | |upload,height,normal,shadow,reconstruction,lighting,presentation |
| scroll | 1 | 0.000 | 0 | 0.00 | 1.00 |  |
| stable-page | 10 | 0.000 | 0 | 0.00 | 1.00 |  |
| one-surface-resize | 10 | 1.600 | 12 | 1.00 | 0.00 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| unrelated-mutation | 10 | 0.100 | 10 | 0.00 | 1.00 |  |
| frequent-mutations | 10 | 0.200 | 10 | 0.00 | 1.00 | |upload,height,normal,shadow,reconstruction,lighting,presentation |
| scroll | 10 | 0.100 | 0 | 0.00 | 1.00 |  |
| stable-page | 50 | 0.400 | 0 | 0.00 | 1.00 |  |
| one-surface-resize | 50 | 2.500 | 52 | 1.00 | 0.00 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| unrelated-mutation | 50 | 0.700 | 50 | 0.00 | 1.00 |  |
| frequent-mutations | 50 | 0.900 | 50 | 0.00 | 1.00 | |upload,height,normal,shadow,reconstruction,lighting,presentation |
| scroll | 50 | 0.000 | 0 | 0.00 | 1.00 |  |
| stable-page | 100 | 0.600 | 0 | 0.00 | 1.00 |  |
| one-surface-resize | 100 | 1.800 | 102 | 1.00 | 0.00 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| unrelated-mutation | 100 | 0.500 | 100 | 0.00 | 1.00 |  |
| frequent-mutations | 100 | 0.700 | 100 | 0.00 | 1.00 | |upload,height,normal,shadow,reconstruction,lighting,presentation |
| scroll | 100 | 0.600 | 100 | 0.00 | 1.00 |  |
| stable-page | 250 | 1.600 | 250 | 0.00 | 1.00 |  |
| one-surface-resize | 250 | 4.700 | 252 | 1.00 | 0.00 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| unrelated-mutation | 250 | 0.600 | 250 | 0.00 | 1.00 |  |
| frequent-mutations | 250 | 1.900 | 250 | 0.00 | 1.00 | |upload,height,normal,shadow,reconstruction,lighting,presentation |
| scroll | 250 | 2.100 | 250 | 0.00 | 1.00 |  |
| stable-page | 500 | 1.900 | 0 | 0.00 | 1.00 |  |
| one-surface-resize | 500 | 8.400 | 502 | 1.00 | 0.00 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| unrelated-mutation | 500 | 2.900 | 500 | 0.00 | 1.00 |  |
| frequent-mutations | 500 | 4.300 | 500 | 0.00 | 1.00 | |upload,height,normal,shadow,reconstruction,lighting,presentation |
| scroll | 500 | 3.400 | 500 | 0.00 | 1.00 |  |
| stable-page | 1000 | 2.400 | 0 | 0.00 | 1.00 |  |
| one-surface-resize | 1000 | 13.900 | 1002 | 1.00 | 0.00 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| unrelated-mutation | 1000 | 3.900 | 1000 | 0.00 | 1.00 |  |
| frequent-mutations | 1000 | 6.000 | 1000 | 0.00 | 1.00 |  |
| scroll | 1000 | 5.600 | 1000 | 0.00 | 1.00 |  |

## Bottleneck matrix

| Workload | Main bottleneck | Secondary | Scaling factor | Evidence |
|---|---|---|---|---|
| simple 640x360 | shadow | - | pixels | 0.078ms GPU shadow |
| many surfaces | height | - | pixels × surfaces | 2.892ms height / 2.946ms frame (1000 surfaces) |
| many masks | height (mask SDF) | - | mask cells | 777.064ms frame at mask res 256 (1065024 cells) |
| soft shadow | shadow | - | pixels × samples × march | 1.808ms shadow at 16 samples (18.0x vs 1 sample) |
| high DPR + reconstruction | reconstruction | - | DPR² + radiusTexels² | 6.503ms recon / 6.689ms frame at DPR 4 radius 4 |
| DOM-heavy | measurement | skipped render | registered surfaces | 1000 getBoundingClientRect at 1000 surfaces |

## Follow-up optimization candidates

1. **ReconstructionPass is 59.3% of the frame at DPR 1 radius 2** — 0.020ms of 0.035ms. Candidate: shared-memory / separable reconstruction (currently (2r+1)^2 neighborhood).
2. **Mask SDF generation costs 777.064ms at mask resolution 256** — 1065024 padded mask cells. Candidate: mask SDF algorithm / caching (unchanged masks recomputed on geometry updates).
3. **Soft shadow at 16 samples costs 18.0x the 1-sample hard path (1.808ms)** — samples {1,4,8,16} → 0.100/1.808ms shadow. Candidate: shadow marcher acceleration / hierarchical ray skipping.
4. **Full frame issues 6 queue.submit calls** — submission-count benchmark (1..8 empty submissions are sub-ms each). Candidate: single-command-buffer renderer redesign (baseline recorded).

## Notes

- hostMs = host encode/upload/dispatch wall time; gpuTimestampMs = real GPU timestamp-query duration (unsupported adapters report n/a, never fabricated zeros); wallMs = render + `queue.onSubmittedWorkDone()` completion.
- Values are median over the warmed samples; p95/min/max live in the JSON documents.
- Absolute timings are hardware-specific; only compare runs on the same machine/runner.
