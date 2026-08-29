# Ukibori benchmark report (#46)

- schemaVersion: 1
- commit: 412c2234d1648da57c99626f576735b752324aa4
- workingTreeDirty: false
- generatedAt: 2026-08-29T14:03:49.958Z
- stage run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query true
- stage run: Windows_NT 10.0.26200 / AMD Ryzen 7 7700 8-Core Processor               / backend unknown / timestamp-query unknown
- dom run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query unknown

## Stage summary (median GPU ms, stage suite)

| Stage | Median GPU ms | Frame share |
|---|---|---|
| upload | n/a | n/a |
| height | 0.025 | 5.5% |
| normal | 0.004 | 0.9% |
| shadow | 0.389 | 85.9% |
| reconstruction | 0.021 | 4.5% |
| lighting | 0.009 | 1.9% |
| presentation | 0.005 | 1.2% |
| total | 0.453 | 100.0% |

## Resolution scaling (median GPU ms, full frame)

| Resolution | GPU ms | host ms | texels |
|---|---|---|---|
| 320 | 0.048 | 0.250 | 57600 |
| 640 | 0.118 | 0.400 | 230400 |
| 1280 | 0.365 | 0.300 | 921600 |
| 1920 | 0.814 | 0.300 | 2073600 |

## Surface-count scaling (median GPU ms)

| Surfaces | Frame GPU ms | Height GPU ms | Encoded bytes |
|---|---|---|---|
| 1 | 0.058 | 0.022 | 512 |
| 4 | 0.078 | 0.031 | 960 |
| 16 | 0.112 | 0.058 | 2496 |
| 64 | 0.232 | 0.178 | 8640 |
| 128 | 0.389 | 0.335 | 16832 |
| 256 | 0.742 | 0.688 | 33216 |
| 512 | 1.407 | 1.353 | 65984 |
| 1000 | 3.095 | 3.041 | 128448 |

## Mask-resolution scaling (16 masks, median GPU ms)

| Mask resolution | Frame GPU ms | Wall ms | Padded cells |
|---|---|---|---|
| 16 | 0.213 | 3.700 | 5184 |
| 32 | 0.565 | 4.100 | 18496 |
| 64 | 3.871 | 6.000 | 69696 |
| 128 | 52.152 | 55.100 | 270400 |
| 256 | 777.994 | 782.600 | 1065024 |

## Mask-count scaling (32x32 masks, median GPU ms)

| Masks | Frame GPU ms | Height GPU ms | Mask SDF passes | Compose passes | Padded cells | Uploaded bytes |
|---|---|---|---|---|---|---|
| 0 | 0.041 | 0.019 | 0 | 5 | 0 | 320 |
| 1 | 0.465 | 0.427 | 1 | 5 | 1156 | 1568 |
| 16 | 0.564 | 0.526 | 1 | 5 | 18496 | 19328 |
| 64 | 1.250 | 1.212 | 1 | 5 | 73984 | 76160 |

- unchanged mask + unrelated geometry update (this frame): executed=[upload,height,normal,shadow,reconstruction,lighting,presentation], planning=partial (band 192..359 coverage 0.467), maskSdfPasses=1, composePasses=5, totalMaskCells=18496, height GPU=0.488ms, maskSDF GPU=0.481ms, compose GPU=0.057ms, wall=4.250ms (samples=20)

## Shadow sample scaling (median ShadowPass GPU ms)

| Samples | Angular radius | Soft | Shadow GPU ms | March steps |
|---|---|---|---|---|
| 1 | 0 | no | 0.100 | 400 |
| 4 | 0 | no | 0.100 | 400 |
| 8 | 0 | no | 0.100 | 400 |
| 16 | 0 | no | 0.101 | 400 |
| 1 | 0.05 | no | 0.101 | 400 |
| 4 | 0.05 | yes | 0.408 | 400 |
| 8 | 0.05 | yes | 0.810 | 400 |
| 16 | 0.05 | yes | 1.609 | 400 |
| 1 | 0.15 | no | 0.101 | 400 |
| 4 | 0.15 | yes | 0.461 | 400 |
| 8 | 0.15 | yes | 0.912 | 400 |
| 16 | 0.15 | yes | 1.806 | 400 |
| 1 | 0.3 | no | 0.101 | 400 |
| 4 | 0.3 | yes | 0.564 | 400 |
| 8 | 0.3 | yes | 1.127 | 400 |
| 16 | 0.3 | yes | 2.244 | 400 |

## Shadow travel distance (median ShadowPass GPU ms)

The travel axis is the CONFIGURED march budget (the sanitized maxDistance the pass packs): short 40 / medium 120 / long 300 scene units at stepSize 0.5. The dispatch step counts differ by construction; the MEASURED GPU cost can saturate when scene bounds / early exits bound the effective ray travel (configured budget != executed work).

| Travel | Shadow samples | maxDistance | stepSize | Theoretical max steps | Shadow GPU ms | Dispatch step count |
|---|---|---|---|---|---|---|
| short | 8 | 40 | 0.5 | 80 | 0.729 | 80 |
| medium | 8 | 120 | 0.5 | 240 | 0.909 | 240 |
| long | 8 | 300 | 0.5 | 600 | 0.910 | 600 |

## Reconstruction radius x DPR (median GPU ms)

| Radius | DPR | Active | Taps/texel | Recon GPU ms | Frame GPU ms | Recon share |
|---|---|---|---|---|---|---|
| 0 | 1 | false | 0 | 0.000 | 0.014 | 0.0% |
| 1 | 1 | true | 9 | 0.011 | 0.026 | 44.5% |
| 2 | 1 | true | 25 | 0.021 | 0.034 | 59.2% |
| 4 | 1 | true | 81 | 0.048 | 0.062 | 77.7% |
| 0 | 1.5 | false | 0 | 0.000 | 0.020 | 0.0% |
| 1 | 1.5 | true | 25 | 0.036 | 0.056 | 64.5% |
| 2 | 1.5 | true | 49 | 0.058 | 0.079 | 74.2% |
| 4 | 1.5 | true | 169 | 0.165 | 0.185 | 88.9% |
| 0 | 2 | false | 0 | 0.000 | 0.034 | 0.0% |
| 1 | 2 | true | 25 | 0.062 | 0.100 | 62.8% |
| 2 | 2 | true | 81 | 0.149 | 0.182 | 83.4% |
| 4 | 2 | true | 289 | 0.466 | 0.499 | 93.1% |
| 0 | 3 | false | 0 | 0.000 | 0.128 | 0.0% |
| 1 | 3 | true | 49 | 0.218 | 0.306 | 71.1% |
| 2 | 3 | true | 169 | 0.606 | 0.693 | 87.0% |
| 4 | 3 | true | 625 | 2.075 | 2.165 | 95.8% |
| 0 | 4 | false | 0 | 0.000 | 0.186 | 0.0% |
| 1 | 4 | true | 81 | 0.569 | 0.753 | 75.5% |
| 2 | 4 | true | 289 | 1.776 | 1.964 | 90.5% |
| 4 | 4 | true | 1089 | 6.738 | 6.931 | 97.2% |

## Presentation microbenchmark

P0-P3 wall = submission + queue completion; GPU timestamp = the render pass itself (null on adapters without timestamp-query). P4 wall = production pipeline.present(); P4 GPU timestamp = the presentation stage of a production repaint render. Wall cost alone must never be read as shader cost.

| Stage | Host ms | GPU timestamp ms | Wall ms | Canvas format |
|---|---|---|---|---|
| P4 | 0.100 | 0.005 | 3.450 | bgra8unorm |
| P0 | 0.000 | 0.003 | 3.150 | bgra8unorm |
| P1 | 0.100 | 0.004 | 2.950 | bgra8unorm |
| P2 | 0.100 | 0.005 | 4.000 | bgra8unorm |
| P3 | 0.000 | 0.005 | 2.950 | bgra8unorm |

## Submission-count overhead (median wall ms)

| Submissions | Wall ms |
|---|---|
| 1 | 0.100 |
| 2 | 0.100 |
| 4 | 0.100 |
| 6 | 0.150 |
| 8 | 0.200 |

## Upload benchmark (transition per sample, fresh uploader)

hostMs = the uploader.upload() call itself; wallMs = upload + queue completion. writtenSections = sections the uploader transferred (every non-empty section); changedSections = sections whose BYTES differ between the before and after scenes.

| Update type | Host ms | Wall ms | Encoded bytes | Uploaded bytes | writeBuffer calls | New allocations | Written sections | Changed sections |
|---|---|---|---|---|---|---|---|---|
| first | 0.000 | 0.200 | 8640 | 8640 | 3 | 5 | header+surfaces+materials | first-upload-all-sections |
| identical | 0.000 | 0.100 | 8640 | 8640 | 3 | 0 | header+surfaces+materials |  |
| light-only | 0.000 | 0.200 | 8640 | 8640 | 3 | 0 | header+surfaces+materials | header |
| material-values-only | 0.000 | 0.200 | 8640 | 8640 | 3 | 0 | header+surfaces+materials | materials |
| single-surface-geometry | 0.000 | 0.100 | 8640 | 8640 | 3 | 0 | header+surfaces+materials | surfaces |
| mask-change | 0.000 | 0.100 | 2240 | 2240 | 5 | 0 | header+surfaces+masks+maskPixels+materials | maskPixels |

## Partial vs forced-full recompute (median GPU ms)

actualDirtyRatio = planner dirtyTexels / totalTexels (never the input knob). Both sides are measured on the SAME warm retained pipeline with the same base -> target transition: the normal scheduler render vs the benchmark-only debugForceFull render of the SAME target scene (identical resource state). partialToFullRatio = partial GPU / forced-full GPU (< 1 = partial wins). calibration = normal-full GPU / forced-full GPU on the cases where the normal planner ALSO chose full (a systematic gap would mean the comparator is unfair).

| Case | Actual dirty ratio | Partial mode | Forced-full mode | Partial GPU ms | Forced-full GPU ms | P/F ratio | Calibration | Dirty texels | Dispatch texels |
|---|---|---|---|---|---|---|---|---|---|
| move-0.02 | 1.5% | partial | full | 0.033 | 0.086 | 0.389 | n/a | 3358 | 40960 |
| move-0.05 | 1.8% | partial | full | 0.033 | 0.086 | 0.387 | n/a | 4094 | 40960 |
| move-0.1 | 2.3% | partial | full | 0.033 | 0.086 | 0.385 | n/a | 5382 | 40960 |
| move-0.2 | 3.4% | partial | full | 0.033 | 0.086 | 0.384 | n/a | 7912 | 40960 |
| move-0.35 | 5.1% | partial | full | 0.033 | 0.086 | 0.390 | n/a | 11684 | 40960 |
| move-0.55 | 7.2% | partial | full | 0.033 | 0.087 | 0.384 | n/a | 16698 | 40960 |
| move-0.8 | 10.0% | partial | full | 0.033 | 0.086 | 0.385 | n/a | 23000 | 40960 |
| move-1 | 12.2% | partial | full | 0.034 | 0.086 | 0.390 | n/a | 28060 | 40960 |
| grow-1 | 2.3% | partial | full | 0.042 | 0.086 | 0.491 | n/a | 5332 | 81920 |
| grow-2 | 3.4% | full | full | 0.087 | 0.086 | 1.003 | 1.003 | 7812 | 122880 |
| grow-4 | 5.5% | full | full | 0.087 | 0.087 | 1.000 | 1.000 | 12772 | 163840 |
| grow-7 | 7.3% | full | full | 0.087 | 0.087 | 0.996 | 0.996 | 16740 | 204800 |

- comparator verification: all 12 forced-full cases planned mode=full.

- full/full calibration: normal-planner-full vs forced-full GPU medians agree within 0.4% across 3 case(s) (0.9-1.1 would be acceptable; a systematic gap would invalidate the comparator).

## Retained scheduling: transition vs repeated (median wall ms)

transitionWallMs = the real base -> variant update frame; repeatedWallMs = identical variant -> variant retained frames after the transition. Never averaged together. Repeated cost is over the recorded frames count.

| Case | Frames | Transition wall ms | Transition GPU ms | Repeated wall ms | Submissions/frame | Dispatches/frame | Bytes/frame | Transition executed | Expected |
|---|---|---|---|---|---|---|---|---|---|
| no-change | 200 | n/a | n/a | 0.100 | 0.00 | 0.00 | 0 |  |  |
| repaint-only | 200 | n/a | n/a | 0.600 | 1.00 | 0.00 | 0 |  | presentation |
| light-intensity | 200 | 3.900 | 0.014 | 0.100 | 0.00 | 0.00 | 0 | upload,lighting,presentation | upload,lighting,presentation |
| light-direction | 200 | 3.600 | 0.084 | 0.100 | 0.00 | 0.00 | 0 | upload,shadow,reconstruction,lighting,presentation | upload,shadow,reconstruction,lighting,presentation |
| material-values | 200 | 3.150 | 0.014 | 0.100 | 0.00 | 0.00 | 0 | upload,lighting,presentation | upload,lighting,presentation |
| geometry | 200 | 1.500 | 0.120 | 0.100 | 0.00 | 0.00 | 0 | upload,height,normal,shadow,reconstruction,lighting,presentation | upload,height,normal,shadow,reconstruction,lighting,presentation |

## CPU reference stage summary (median host ms)

The CPU oracle chain (composition, mask SDF inside compose, normal, shadow, reconstruction, lighting, compositing) at the benchmark resolution. hostMs only - the CPU backend has no GPU timestamps.

| Stage | Median host ms | Samples |
|---|---|---|
| compose height (incl. mask SDF) | 4.193 | 8 |
| compose caster height | 1.713 | 8 |
| normal | 3.170 | 8 |
| shadow (4 samples) | 91.005 | 8 |
| reconstruction (radius 2) | 11.691 | 8 |
| lighting (shade + RGBA bytes) | 24.162 | 8 |
| compositing (final RGBA synthesis) | 0.242 | 8 |

### CPU resolution scaling (full chain, median host ms)

| Resolution | Median host ms | Texels |
|---|---|---|
| 320x180 | 128.282 | 57600 |
| 640x360 | 611.773 | 230400 |
| 1280x720 | 2508.317 | 921600 |
| 1920x1080 | 5815.649 | 2073600 |

## End-to-end frame cases (median wall ms)

| Case | Wall ms | GPU ms | Executed |
|---|---|---|---|
| cold-first | 11.100 | 0.142 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| warmed-full | 3.450 | 0.119 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| retained | 0.100 | n/a |  |
| repaint | 0.750 | 0.005 | presentation |
| light-intensity | 3.900 | 0.014 | upload,lighting,presentation |
| light-direction | 4.100 | 0.084 | upload,shadow,reconstruction,lighting,presentation |
| material-values | 3.550 | 0.014 | upload,lighting,presentation |
| geometry-move | 3.000 | 0.118 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| partial-geometry | 3.200 | 0.119 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| forced-full | 3.700 | 0.137 | upload,height,normal,shadow,reconstruction,lighting,presentation |

## DOM integration (median per-frame timings)

Every scenario runs warmup + samples frames (never single-shot). callbackHostMs = the Ukibori renderer callbacks inside the harness flush; settleWallMs = the harness observer-delivery wait floor (setTimeout turns, NOT Ukibori work). measurement/scene-build are FRAME-LOCAL: a frame whose serial did not advance reports 0, never a stale previous-frame value. The scroll scenario drives a real window.scrollTo + document scroll listener.

| Scenario | Surfaces | Samples | Wall ms | Callback ms | Settle ms | Meas. ms | Scene-build ms | Rect calls | Style calls | Invocations | Skipped |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stable-page | 1 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 1 | 20 | 10.400 | 1.100 | 9.050 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 1 | 20 | 9.950 | 0.200 | 9.650 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 1 | 20 | 9.850 | 0.000 | 9.800 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| frequent-mutations | 1 | 20 | 9.300 | 0.000 | 9.300 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| scroll | 1 | 20 | 9.100 | 0.000 | 8.900 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| stable-page | 10 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 10 | 20 | 11.150 | 1.050 | 10.050 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 10 | 20 | 10.400 | 0.700 | 9.500 | 0.100 | 0.000 | 12 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 10 | 20 | 30.900 | 0.100 | 30.650 | 0.100 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| frequent-mutations | 10 | 20 | 30.850 | 0.100 | 30.700 | 0.100 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| scroll | 10 | 20 | 15.800 | 0.100 | 15.500 | 0.100 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| stable-page | 50 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 50 | 20 | 11.150 | 0.900 | 10.200 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 50 | 20 | 11.100 | 1.100 | 9.900 | 0.200 | 0.000 | 52 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 50 | 20 | 31.050 | 0.300 | 30.600 | 0.300 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| frequent-mutations | 50 | 20 | 30.900 | 0.300 | 30.600 | 0.300 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| scroll | 50 | 20 | 15.650 | 0.200 | 15.350 | 0.150 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| stable-page | 100 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 100 | 20 | 11.100 | 1.150 | 9.950 | 0.000 | 0.050 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 100 | 20 | 14.000 | 1.800 | 11.950 | 0.500 | 0.000 | 102 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 100 | 20 | 30.800 | 0.500 | 30.250 | 0.500 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| frequent-mutations | 100 | 20 | 31.000 | 0.500 | 30.400 | 0.500 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| scroll | 100 | 20 | 16.050 | 0.400 | 15.400 | 0.400 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| stable-page | 250 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 250 | 20 | 15.500 | 1.500 | 13.650 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 250 | 20 | 14.500 | 2.200 | 12.150 | 0.900 | 0.000 | 252 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 250 | 20 | 30.700 | 1.000 | 29.700 | 0.900 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| frequent-mutations | 250 | 20 | 30.700 | 0.900 | 29.700 | 0.900 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| scroll | 250 | 20 | 16.000 | 0.800 | 15.100 | 0.800 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| stable-page | 500 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 500 | 20 | 14.800 | 1.800 | 13.050 | 0.000 | 0.100 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 500 | 20 | 17.350 | 3.250 | 13.850 | 1.600 | 0.050 | 502 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 500 | 20 | 30.800 | 1.900 | 28.750 | 1.800 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| frequent-mutations | 500 | 20 | 30.700 | 1.900 | 28.800 | 1.900 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| scroll | 500 | 20 | 17.800 | 1.500 | 16.300 | 1.500 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| stable-page | 1000 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 1000 | 20 | 18.400 | 3.200 | 14.900 | 0.000 | 0.100 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 1000 | 20 | 21.750 | 5.950 | 14.300 | 3.000 | 0.100 | 1002 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 1000 | 20 | 30.700 | 3.200 | 27.500 | 3.200 | 0.000 | 1000 | 0 | 0.00 | 1.00 |
| frequent-mutations | 1000 | 20 | 30.700 | 3.500 | 27.200 | 3.500 | 0.000 | 1000 | 0 | 0.00 | 1.00 |
| scroll | 1000 | 20 | 30.350 | 2.900 | 27.250 | 2.900 | 0.000 | 1000 | 0 | 0.00 | 1.00 |

## Bottleneck matrix

| Workload | Main bottleneck | Secondary | Scaling factor | Evidence |
|---|---|---|---|---|
| simple 640x360 | shadow | - | pixels | 0.078ms GPU shadow |
| many surfaces | height | - | pixels x surfaces | 3.041ms height / 3.095ms frame (1000 surfaces) |
| many masks | height (mask SDF) | - | mask cells | 777.994ms frame at mask res 256 (1065024 cells) |
| soft shadow | shadow | - | pixels x samples x march | 1.806ms shadow at 16 samples (18.0x vs 1 sample) |
| high DPR + reconstruction | reconstruction | - | DPR^2 + radiusTexels^2 | 6.738ms recon / 6.931ms frame at DPR 4 radius 4 |
| DOM-heavy | measurement | skipped render | registered surfaces | 1000 getBoundingClientRect at 1000 surfaces |

## Follow-up optimization candidates

1. **ReconstructionPass is 59.2% of the frame at DPR 1 radius 2** - 0.021ms of 0.034ms. Candidate: shared-memory / separable reconstruction (currently (2r+1)^2 neighborhood).
2. **Mask SDF generation costs 777.994ms at mask resolution 256** - 1065024 padded mask cells. Candidate: mask SDF algorithm / caching (unchanged masks recomputed on geometry updates).
3. **Unchanged masks re-run the mask-SDF pass on an unrelated geometry update** - executed=[upload,height,normal,shadow,reconstruction,lighting,presentation] maskSdfPasses=1 height GPU=0.488ms. Candidate: GPU mask-SDF cache keyed by mask contents (benchmark-flagged; separate optimization issue).
4. **Soft shadow at 16 samples costs 18.0x the 1-sample hard path (1.806ms)** - samples {1,4,8,16} ->0.101/1.806ms shadow. Candidate: shadow marcher acceleration / hierarchical ray skipping.
5. **Full frame issues 6 queue.submit calls** - submission-count benchmark (1..8 empty submissions are sub-ms each). Candidate: single-command-buffer renderer redesign (baseline recorded).

## Notes

- hostMs = host encode/upload/dispatch wall time; gpuTimestampMs = real GPU timestamp-query duration (unsupported adapters report n/a, never fabricated zeros); wallMs = render + `queue.onSubmittedWorkDone()` completion.
- Values are median over the warmed samples; p95/min/max live in the JSON documents.
- Absolute timings are hardware-specific; only compare runs on the same machine/runner.
