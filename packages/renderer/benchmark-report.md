# Ukibori benchmark report (#46)

- schemaVersion: 1
- commit: 185d71ec87a2fb370eca5e0da1e735ec08b2d6c4
- workingTreeDirty: false
- generatedAt: 2026-09-05T23:30:43.089Z
- stage run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query true
- stage run: Windows_NT 10.0.26200 / AMD Ryzen 7 7700 8-Core Processor               / backend unknown / timestamp-query unknown
- dom run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query unknown

## Stage summary (median GPU ms, stage suite)

| Stage | Median GPU ms | Frame share |
|---|---|---|
| upload | n/a | n/a |
| height | 0.025 | 7.9% |
| normal | 0.004 | 1.3% |
| shadow | 0.256 | 79.7% |
| reconstruction | 0.023 | 7.1% |
| lighting | 0.009 | 2.8% |
| presentation | 0.004 | 1.2% |
| total | 0.321 | 100.0% |

## Resolution scaling (median GPU ms, full frame)

| Resolution | GPU ms | host ms | texels |
|---|---|---|---|
| 320 | 0.039 | 0.350 | 57600 |
| 640 | 0.084 | 0.300 | 230400 |
| 1280 | 0.226 | 0.300 | 921600 |
| 1920 | 0.506 | 0.250 | 2073600 |

## Surface-count scaling (median GPU ms)

| Surfaces | Frame GPU ms | Height GPU ms | Encoded bytes |
|---|---|---|---|
| 1 | 0.058 | 0.022 | 512 |
| 4 | 0.077 | 0.031 | 960 |
| 16 | 0.110 | 0.059 | 2496 |
| 64 | 0.232 | 0.178 | 8640 |
| 128 | 0.389 | 0.335 | 16832 |
| 256 | 0.743 | 0.689 | 33216 |
| 512 | 1.404 | 1.351 | 65984 |
| 1000 | 3.233 | 3.179 | 128448 |

## Mask-resolution scaling (16 masks, median GPU ms)

| Mask resolution | Frame GPU ms | Wall ms | Padded cells |
|---|---|---|---|
| 16 | 0.218 | 3.100 | 5184 |
| 32 | 0.568 | 1.500 | 18496 |
| 64 | 3.719 | 6.200 | 69696 |
| 128 | 53.561 | 55.600 | 270400 |
| 256 | 780.606 | 784.500 | 1065024 |

## Mask-count scaling (32x32 masks, median GPU ms)

| Masks | Frame GPU ms | Height GPU ms | Mask SDF passes | Compose passes | Padded cells | Uploaded bytes |
|---|---|---|---|---|---|---|
| 0 | 0.044 | 0.019 | 0 | 5 | 0 | 320 |
| 1 | 0.463 | 0.428 | 1 | 5 | 1156 | 1568 |
| 16 | 0.568 | 0.526 | 1 | 5 | 18496 | 19328 |
| 64 | 1.254 | 1.210 | 1 | 5 | 73984 | 76160 |

- unchanged mask + unrelated geometry update (this frame): executed=[upload,height,normal,shadow,reconstruction,lighting,presentation], planning=partial (band 192..359 coverage 0.467), maskSdfPasses=1, composePasses=5, totalMaskCells=18496, height GPU=0.488ms, maskSDF GPU=0.472ms, compose GPU=0.057ms, wall=2.700ms (samples=20)

## Shadow sample scaling (median ShadowPass GPU ms)

| Samples | Angular radius | Soft | Shadow GPU ms | March steps |
|---|---|---|---|---|
| 1 | 0 | no | 0.042 | 400 |
| 4 | 0 | no | 0.042 | 400 |
| 8 | 0 | no | 0.043 | 400 |
| 16 | 0 | no | 0.043 | 400 |
| 1 | 0.05 | no | 0.043 | 400 |
| 4 | 0.05 | yes | 0.159 | 400 |
| 8 | 0.05 | yes | 0.315 | 400 |
| 16 | 0.05 | yes | 0.622 | 400 |
| 1 | 0.15 | no | 0.043 | 400 |
| 4 | 0.15 | yes | 0.175 | 400 |
| 8 | 0.15 | yes | 0.345 | 400 |
| 16 | 0.15 | yes | 0.686 | 400 |
| 1 | 0.3 | no | 0.043 | 400 |
| 4 | 0.3 | yes | 0.207 | 400 |
| 8 | 0.3 | yes | 0.413 | 400 |
| 16 | 0.3 | yes | 0.815 | 400 |

## Shadow travel distance (median ShadowPass GPU ms)

The travel axis is the CONFIGURED march budget (the sanitized maxDistance the pass packs): short 40 / medium 120 / long 300 scene units at stepSize 0.5. The dispatch step counts differ by construction; the MEASURED GPU cost can saturate when scene bounds / early exits bound the effective ray travel (configured budget != executed work).

| Travel | Shadow samples | maxDistance | stepSize | Theoretical max steps | Shadow GPU ms | Dispatch step count |
|---|---|---|---|---|---|---|
| short | 8 | 40 | 0.5 | 80 | 0.282 | 80 |
| medium | 8 | 120 | 0.5 | 240 | 0.343 | 240 |
| long | 8 | 300 | 0.5 | 600 | 0.349 | 600 |

## Reconstruction radius x DPR (median GPU ms)

| Radius | DPR | Active | Taps/texel | Recon GPU ms | Frame GPU ms | Recon share |
|---|---|---|---|---|---|---|
| 0 | 1 | false | 0 | 0.000 | 0.013 | 0.0% |
| 1 | 1 | true | 9 | 0.012 | 0.026 | 45.5% |
| 2 | 1 | true | 25 | 0.023 | 0.036 | 61.8% |
| 4 | 1 | true | 81 | 0.056 | 0.070 | 81.0% |
| 0 | 1.5 | false | 0 | 0.000 | 0.020 | 0.0% |
| 1 | 1.5 | true | 25 | 0.040 | 0.060 | 68.3% |
| 2 | 1.5 | true | 49 | 0.067 | 0.087 | 76.8% |
| 4 | 1.5 | true | 169 | 0.195 | 0.215 | 91.2% |
| 0 | 2 | false | 0 | 0.000 | 0.032 | 0.0% |
| 1 | 2 | true | 25 | 0.069 | 0.102 | 64.6% |
| 2 | 2 | true | 81 | 0.174 | 0.204 | 86.1% |
| 4 | 2 | true | 289 | 0.551 | 0.582 | 94.7% |
| 0 | 3 | false | 0 | 0.000 | 0.097 | 0.0% |
| 1 | 3 | true | 49 | 0.244 | 0.333 | 73.8% |
| 2 | 3 | true | 169 | 0.713 | 0.802 | 89.0% |
| 4 | 3 | true | 625 | 2.799 | 2.889 | 96.9% |
| 0 | 4 | false | 0 | 0.000 | 0.187 | 0.0% |
| 1 | 4 | true | 81 | 0.646 | 0.832 | 77.9% |
| 2 | 4 | true | 289 | 2.434 | 2.626 | 92.7% |
| 4 | 4 | true | 1089 | 8.351 | 8.547 | 97.6% |

## Presentation microbenchmark

P0-P3 wall = submission + queue completion; GPU timestamp = the render pass itself (null on adapters without timestamp-query). P4 wall = production pipeline.present(); P4 GPU timestamp = the presentation stage of a production repaint render. Wall cost alone must never be read as shader cost.

| Stage | Host ms | GPU timestamp ms | Wall ms | Canvas format |
|---|---|---|---|---|
| P4 | 0.100 | 0.005 | 4.000 | bgra8unorm |
| P0 | 0.100 | 0.004 | 4.050 | bgra8unorm |
| P1 | 0.100 | 0.005 | 3.150 | bgra8unorm |
| P2 | 0.000 | 0.005 | 4.450 | bgra8unorm |
| P3 | 0.100 | 0.005 | 3.650 | bgra8unorm |

## Submission-count overhead (median wall ms)

| Submissions | Wall ms |
|---|---|
| 1 | 0.100 |
| 2 | 0.100 |
| 4 | 0.200 |
| 6 | 0.200 |
| 8 | 0.200 |

## Upload benchmark (transition per sample, fresh uploader)

hostMs = the uploader.upload() call itself; wallMs = upload + queue completion. writtenSections = sections the uploader transferred (every non-empty section); changedSections = sections whose BYTES differ between the before and after scenes.

| Update type | Host ms | Wall ms | Encoded bytes | Uploaded bytes | writeBuffer calls | New allocations | Written sections | Changed sections |
|---|---|---|---|---|---|---|---|---|
| first | 0.000 | 0.200 | 8640 | 8640 | 3 | 5 | header+surfaces+materials | first-upload-all-sections |
| identical | 0.000 | 0.100 | 8640 | 8640 | 3 | 0 | header+surfaces+materials |  |
| light-only | 0.000 | 0.100 | 8640 | 8640 | 3 | 0 | header+surfaces+materials | header |
| material-values-only | 0.000 | 0.200 | 8640 | 8640 | 3 | 0 | header+surfaces+materials | materials |
| single-surface-geometry | 0.000 | 0.200 | 8640 | 8640 | 3 | 0 | header+surfaces+materials | surfaces |
| mask-change | 0.000 | 0.200 | 2240 | 2240 | 5 | 0 | header+surfaces+masks+maskPixels+materials | maskPixels |

## Partial vs forced-full recompute (median GPU ms)

actualDirtyRatio = planner dirtyTexels / totalTexels (never the input knob). Both sides are measured on the SAME warm retained pipeline with the same base -> target transition: the normal scheduler render vs the benchmark-only debugForceFull render of the SAME target scene (identical resource state). partialToFullRatio = partial GPU / forced-full GPU (< 1 = partial wins). calibration = normal-full GPU / forced-full GPU on the cases where the normal planner ALSO chose full (a systematic gap would mean the comparator is unfair).

| Case | Actual dirty ratio | Partial mode | Forced-full mode | Partial GPU ms | Forced-full GPU ms | P/F ratio | Calibration | Dirty texels | Dispatch texels |
|---|---|---|---|---|---|---|---|---|---|
| move-0.02 | 1.5% | partial | full | 0.034 | 0.084 | 0.401 | n/a | 3358 | 40960 |
| move-0.05 | 1.8% | partial | full | 0.034 | 0.084 | 0.405 | n/a | 4094 | 40960 |
| move-0.1 | 2.3% | partial | full | 0.033 | 0.083 | 0.400 | n/a | 5382 | 40960 |
| move-0.2 | 3.4% | partial | full | 0.033 | 0.083 | 0.401 | n/a | 7912 | 40960 |
| move-0.35 | 5.1% | partial | full | 0.033 | 0.083 | 0.396 | n/a | 11684 | 40960 |
| move-0.55 | 7.2% | partial | full | 0.034 | 0.083 | 0.406 | n/a | 16698 | 40960 |
| move-0.8 | 10.0% | partial | full | 0.034 | 0.085 | 0.398 | n/a | 23000 | 40960 |
| move-1 | 12.2% | partial | full | 0.034 | 0.085 | 0.398 | n/a | 28060 | 40960 |
| grow-1 | 2.3% | partial | full | 0.043 | 0.084 | 0.518 | n/a | 5332 | 81920 |
| grow-2 | 3.4% | full | full | 0.084 | 0.084 | 0.998 | 0.998 | 7812 | 122880 |
| grow-4 | 5.5% | full | full | 0.085 | 0.085 | 1.000 | 1.000 | 12772 | 163840 |
| grow-7 | 7.3% | full | full | 0.085 | 0.084 | 1.002 | 1.002 | 16740 | 204800 |

- comparator verification: all 12 forced-full cases planned mode=full.

- full/full calibration: normal-planner-full vs forced-full GPU medians agree within 0.2% across 3 case(s) (0.9-1.1 would be acceptable; a systematic gap would invalidate the comparator).

## Retained scheduling: transition vs repeated (median wall ms)

transitionWallMs = the real base -> variant update frame; repeatedWallMs = identical variant -> variant retained frames after the transition. Never averaged together. Repeated cost is over the recorded frames count.

| Case | Frames | Transition wall ms | Transition GPU ms | Repeated wall ms | Submissions/frame | Dispatches/frame | Bytes/frame | Transition executed | Expected |
|---|---|---|---|---|---|---|---|---|---|
| no-change | 200 | n/a | n/a | 0.100 | 0.00 | 0.00 | 0 |  |  |
| repaint-only | 200 | n/a | n/a | 0.600 | 1.00 | 0.00 | 0 |  | presentation |
| light-intensity | 200 | 1.850 | 0.014 | 0.100 | 0.00 | 0.00 | 0 | upload,lighting,presentation | upload,lighting,presentation |
| light-direction | 200 | 0.950 | 0.054 | 0.100 | 0.00 | 0.00 | 0 | upload,shadow,reconstruction,lighting,presentation | upload,shadow,reconstruction,lighting,presentation |
| material-values | 200 | 0.950 | 0.013 | 0.100 | 0.00 | 0.00 | 0 | upload,lighting,presentation | upload,lighting,presentation |
| geometry | 200 | 3.600 | 0.084 | 0.100 | 0.00 | 0.00 | 0 | upload,height,normal,shadow,reconstruction,lighting,presentation | upload,height,normal,shadow,reconstruction,lighting,presentation |

## CPU reference stage summary (median host ms)

The CPU oracle chain (composition, mask SDF inside compose, normal, shadow, reconstruction, lighting, compositing) at the benchmark resolution. hostMs only - the CPU backend has no GPU timestamps.

| Stage | Median host ms | Samples |
|---|---|---|
| compose height (incl. mask SDF) | 3.587 | 8 |
| compose caster height | 1.723 | 8 |
| normal | 3.074 | 8 |
| shadow (4 samples) | 89.041 | 8 |
| reconstruction (radius 2) | 33.796 | 8 |
| lighting (shade + RGBA bytes) | 24.035 | 8 |
| compositing (final RGBA synthesis) | 0.241 | 8 |

### CPU resolution scaling (full chain, median host ms)

| Resolution | Median host ms | Texels |
|---|---|---|
| 320x180 | 137.506 | 57600 |
| 640x360 | 758.628 | 230400 |
| 1280x720 | 3130.987 | 921600 |
| 1920x1080 | 7010.652 | 2073600 |

## End-to-end frame cases (median wall ms)

| Case | Wall ms | GPU ms | Executed |
|---|---|---|---|
| cold-first | 5.900 | 0.107 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| warmed-full | 3.400 | 0.086 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| retained | 0.100 | n/a |  |
| repaint | 3.400 | 0.006 | presentation |
| light-intensity | 3.700 | 0.014 | upload,lighting,presentation |
| light-direction | 4.100 | 0.054 | upload,shadow,reconstruction,lighting,presentation |
| material-values | 3.800 | 0.014 | upload,lighting,presentation |
| geometry-move | 4.550 | 0.084 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| partial-geometry | 3.650 | 0.089 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| forced-full | 4.900 | 0.117 | upload,height,normal,shadow,reconstruction,lighting,presentation |

## DOM integration (median per-frame timings)

Every scenario runs warmup + samples frames (never single-shot). callbackHostMs = the Ukibori renderer callbacks inside the harness flush; settleWallMs = the harness observer-delivery wait floor (setTimeout turns, NOT Ukibori work). measurement/scene-build are FRAME-LOCAL: a frame whose serial did not advance reports 0, never a stale previous-frame value. The scroll scenario drives a real window.scrollTo + document scroll listener.

| Scenario | Surfaces | Samples | Wall ms | Callback ms | Settle ms | Meas. ms | Scene-build ms | Rect calls | Style calls | Invocations | Skipped |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stable-page | 1 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 1 | 20 | 11.000 | 1.000 | 9.800 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 1 | 20 | 9.950 | 0.300 | 9.500 | 0.100 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 1 | 20 | 9.750 | 0.000 | 9.650 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| frequent-mutations | 1 | 20 | 9.500 | 0.100 | 9.400 | 0.100 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| scroll | 1 | 20 | 9.600 | 0.000 | 9.450 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| stable-page | 10 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 10 | 20 | 10.000 | 0.900 | 9.050 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 10 | 20 | 10.000 | 0.700 | 9.300 | 0.050 | 0.000 | 12 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 10 | 20 | 9.450 | 0.100 | 9.250 | 0.100 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| frequent-mutations | 10 | 20 | 9.500 | 0.100 | 9.500 | 0.100 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| scroll | 10 | 20 | 9.650 | 0.100 | 9.550 | 0.100 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| stable-page | 50 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 50 | 20 | 10.100 | 0.900 | 9.200 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 50 | 20 | 11.050 | 1.000 | 10.050 | 0.200 | 0.000 | 52 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 50 | 20 | 9.450 | 0.200 | 9.300 | 0.200 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| frequent-mutations | 50 | 20 | 9.750 | 0.250 | 9.550 | 0.200 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| scroll | 50 | 20 | 9.500 | 0.200 | 9.250 | 0.200 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| stable-page | 100 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 100 | 20 | 10.300 | 1.100 | 9.150 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 100 | 20 | 11.000 | 1.400 | 9.500 | 0.350 | 0.000 | 102 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 100 | 20 | 9.600 | 0.400 | 9.150 | 0.400 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| frequent-mutations | 100 | 20 | 9.550 | 0.400 | 9.250 | 0.400 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| scroll | 100 | 20 | 9.350 | 0.350 | 8.950 | 0.350 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| stable-page | 250 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 250 | 20 | 11.050 | 1.550 | 9.400 | 0.000 | 0.100 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 250 | 20 | 11.600 | 1.950 | 9.700 | 0.800 | 0.000 | 252 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 250 | 20 | 10.300 | 0.800 | 9.450 | 0.800 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| frequent-mutations | 250 | 20 | 10.950 | 0.800 | 10.050 | 0.800 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| scroll | 250 | 20 | 10.400 | 0.850 | 9.550 | 0.800 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| stable-page | 500 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 500 | 20 | 11.450 | 1.800 | 9.750 | 0.000 | 0.100 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 500 | 20 | 12.450 | 3.100 | 9.450 | 1.350 | 0.000 | 502 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 500 | 20 | 10.850 | 1.500 | 9.400 | 1.500 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| frequent-mutations | 500 | 20 | 11.350 | 1.650 | 9.550 | 1.650 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| scroll | 500 | 20 | 11.500 | 1.550 | 9.750 | 1.550 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| stable-page | 1000 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 1000 | 20 | 12.300 | 2.650 | 9.150 | 0.000 | 0.100 | 3 | 3 | 1.00 | 0.00 |
| surface-style-mutation | 1000 | 20 | 15.800 | 6.050 | 9.650 | 3.200 | 0.100 | 1002 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 1000 | 20 | 12.650 | 3.250 | 9.400 | 3.250 | 0.000 | 1000 | 0 | 0.00 | 1.00 |
| frequent-mutations | 1000 | 20 | 12.350 | 2.800 | 9.300 | 2.800 | 0.000 | 1000 | 0 | 0.00 | 1.00 |
| scroll | 1000 | 20 | 12.550 | 3.300 | 9.250 | 3.300 | 0.000 | 1000 | 0 | 0.00 | 1.00 |

## Bottleneck matrix

| Workload | Main bottleneck | Secondary | Scaling factor | Evidence |
|---|---|---|---|---|
| simple 640x360 | shadow | - | pixels | 0.038ms GPU shadow |
| many surfaces | height | - | pixels x surfaces | 3.179ms height / 3.233ms frame (1000 surfaces) |
| many masks | height (mask SDF) | - | mask cells | 780.606ms frame at mask res 256 (1065024 cells) |
| soft shadow | shadow | - | pixels x samples x march | 0.686ms shadow at 16 samples (16.1x vs 1 sample) |
| high DPR + reconstruction | reconstruction | - | DPR^2 + radiusTexels^2 | 8.351ms recon / 8.547ms frame at DPR 4 radius 4 |
| DOM-heavy | measurement | skipped render | registered surfaces | 1000 getBoundingClientRect at 1000 surfaces |

## Follow-up optimization candidates

1. **ReconstructionPass is 61.8% of the frame at DPR 1 radius 2** - 0.023ms of 0.036ms. Candidate: shared-memory / separable reconstruction (currently (2r+1)^2 neighborhood).
2. **Mask SDF generation costs 780.606ms at mask resolution 256** - 1065024 padded mask cells. Candidate: mask SDF algorithm / caching (unchanged masks recomputed on geometry updates).
3. **Unchanged masks re-run the mask-SDF pass on an unrelated geometry update** - executed=[upload,height,normal,shadow,reconstruction,lighting,presentation] maskSdfPasses=1 height GPU=0.488ms. Candidate: GPU mask-SDF cache keyed by mask contents (benchmark-flagged; separate optimization issue).
4. **Soft shadow at 16 samples costs 16.1x the 1-sample hard path (0.686ms)** - samples {1,4,8,16} ->0.043/0.686ms shadow. Candidate: shadow marcher acceleration / hierarchical ray skipping.
5. **Full frame issues 6 queue.submit calls** - submission-count benchmark (1..8 empty submissions are sub-ms each). Candidate: single-command-buffer renderer redesign (baseline recorded).

## Notes

- hostMs = host encode/upload/dispatch wall time; gpuTimestampMs = real GPU timestamp-query duration (unsupported adapters report n/a, never fabricated zeros); wallMs = render + `queue.onSubmittedWorkDone()` completion.
- Values are median over the warmed samples; p95/min/max live in the JSON documents.
- Absolute timings are hardware-specific; only compare runs on the same machine/runner.
