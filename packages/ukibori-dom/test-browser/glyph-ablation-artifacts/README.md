# Glyph lighting / shadow ablation artifacts (#52 follow-up, fixed 2x)

Committed evidence from `npm run ablation:glyph -w ukibori-dom`
(`scripts/glyph-ablation.mjs` driving `test-browser/glyph-lighting.html` in
headless Chrome, real WebGPU backend; browser `Chrome/152.0.7977.84`,
adapter `nvidia / blackwell`, layer `debugState().backend = "webgpu"`,
render target 552x336 at DPR 1; scene region 552.78x336.38 CSS px).

The page renders the CURRENT PLAYGROUND GLYPH FIXTURE through the REAL
PRODUCTION REACT COMPONENTS — `<Ukibori backend="webgpu">` / `<Surface>` /
`<UkiboriText>` — from the published `ukibori` build. There is no copied
rasterizer in the harness: `<UkiboriText>` owns the fixed-2x source-mask
rasterization, and the harness reads the retained registry for the resulting
mask geometry and delegation state.

**Typographic / layout fidelity.** The glyph geometry IS the canvas-rasterized
text mask, so the harness styles the production glyph with the ACTUAL
Playground declarations: `.demo-play-panel` and `.ukibori-text` are copied
verbatim from `demo/src/index.css` and the parity is pinned by
`test-browser/glyph-lighting-css.test.mjs`. The harness records the COMPUTED
typography, logical glyph box and mask dimensions in the shadow report and
asserts them (`shadowAssertionFailures`). Capture-stage-only deviations are
recorded in the report as `fixture.layoutDifferences`:

- the panel is pinned on the fixed capture stage instead of the demo's
  showcase grid;
- the trailing `.plain-note` paragraph is omitted (it follows the glyph and
  cannot affect the glyph's box).

Neither changes the glyph's logical box or its raster mask.

The runner executes the numeric shadow verification TWICE consecutively; both
passes must satisfy the fail-fast assertions and agree before
`GLYPH_ABLATION_RUN_OK` is printed (otherwise the run exits nonzero). The
shadow gate also asserts the **bias-adoption decision** (0.15 must add
receiver shadow pixels at the default and grazing Playground lights, and other
roundedRect surfaces must stay within a small tolerance), not merely that a
shadow exists. The light matrix is asserted too: every direction must be
opaque, opposite pairs must compare pixels, and the captured canvas must equal
`floor(region * requested dpr)` for DPR 1 / 1.5 / 2 (552x336 / 829x504 /
1105x672) — mislabeled DPR evidence cannot pass. `Browser.getVersion`, the
layer `debugState()` runtime metadata and the WebGPU adapter details are
written into the reports.

## Current fixture (demo/src/dashboard/Playground.tsx + demo/src/index.css)

- panel: roundedRect radius 16, elevation 0, thickness 3, bevelWidth 5, matte
- PLAY glyph as `<UkiboriText>`: ABSOLUTE elevation 3 (on the panel top),
  thickness 2, bevelWidth 1.1, metal
- computed typography: `font-size` 51.2px (3.2rem), `font-weight` 800,
  `letter-spacing` 6.144px (0.12em), `line-height` 51.2px, family
  `ui-monospace, "Cascadia Mono", Consolas, monospace`; logical glyph box
  145x51 CSS px
- provider shadow pipeline: `{ angularRadius: 0, samples: 8,
  reconstruction: { enabled: true, radius: 2 }, bias: 0.15 }`
- source mask: **fixed exactly 2x the logical CSS box on every device,
  independent of `window.devicePixelRatio`** (the 145x51 box rasterizes to
  290x102 at DPR 1, 1.5 and 2; the DOM box and the renderer footprint stay
  145x51).

Feature Lab is a SEPARATE demo surface and uses the RENDERER DEFAULT shadow
bias. Its purpose is color fidelity / feature integration, and the Playground
0.15 measurements do not transfer to its different fixture (panel 0/4, glyph
elevation 4 / thickness 2 / bevel 1.4, light (-0.5,-0.7,1)).

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
| DPR 1 | 552x336 | mean 2.40 / max 136 | mean 0.69 / max 36 |
| DPR 1.5 | 829x504 | mean 1.02 / max 135 | mean 0.50 / max 136 |
| DPR 2 | 1105x672 | mean 0.66 / max 58 | mean 0.41 / max 118 |
| DPR 1, ink suppressed | 552x336 | mean 2.40 / max 136 | mean 0.69 / max 36 |

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
   ray to the first production-mask caster boundary (`alpha >= 0.5`). Both the
   raw local max and the **90th-percentile local reach** are reported in CSS
   px; the gate uses the robust P90 because the raw max is dominated by the
   rare receiver pixel whose nearest caster lies across a letter counter (a
   real counter shadow, but not the cast-shadow extent of the glyph
   silhouette). Direction comes from the local **caster -> shadow
   displacement** (mean vector), not from a word-center projection.

| light | bias | shadow px | mean Δ | max Δ | horiz mean | P90 reach | horiz max (info) | ray max (secondary) | mean displacement (CSS px) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| default (-0.6,-0.8,1) | 0.5 | 198 | 8.72 | 18.3 | 1.13 | 2 | 4.1 | 5.8 | (0.68, 0.90) |
| default | 0.15 | 208 | 9.16 | 24 | 1.14 | 2 | 4.1 | 5.8 | (0.68, 0.91) |
| reversed (0.6,0.8,1) | 0.5 | 135 | 10.16 | 17.3 | 0.49 | 1 | 15.2 | 21.5 | (-0.29, -0.39) |
| reversed | 0.15 | 177 | 11.10 | 24 | 0.67 | 2 | 15.2 | 21.5 | (-0.40, -0.54) |
| grazing (-0.6,-0.8,0.35) | 0.5 | 529 | 8.32 | 12 | 2.00 | 4 | 4.1 | 4.34 | (1.20, 1.60) |
| grazing | 0.15 | 713 | 9.07 | 12 | 2.55 | 6 | 5 | 5.30 | (1.53, 2.04) |

- Shadow exists on the panel at all three lights and both biases; the
  per-candidate attribution is complete (unattributed <= 5 pixels, < 3%).
- **Direction reversal from local displacement**: default (0.68, 0.90) and
  reversed (-0.29, -0.39) point to opposite sides (normalized cosine
  -1.000); every case's mean displacement aligns with its anti-light
  direction (alignment 1.000).
- **P90 reach (gate)**: the naive receiver-plane projection for a 2px relief
  is `thickness * |Lxy| / Lz` = 2.0 CSS px at z=1 and 5.7 CSS px at z=0.35;
  the 0.5/0.15 bias and the shadow march shorten the measured P90 to 2px
  (z=1) and 4 -> 6px (grazing). Grazing strictly exceeds the z=1 reach at
  both biases (assertion bands: default/reversed [1, 3.5], grazing [2, 7.5]
  CSS px). The raw max and the ray length stay informational.
- Assertions passed and both passes agreed (counts and P90 exact,
  horizontalMax and rayMax within 0.2 px) in two consecutive full runner
  invocations.

### Bias decision: the Playground keeps 0.15 (and the decision is gated)

From the corrected, halo-excluded, locally-attributed metrics:

- Bias 0.15 adds cast-shadow **receiver** pixels at both demo lights:
  198 -> 208 shadow pixels at the default light (gain +10) and 529 -> 713 at
  grazing (gain +184). The runner asserts both gains are positive.
- Bias 0.15 changes **0 of 1786** glyph-surface pixels at the default light
  (the `biasImpact.perLight.default.glyphSurface` counters).
- The second roundedRect surface is bit-identical at both biases (mean luma
  188.11, 0 changed pixels) — no provider-global side effect. The runner
  asserts both the surface and receiver change counts stay within the small
  `biasDecision.sidePanelTolerance` (8 px) envelope.

The Playground override `bias: 0.15` is therefore RETAINED (renderer default
0.5 unchanged), and the adoption decision itself is a regression assertion.
Feature Lab no longer overrides the bias: the Playground numbers do not
transfer to its different fixture, so it uses the renderer default. The
thickness-0.8 reduced-bias rail in `packages/renderer/src/glyph.test.ts` stays
as LEGACY thin-relief characterization (not the current fixture).

## Alignment numbers (DOM ink center vs mask ink center, CSS px)

`canDelegate` / `lines` / `inkAttr` = the production delegation outcome
(`registry.inkDelegated`), the live line-rect count and the layer-owned
`data-ukibori-physical-ink` attribute. `mask` = production mask dimensions
(fixed 2x of the logical box); mask ink bounds are in CSS px (mask px / 2).
The matrix keeps the Playground `.ukibori-text` family/line-height and
overrides size/weight/letter-spacing per case.

| case | mask | dCenter | canDelegate | lines | inkAttr |
|---|---:|---:|---|---:|---|
| PLAY 700 @32 px, DPR 1 | 180x64 | 0.36 / 0.06 | true | 1 | present |
| PLAY 700 @64 px, DPR 1 | 362x128 | -0.14 / 0.06 | true | 1 | present |
| PLAY 700 @96 px, DPR 1 | 542x192 | -0.14 / -0.44 | true | 1 | present |
| thin "illii" 400 @64 px, DPR 1 | 452x128 | -0.14 / -0.19 | true | 1 | present |
| thick "OM" 900 @64 px, DPR 1 | 180x128 | -0.39 / 0.06 | true | 1 | present |
| PLAY 700 @64 px, DPR 1.5 | 362x128 | -0.14 / 0.06 | true | 1 | present |
| PLAY 700 @64 px, DPR 2 | 362x128 | -0.14 / 0.06 | true | 1 | present |
| "PLAY" 700 @64 px + `letter-spacing: 2px`, DPR 1 | 316x128 | -0.14 / 0.06 | true | 1 | present |
| 3-line wrap "PLAY STOP WAIT" 700 @48 px (140 px box), DPR 1 | 280x288 | n/a | **false** | 3 | **absent** |
| "play" 700 @64 px + `text-transform: uppercase`, DPR 1 | 362x128 | n/a | **false** | 1 | **absent** |

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
