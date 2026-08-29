# Ukibori benchmark report (#46)

- schemaVersion: 1
- commit: 5555d3352949ee37e987be154d476d0aa5277c8c
- workingTreeDirty: false
- generatedAt: 2026-08-29T07:49:54.168Z
- stage run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query true
- stage run: Windows_NT 10.0.26200 / AMD Ryzen 7 7700 8-Core Processor               / backend unknown / timestamp-query unknown
- dom run: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36 / unknown / backend unknown / timestamp-query unknown

## Stage summary (median GPU ms, stage suite)

| Stage | Median GPU ms | Frame share |
|---|---|---|
| upload | n/a | n/a |
| height | 0.025 | 5.6% |
| normal | 0.004 | 0.9% |
| shadow | 0.390 | 85.8% |
| reconstruction | 0.020 | 4.5% |
| lighting | 0.009 | 1.9% |
| presentation | 0.006 | 1.2% |
| total | 0.454 | 100.0% |

## Resolution scaling (median GPU ms, full frame)

| Resolution | GPU ms | host ms | texels |
|---|---|---|---|
| 320 | 0.048 | 0.300 | 57600 |
| 640 | 0.118 | 0.300 | 230400 |
| 1280 | 0.364 | 0.400 | 921600 |
| 1920 | 0.810 | 0.300 | 2073600 |

## Surface-count scaling (median GPU ms)

| Surfaces | Frame GPU ms | Height GPU ms | Encoded bytes |
|---|---|---|---|
| 1 | 0.058 | 0.022 | 512 |
| 4 | 0.077 | 0.031 | 960 |
| 16 | 0.112 | 0.058 | 2496 |
| 64 | 0.232 | 0.178 | 8640 |
| 128 | 0.389 | 0.335 | 16832 |
| 256 | 0.715 | 0.660 | 33216 |
| 512 | 1.345 | 1.291 | 65984 |
| 1000 | 3.099 | 3.044 | 128448 |

## Mask-resolution scaling (16 masks, median GPU ms)

| Mask resolution | Frame GPU ms | Wall ms | Padded cells |
|---|---|---|---|
| 16 | 0.215 | 3.600 | 5184 |
| 32 | 0.565 | 3.400 | 18496 |
| 64 | 3.851 | 5.900 | 69696 |
| 128 | 52.192 | 55.000 | 270400 |
| 256 | 776.150 | 779.100 | 1065024 |

- unchanged mask + unrelated geometry update (this frame): executed=[upload,height,normal,shadow,reconstruction,lighting,presentation], planning=partial (band 192..359 coverage 0.467), maskSdfPasses=1, composePasses=5, totalMaskCells=18496, height GPU=0.488ms, maskSDF GPU=0.481ms, compose GPU=0.057ms, wall=3.700ms (samples=20)

## Shadow sample scaling (median ShadowPass GPU ms)

| Samples | Angular radius | Soft | Shadow GPU ms | March steps |
|---|---|---|---|---|
| 1 | 0 | no | 0.101 | 400 |
| 4 | 0 | no | 0.100 | 400 |
| 8 | 0 | no | 0.101 | 400 |
| 16 | 0 | no | 0.101 | 400 |
| 1 | 0.05 | no | 0.101 | 400 |
| 4 | 0.05 | yes | 0.407 | 400 |
| 8 | 0.05 | yes | 0.809 | 400 |
| 16 | 0.05 | yes | 1.608 | 400 |
| 1 | 0.15 | no | 0.101 | 400 |
| 4 | 0.15 | yes | 0.459 | 400 |
| 8 | 0.15 | yes | 0.911 | 400 |
| 16 | 0.15 | yes | 1.808 | 400 |
| 1 | 0.3 | no | 0.101 | 400 |
| 4 | 0.3 | yes | 0.565 | 400 |
| 8 | 0.3 | yes | 1.126 | 400 |
| 16 | 0.3 | yes | 2.239 | 400 |

## Shadow travel distance (median ShadowPass GPU ms)

The travel axis is the EXPLICIT maxDistance (the ray-march budget): short 40 / medium 120 / long 300 scene units at stepSize 0.5, so the cases are genuinely different workloads.

| Travel | maxDistance | stepSize | Theoretical max steps | Shadow GPU ms | Dispatch step count |
|---|---|---|---|---|---|
| short | 40 | 0.5 | 80 | 0.732 | 80 |
| medium | 120 | 0.5 | 240 | 0.910 | 240 |
| long | 300 | 0.5 | 600 | 0.910 | 600 |

## Reconstruction radius x DPR (median GPU ms)

| Radius | DPR | Active | Taps/texel | Recon GPU ms | Frame GPU ms | Recon share |
|---|---|---|---|---|---|---|
| 0 | 1 | false | 0 | 0.000 | 0.014 | 0.0% |
| 1 | 1 | true | 9 | 0.012 | 0.026 | 44.6% |
| 2 | 1 | true | 25 | 0.021 | 0.035 | 63.7% |
| 4 | 1 | true | 81 | 0.048 | 0.062 | 78.5% |
| 0 | 1.5 | false | 0 | 0.000 | 0.020 | 0.0% |
| 1 | 1.5 | true | 25 | 0.037 | 0.057 | 64.5% |
| 2 | 1.5 | true | 49 | 0.059 | 0.080 | 74.7% |
| 4 | 1.5 | true | 169 | 0.165 | 0.185 | 88.9% |
| 0 | 2 | false | 0 | 0.000 | 0.031 | 0.0% |
| 1 | 2 | true | 25 | 0.062 | 0.092 | 66.2% |
| 2 | 2 | true | 81 | 0.149 | 0.181 | 82.6% |
| 4 | 2 | true | 289 | 0.464 | 0.495 | 94.0% |
| 0 | 3 | false | 0 | 0.000 | 0.176 | 0.0% |
| 1 | 3 | true | 49 | 0.219 | 0.307 | 82.1% |
| 2 | 3 | true | 169 | 0.607 | 0.694 | 87.4% |
| 4 | 3 | true | 625 | 2.073 | 2.163 | 95.9% |
| 0 | 4 | false | 0 | 0.000 | 0.187 | 0.0% |
| 1 | 4 | true | 81 | 0.568 | 0.754 | 75.5% |
| 2 | 4 | true | 289 | 1.774 | 1.961 | 91.1% |
| 4 | 4 | true | 1089 | 6.784 | 6.992 | 97.5% |

## Presentation microbenchmark

P0-P3 wall = submission + queue completion; GPU timestamp = the render pass itself (null on adapters without timestamp-query). P4 wall = production pipeline.present(); P4 GPU timestamp = the presentation stage of a production repaint render. Wall cost alone must never be read as shader cost.

| Stage | Host ms | GPU timestamp ms | Wall ms | Canvas format |
|---|---|---|---|---|
| P4 | 0.100 | 0.005 | 3.850 | bgra8unorm |
| P0 | 0.000 | 0.003 | 4.650 | bgra8unorm |
| P1 | 0.000 | 0.004 | 2.950 | bgra8unorm |
| P2 | 0.100 | 0.005 | 2.850 | bgra8unorm |
| P3 | 0.100 | 0.005 | 3.100 | bgra8unorm |

## Submission-count overhead (median wall ms)

| Submissions | Wall ms |
|---|---|
| 1 | 0.100 |
| 2 | 0.100 |
| 4 | 0.100 |
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
| single-surface-geometry | 0.000 | 0.100 | 8640 | 8640 | 3 | 0 | header+surfaces+materials | surfaces |
| mask-change | 0.000 | 0.100 | 2240 | 2240 | 5 | 0 | header+surfaces+masks+maskPixels+materials | maskPixels |

## Partial vs forced-full recompute (median GPU ms)

actualDirtyRatio = planner dirtyTexels / totalTexels (never the input knob). The full comparator is the SAME target scene rendered as the FIRST frame on a fresh pipeline (first-frame contract: fullPlanningMode must be 'full'); partialToFullRatio = partial GPU / forced-full GPU (< 1 = partial wins).

| Case | Actual dirty ratio | Partial mode | Full mode | Partial GPU ms | Full GPU ms | P/F ratio | Dirty texels | Dispatch texels |
|---|---|---|---|---|---|---|---|---|
| move-0.02 | 1.5% | partial | full | 0.033 | 0.103 | 0.325 | 3358 | 40960 |
| move-0.05 | 1.8% | partial | full | 0.033 | 0.103 | 0.324 | 4094 | 40960 |
| move-0.1 | 2.3% | partial | full | 0.033 | 0.103 | 0.322 | 5382 | 40960 |
| move-0.2 | 3.4% | partial | full | 0.033 | 0.103 | 0.324 | 7912 | 40960 |
| move-0.35 | 5.1% | partial | full | 0.033 | 0.103 | 0.319 | 11684 | 40960 |
| move-0.55 | 7.2% | partial | full | 0.033 | 0.103 | 0.324 | 16698 | 40960 |
| move-0.8 | 10.0% | partial | full | 0.033 | 0.103 | 0.322 | 23000 | 40960 |
| move-1 | 12.2% | partial | full | 0.033 | 0.103 | 0.325 | 28060 | 40960 |
| grow-1 | 2.3% | partial | full | 0.042 | 0.103 | 0.412 | 5332 | 81920 |
| grow-2 | 3.4% | full | full | 0.086 | 0.103 | 0.835 | 7812 | 122880 |
| grow-4 | 5.5% | full | full | 0.087 | 0.104 | 0.836 | 12772 | 163840 |
| grow-7 | 7.3% | full | full | 0.087 | 0.104 | 0.841 | 16740 | 204800 |

- comparator verification: all 12 forced-full cases planned mode=full.

## Retained scheduling: transition vs repeated (median wall ms)

transitionWallMs = the real base -> variant update frame; repeatedWallMs = identical variant -> variant retained frames after the transition. Never averaged together. Repeated cost is over the recorded frames count.

| Case | Frames | Transition wall ms | Transition GPU ms | Repeated wall ms | Submissions/frame | Dispatches/frame | Bytes/frame | Transition executed | Expected |
|---|---|---|---|---|---|---|---|---|---|
| no-change | 200 | n/a | n/a | 0.100 | 0.00 | 0.00 | 0 |  |  |
| repaint-only | 200 | n/a | n/a | 0.600 | 1.00 | 0.00 | 0 |  | presentation |
| light-intensity | 200 | 2.700 | 0.014 | 0.100 | 0.00 | 0.00 | 0 | upload,lighting,presentation | upload,lighting,presentation |
| light-direction | 200 | 0.850 | 0.084 | 0.100 | 0.00 | 0.00 | 0 | upload,shadow,reconstruction,lighting,presentation | upload,shadow,reconstruction,lighting,presentation |
| material-values | 200 | 3.200 | 0.016 | 0.100 | 0.00 | 0.00 | 0 | upload,lighting,presentation | upload,lighting,presentation |
| geometry | 200 | 4.500 | 0.120 | 0.100 | 0.00 | 0.00 | 0 | upload,height,normal,shadow,reconstruction,lighting,presentation | upload,height,normal,shadow,reconstruction,lighting,presentation |

## End-to-end frame cases (median wall ms)

| Case | Wall ms | GPU ms | Executed |
|---|---|---|---|
| cold-first | 7.400 | 0.138 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| warmed-full | 2.900 | 0.119 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| retained | 0.100 | n/a |  |
| repaint | 2.050 | 0.005 | presentation |
| light-intensity | 3.700 | 0.014 | upload,lighting,presentation |
| light-direction | 3.150 | 0.084 | upload,shadow,reconstruction,lighting,presentation |
| material-values | 3.700 | 0.014 | upload,lighting,presentation |
| geometry-move | 1.450 | 0.120 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| partial-geometry | 3.300 | 0.118 | upload,height,normal,shadow,reconstruction,lighting,presentation |
| forced-full | 6.300 | 0.138 | upload,height,normal,shadow,reconstruction,lighting,presentation |

## DOM integration (median per-frame timings)

Every scenario runs warmup + samples frames (never single-shot). callbackHostMs = the Ukibori renderer callbacks inside the harness flush; settleWallMs = the harness observer-delivery wait floor (setTimeout turns, NOT Ukibori work). measurement/scene-build are FRAME-LOCAL: a frame whose serial did not advance reports 0, never a stale previous-frame value. The scroll scenario drives a real window.scrollTo + document scroll listener.

| Scenario | Surfaces | Samples | Wall ms | Callback ms | Settle ms | Meas. ms | Scene-build ms | Rect calls | Style calls | Invocations | Skipped |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stable-page | 1 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 1 | 20 | 9.900 | 0.200 | 9.500 | 0.000 | 0.000 | 3 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 1 | 20 | 9.800 | 0.100 | 9.600 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| frequent-mutations | 1 | 20 | 9.650 | 0.000 | 9.500 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| scroll | 1 | 20 | 9.800 | 0.000 | 9.700 | 0.000 | 0.000 | 1 | 0 | 0.00 | 1.00 |
| stable-page | 10 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 10 | 20 | 10.000 | 0.800 | 9.100 | 0.100 | 0.000 | 12 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 10 | 20 | 9.550 | 0.100 | 9.450 | 0.100 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| frequent-mutations | 10 | 20 | 10.000 | 0.000 | 9.900 | 0.000 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| scroll | 10 | 20 | 10.000 | 0.050 | 9.850 | 0.000 | 0.000 | 10 | 0 | 0.00 | 1.00 |
| stable-page | 50 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 50 | 20 | 10.950 | 1.000 | 9.900 | 0.200 | 0.000 | 52 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 50 | 20 | 9.600 | 0.200 | 9.300 | 0.200 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| frequent-mutations | 50 | 20 | 9.550 | 0.200 | 9.400 | 0.200 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| scroll | 50 | 20 | 10.050 | 0.200 | 9.800 | 0.200 | 0.000 | 50 | 0 | 0.00 | 1.00 |
| stable-page | 100 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 100 | 20 | 10.600 | 1.200 | 9.200 | 0.300 | 0.000 | 102 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 100 | 20 | 9.950 | 0.300 | 9.700 | 0.300 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| frequent-mutations | 100 | 20 | 10.050 | 0.300 | 9.800 | 0.300 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| scroll | 100 | 20 | 9.800 | 0.300 | 9.550 | 0.300 | 0.000 | 100 | 0 | 0.00 | 1.00 |
| stable-page | 250 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 250 | 20 | 12.150 | 2.350 | 9.700 | 0.700 | 0.000 | 252 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 250 | 20 | 10.100 | 0.750 | 9.350 | 0.750 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| frequent-mutations | 250 | 20 | 10.600 | 0.900 | 9.800 | 0.900 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| scroll | 250 | 20 | 10.000 | 0.700 | 9.150 | 0.700 | 0.000 | 250 | 0 | 0.00 | 1.00 |
| stable-page | 500 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 500 | 20 | 13.100 | 3.450 | 9.500 | 1.450 | 0.100 | 502 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 500 | 20 | 11.000 | 1.300 | 9.650 | 1.300 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| frequent-mutations | 500 | 20 | 11.050 | 1.400 | 9.400 | 1.400 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| scroll | 500 | 20 | 10.850 | 1.100 | 9.700 | 1.100 | 0.000 | 500 | 0 | 0.00 | 1.00 |
| stable-page | 1000 | 20 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0 | 0 | 0.00 | 1.00 |
| one-surface-resize | 1000 | 20 | 14.600 | 4.800 | 9.700 | 2.400 | 0.100 | 1002 | 3 | 1.00 | 0.00 |
| unrelated-mutation | 1000 | 20 | 12.450 | 2.600 | 9.800 | 2.600 | 0.000 | 1000 | 0 | 0.00 | 1.00 |
| frequent-mutations | 1000 | 20 | 12.500 | 2.750 | 9.750 | 2.750 | 0.000 | 1000 | 0 | 0.00 | 1.00 |
| scroll | 1000 | 20 | 11.600 | 2.400 | 9.100 | 2.400 | 0.000 | 1000 | 0 | 0.00 | 1.00 |

## Bottleneck matrix

| Workload | Main bottleneck | Secondary | Scaling factor | Evidence |
|---|---|---|---|---|
| simple 640x360 | shadow | - | pixels | 0.078ms GPU shadow |
| many surfaces | height | - | pixels x surfaces | 3.044ms height / 3.099ms frame (1000 surfaces) |
| many masks | height (mask SDF) | - | mask cells | 776.150ms frame at mask res 256 (1065024 cells) |
| soft shadow | shadow | - | pixels x samples x march | 1.808ms shadow at 16 samples (18.0x vs 1 sample) |
| high DPR + reconstruction | reconstruction | - | DPR^2 + radiusTexels^2 | 6.784ms recon / 6.992ms frame at DPR 4 radius 4 |
| DOM-heavy | measurement | skipped render | registered surfaces | 1000 getBoundingClientRect at 1000 surfaces |

## Follow-up optimization candidates

1. **ReconstructionPass is 63.7% of the frame at DPR 1 radius 2**  E0.021ms of 0.035ms. Candidate: shared-memory / separable reconstruction (currently (2r+1)^2 neighborhood).
2. **Mask SDF generation costs 776.150ms at mask resolution 256**  E1065024 padded mask cells. Candidate: mask SDF algorithm / caching (unchanged masks recomputed on geometry updates).
3. **Unchanged masks re-run the mask-SDF pass on an unrelated geometry update**  Eexecuted=[upload,height,normal,shadow,reconstruction,lighting,presentation] maskSdfPasses=1 height GPU=0.488ms. Candidate: GPU mask-SDF cache keyed by mask contents (benchmark-flagged; separate optimization issue).
4. **Soft shadow at 16 samples costs 18.0x the 1-sample hard path (1.808ms)**  Esamples {1,4,8,16} ->0.101/1.808ms shadow. Candidate: shadow marcher acceleration / hierarchical ray skipping.
5. **Full frame issues 6 queue.submit calls**  Esubmission-count benchmark (1..8 empty submissions are sub-ms each). Candidate: single-command-buffer renderer redesign (baseline recorded).

## Notes

- hostMs = host encode/upload/dispatch wall time; gpuTimestampMs = real GPU timestamp-query duration (unsupported adapters report n/a, never fabricated zeros); wallMs = render + `queue.onSubmittedWorkDone()` completion.
- Values are median over the warmed samples; p95/min/max live in the JSON documents.
- Absolute timings are hardware-specific; only compare runs on the same machine/runner.
