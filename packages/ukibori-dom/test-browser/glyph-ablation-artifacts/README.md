# Glyph lighting / shadow ablation artifacts (#52 follow-up, fixed 2x)

Committed evidence from `npm run ablation:glyph -w ukibori-dom`
(`scripts/glyph-ablation.mjs` driving `test-browser/glyph-lighting.html` in
headless Chrome, real WebGPU backend; browser `Chrome/152.0.7977.84`,
adapter `nvidia / blackwell`, layer `debugState().backend = "webgpu"`,
render target 508x348 at DPR 1).

The page renders the CURRENT PLAYGROUND FIXTURE through the REAL PRODUCTION
REACT COMPONENTS — `<Ukibori backend="webgpu">` / `<Surface>` /
`<UkiboriText>` — from the published `ukibori` build. There is no copied
rasterizer in the harness: `<UkiboriText>` owns the fixed-2x source-mask
rasterization, and the harness reads the retained registry for the resulting
mask geometry and delegation state. The runner executes the numeric shadow
verification TWICE consecutively; both passes must satisfy the fail-fast
assertions and agree before `GLYPH_ABLATION_RUN_OK` is printed (otherwise the
run exits nonzero). The light matrix is asserted too: every direction must be
opaque, opposite pairs must compare pixels, and the captured canvas must
equal `floor(region * requested dpr)` for DPR 1 / 1.5 / 2 (508x348 / 762x522
/ 1016x696) — mislabeled DPR evidence cannot pass. `Browser.getVersion`, the
layer `debugState()` runtime metadata and the WebGPU adapter details are
written into the reports.

Current fixture (demo/src/dashboard/Playground.tsx): panel roundedRect
radius 16, elevation 0, thickness 3, bevelWidth 5, matte; PLAY glyph as
`<UkiboriText>` with ABSOLUTE elevation 3 (on the panel top), thickness 2,
bevelWidth 1.1, metal; provider shadow pipeline
`{ angularRadius: 0, samples: 8, reconstruction: { enabled: true, radius: 2 },
bias: 0.15 }`. Source mask: **fixed exactly 2x the logical CSS box on every
device, independent of `window.devicePixelRatio`** (a 160x85 logical box
rasterizes to 320x170 at DPR 1, 1.5 and 2; the DOM box and the renderer
footprint stay 160x85).

## Layout

- `before/` — historical pre-#52 compositing evidence. `*-ink.png` /
  `*-noink.png` toggle the DOM ink manually.
- `after/` — the current run (fixed-2x policy + React production path).
  `glyph-ablation-report.json` = light matrix + initial alignment;
  `light-response-report.json` = the asserted light matrix;
  `shadow-verification-report.json` = the asserted double-pass shadow/bias
  verification; `*-ink.png` reproduces the pre-fix appearance through the
  documented DEBUG OVERRIDE, `*-noink.png` is the live policy state.
- `alignment/` — DOM-ink vs mask-ink matrix. `before/` = historical centered
  rasterization, `after/` = live-layout baseline anchoring + fidelity gate.
  The DOM ink is measured with the physical overlay canvas HIDDEN, so the
  segmented bbox is pure DOM ink.

## Light-response matrix (glyph-region |delta|, u8)

Current fixture (bias 0.15), WebGPU presented-frame readback (all four
directions opaque in every group; opposite pairs compared; the render target
is asserted to scale with the requested DPR):

| group | canvas | right vs left | bottom vs top |
|---|---:|---:|---:|
| DPR 1 | 508x348 | mean 0.78 / max 35 | mean 0.38 / max 33 |
| DPR 1.5 | 762x522 | mean 0.73 / max 117 | mean 0.40 / max 117 |
| DPR 2 | 1016x696 | mean 0.97 / max 92 | mean 0.49 / max 92 |
| DPR 1, ink suppressed | 508x348 | mean 0.78 / max 35 | mean 0.38 / max 33 |

The canvas pixels are identical with the DOM ink visible vs suppressed — the
ink only paints ABOVE the canvas. DPR here is the RENDER-TARGET resolution
(asserted from `debugState().dpr` and the floor-scaled region); the source
mask stays exactly 2x the logical box at every DPR.

## Numeric shadow verification (presented-frame, local attribution)

Method (no word center, no bounding box):

1. Glyph-present frame minus glyph-absent baseline at the SAME light/bias.
2. A cast-shadow candidate is a true receiver pixel (production mask
   `alpha = 0`; the antialiased silhouette halo `0 < alpha < 0.5` and the
   glyph surface `alpha >= 0.5` are excluded) that is > 2 u8 darker with the
   glyph present.
3. For each candidate, walk back TOWARD the light along the horizontal light
   ray to the first production-mask caster boundary (`alpha >= 0.5`). The
   **local horizontal distance** on the receiver plane is the PRIMARY
   screen-space projection metric; the 3D distance along the light ray
   (`horizontal * |L| / |Lxy|`) is retained as a SECONDARY metric. Both are
   reported in CSS px.
4. Direction comes from the local **caster -> shadow displacement** (mean
   vector), not from a word-center projection.

| light | bias | shadow px | mean Δ | max Δ | horiz mean | horiz max | ray max (secondary) | mean displacement (CSS px) |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| default (-0.6,-0.8,1) | 0.5 | 287 | 9.42 | 24 | 0.66 | 1.7 | 2.4 | (0.40, 0.53) |
| default | 0.15 | 322 | 10.80 | 24 | 0.76 | 1.7 | 2.4 | (0.46, 0.61) |
| reversed (0.6,0.8,1) | 0.5 | 119 | 8.22 | 74.7 | 0.88 | 1.7 | 2.4 | (-0.53, -0.70) |
| reversed | 0.15 | 179 | 7.25 | 74.7 | 1.13 | 1.7 | 2.4 | (-0.68, -0.91) |
| grazing (-0.6,-0.8,0.35) | 0.5 | 725 | 8.68 | 12 | 1.64 | 3.8 | 4.03 | (0.98, 1.31) |
| grazing | 0.15 | 972 | 9.25 | 12 | 2.19 | 4.4 | 4.66 | (1.31, 1.75) |

- Shadow exists on the panel at all three lights and both biases; the
  per-candidate attribution is complete (unattributed <= 2 pixels, < 1%).
- **Direction reversal from local displacement**: default (0.40, 0.53) and
  reversed (-0.53, -0.70) point to opposite sides (normalized cosine
  -0.998); every case's mean displacement aligns with its anti-light
  direction (alignment 1.000).
- **Horizontal projection (primary)**: the naive receiver-plane projection
  for a 2px relief is `thickness * |Lxy| / Lz` = 2.0 CSS px at z=1 and
  5.7 CSS px at z=0.35; the 0.5/0.15 bias and the 0.5-scene-unit shadow
  march shorten the measured extents to 1.7 px (z=1) and 3.8 -> 4.4 px
  (grazing). Grazing strictly exceeds the z=1 extent at both biases
  (assertion bands: default/reversed [1, 3], grazing [2.5, 7.5] CSS px). The
  asserted direction/plausibility all use the horizontal metric; the ray
  length (2.4 px at z=1, 4.03 -> 4.66 px grazing) is informational only.
- Assertions passed and both passes agreed (counts exact, horizontalMax and
  rayMax within 0.2 px) in two consecutive full runner invocations.

### Bias decision: the demo keeps 0.15 (removal not supported)

From the corrected, halo-excluded, locally-attributed metrics:

- Bias 0.15 adds cast-shadow **receiver** pixels at the demo lights:
  287 -> 322 shadow pixels at the default light (53 receiver pixels darker
  with 0.15), 725 -> 972 at grazing (+93). The reversed light gains shadow
  mostly on the glyph's own surface (79 px) with +1 receiver pixel.
- Bias 0.15 changes only **6 of 3269** glyph-surface pixels at the default
  light (darkening, i.e. mild self-shadow).
- The second roundedRect surface is bit-identical at both biases (mean luma
  188.11, 0 changed pixels) — no provider-global side effect.

The previous "0.5 is sufficient" conclusion was an artifact of the flawed
bounding-box metric (it excluded all shadows inside the ink box and counted
halo pixels as receivers). With the corrected evidence the reduced 0.15 bias
strictly increases real shadow coverage at the demo's default and grazing
lights, so the Playground and Feature Lab overrides are RETAINED (renderer
default 0.5 unchanged). The thickness-0.8 reduced-bias rail in
`packages/renderer/src/glyph.test.ts` stays as LEGACY thin-relief
characterization (not the current fixture).

## Alignment numbers (DOM ink center vs mask ink center, CSS px)

`canDelegate` / `lines` / `inkAttr` = the production delegation outcome
(`registry.inkDelegated`), the live line-rect count and the layer-owned
`data-ukibori-physical-ink` attribute. `mask` = production mask dimensions
(fixed 2x of the logical box); mask ink bounds are in CSS px (mask px / 2).

| case | mask | dCenter | canDelegate | lines | inkAttr |
|---|---:|---:|---|---:|---|
| PLAY 700 @32 px, DPR 1 | 168x86 | 0.00 / -0.25 | true | 1 | present |
| PLAY 700 @64 px, DPR 1 | 320x170 | -0.25 / 0.00 | true | 1 | present |
| PLAY 700 @96 px, DPR 1 | 474x256 | 0.00 / 0.00 | true | 1 | present |
| thin "illii" 400 @64 px, DPR 1 | 176x170 | -0.50 / 0.25 | true | 1 | present |
| thick "OM" 900 @64 px, DPR 1 | 232x170 | 0.25 / -0.25 | true | 1 | present |
| PLAY 700 @64 px, DPR 1.5 | 320x170 | -0.25 / 0.00 | true | 1 | present |
| PLAY 700 @64 px, DPR 2 | 320x170 | -0.25 / 0.00 | true | 1 | present |
| "PLAY" 700 @64 px + `letter-spacing: 2px`, DPR 1 | 320x170 | -0.25 / 0.00 | true | 1 | present |
| 3-line wrap "PLAY STOP WAIT" 700 @48 px (140 px box), DPR 1 | 280x384 | n/a | **false** | 3 | **absent** |
| "play" 700 @64 px + `text-transform: uppercase`, DPR 1 | 320x170 | n/a | **false** | 1 | **absent** |

All faithful cases match at <= 0.5 px, the screenshot/mask threshold
quantization floor. The multiline and text-transform rows are the fidelity
fixtures (DOM-visible fallback; ink bounds intentionally diverge).

## Reproduce

```
npm run ablation:glyph -w ukibori-dom -- <outDir>
npm run ablation:glyph -w ukibori-dom -- <outDir> alignment
```

The runner builds `ukibori-renderer`, `ukibori-dom` and `ukibori`, bundles
the harness page + React with esbuild and drives headless Chrome over a real
WebGPU adapter. Exit code is nonzero (and `GLYPH_ABLATION_RUN_OK` is not
printed) whenever the light-matrix or shadow assertions fail.
