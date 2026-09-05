# Glyph lighting ablation artifacts (#52)

Committed evidence from `npm run ablation:glyph -w ukibori-dom`
(scripts/glyph-ablation.mjs driving test-browser/glyph-lighting.html on a
real WebGPU adapter, headless Chrome).

## Layout

- `before/` — captured BEFORE the #52 production compositing policy (the
  DOM glyph ink was visible and covered the physical relief). The
  `*-ink.png` / `*-noink.png` pairs toggle the DOM ink manually.
- `after/` — captured AFTER the policy (registered glyph surfaces own the
  `data-ukibori-physical-ink` suppression through the explicit
  `delegateTextInk` intent). `*-ink.png` here reproduces the pre-fix
  appearance through the harness's documented DEBUG OVERRIDE (removing the
  layer-owned attribute); `*-noink.png` is the live policy state: the
  physical glyph relief on the canvas is the visual representation and its
  highlight flips with the light direction. The relief now sits exactly on
  the DOM ink position (see `alignment/`).
- `alignment/` — #52 review alignment matrix (DOM ink bounds measured from
  real screenshot pixels vs the rasterized mask ink bounds):
  `before/` = centered/middle rasterization, `after/` = live-layout
  baseline anchoring (UkiboriText.rasterizeText).

## Light-response numbers (glyph-region |delta| between opposite lights, u8)

| group | left vs right | top vs bottom |
|---|---:|---:|
| DPR 1 | mean 2.43 / max 75.3 | mean 0.88 / max 75.3 |
| DPR 1.5 | mean 1.69 / max 75.3 | mean 0.53 / max 75.3 |
| DPR 2 | mean 1.23 / max 75.3 | mean 0.25 / max 75.3 |

The canvas pixels are identical with the DOM ink visible vs suppressed —
the ink only paints ABOVE the canvas, which is why the pre-fix appearance
showed no light response at all.

## Alignment numbers (DOM ink center vs mask ink center, CSS px)

| case | before (centered/middle) | after (live-layout baseline) |
|---|---:|---:|
| PLAY 700 @32 px, DPR 1 | +5.00 px | 0.00 px |
| PLAY 700 @64 px, DPR 1 | +9.00 px | 0.00 px |
| PLAY 700 @96 px, DPR 1 | +14.00 px | 0.00 px |
| thin "illii" 400 @64 px, DPR 1 | +9.00 px | 0.00 px |
| thick "OM" 900 @64 px, DPR 1 | +9.00 px | 0.00 px |
| PLAY 700 @64 px, DPR 1.5 | +9.00 px | 0.00 px |
| PLAY 700 @64 px, DPR 2 | +9.00 px | 0.00 px |

Horizontal: the DOM ink sat ~1–1.5 px left of the mask ink (center vs left
anchoring); after the fix the residual is ≤ 0.5 px — the screenshot/mask
threshold quantization floor (DOM AA + mask `alpha >= 0.5` sampling), not a
layout offset. The positive before-values mean the DOM ink sat BELOW the
mask ink: the pre-fix ghost sliver above the glyphs in `before/` and the
post-fix coincidence in `after/`.
