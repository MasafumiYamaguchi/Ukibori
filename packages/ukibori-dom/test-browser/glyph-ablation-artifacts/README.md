# Glyph lighting ablation artifacts (#52)

Committed evidence from `npm run ablation:glyph -w ukibori-dom`
(scripts/glyph-ablation.mjs driving test-browser/glyph-lighting.html on a
real WebGPU adapter, headless Chrome).

## Layout

- `before/` — captured BEFORE the #52 production compositing policy (the
  DOM glyph ink was visible and covered the physical relief). The
  `*-ink.png` / `*-noink.png` pairs toggle the DOM ink manually.
- `after/` — captured AFTER the policy (registered mask surfaces own the
  `data-ukibori-physical-ink` suppression). `*-ink.png` here reproduces the
  pre-fix appearance through the harness's documented DEBUG OVERRIDE
  (removing the layer-owned attribute); `*-noink.png` is the live policy
  state: the physical glyph relief on the canvas is the visual
  representation and its highlight flips with the light direction.

## Key numbers (glyph-region |delta| between opposite lights, u8 units)

| group | left vs right | top vs bottom |
|---|---:|---:|
| DPR 1 | mean 2.65 / max 75.3 | mean 1.24 / max 75.3 |
| DPR 1.5 | mean 1.83 / max 75.3 | mean 0.78 / max 75.3 |
| DPR 2 | mean 1.32 / max 75.3 | mean 0.36 / max 75.3 |

The canvas pixels are identical with the DOM ink visible vs suppressed —
the ink only paints ABOVE the canvas, which is why the pre-fix appearance
showed no light response at all. The report JSONs also record the
pre-existing vertical alignment offset between the DOM ink and the canvas
relief (mask ink rows 15–59 of an 85 px box vs the DOM line box 0–85; the
relief sits higher than the DOM ink by a few px at 64 px font) — a
pre-existing rasterization-baseline observation, not introduced by #52.
