# Issue #52 implementation report

Issue: [#52 — Make physical glyph relief respond visibly to directional light](https://github.com/MasafumiYamaguchi/Ukibori/issues/52)
Branch: `feat/issue-52-glyph-lighting` (base: master `52fa1bd`)

## Root cause

| Candidate | Contribution | Evidence |
|---|---|---|
| **DOM text compositing (PRIMARY)** | The visible DOM glyph paints 100% of the physical glyph silhouette (the mask raster IS the ink silhouette), so the physical relief on the overlay canvas — the only thing that responds to light — was completely covered. | Real-Chrome ablation (`packages/ukibori-dom/test-browser/glyph-lighting.mjs`): canvas pixels are IDENTICAL with the DOM ink visible vs suppressed (`before/` vs `after/` report groups); with ink suppressed the relief's highlight flips with the light direction. Pre-fix screenshots show flat dark text; the canvas's `|Δ|` between opposite lights reaches ~75/255 u8 at glyph bevels. |
| **Mask resolution (SECONDARY, pre-existing)** | `UkiboriText.rasterizeText` rasterizes at the rounded CSS-pixel box (no DPR multiplication) and the #19/#20 scene contract keeps that mask raster at every DPR, so the silhouette is a CSS-px staircase; thin strokes (≈1 mask px) have almost no bevel band left to shade. | Node characterization (`packages/renderer/src/glyph-lighting.test.ts`): thin-stroke mean directional response ≈ 7% of the thick-stroke one; the bevel band's mask-px width is DPR-invariant by contract (pinned test). Browser ablation: the response max (~75 u8) persists at DPR 1/1.5/2 (mean dilutes with panel pixels in the measured box). |
| **Height profile / normal (NOT significant for this issue)** | The glyph height is the GENERIC SDF + smoothstep bevel: the interior is a flat plateau (zero gradient, `(0,0,1)` normals — physically no directional response) and the response lives on the bevel band. The generic central-difference normal + Cook-Torrance respond correctly there. | Characterization: interior flat-normal ≈ 95% on large glyphs; final-color response mean 34.5 u8 / max 75 u8 (panel + glyph scene, ±x light); response flips sign with the direction. No renderer change is needed to satisfy the issue. |
| Vertical alignment (PRE-EXISTING, deferred) | The DOM ink and the canvas relief are vertically offset (measured: mask ink rows 15–59 of an 85 px box vs the DOM line box 0–85 at 64 px font — the relief sits a few px higher). Pre-existing (visible as a "ghost" sliver above the ink even pre-fix); the policy change does not move either. | Ablation report JSON `alignment` field + before/after screenshots. |

## Ablation results

- **DOM visible vs DOM ink suppressed** (real Chrome, real WebGPU, demo-equivalent panel + PLAY glyph at `elevation 3 / thickness 0.8 / bevelWidth 1.1`, material metal):
  - Canvas-side glyph-region `|Δ|` between opposite lights: left↔right mean 2.65 / max 75.3 u8, top↔bottom mean 1.24 / max 75.3 u8 (DPR 1) — identical in both ink states.
  - Screenshots: ink visible = flat text (physical relief fully covered; only the pre-existing offset "ghost" sliver shows); ink suppressed = relief with a directional highlight that flips left↔right and top↔bottom.
- **DPR 1 / 1.5 / 2**: response max stays ~75 u8 at every DPR (mean over the measured box dilutes because the box holds more panel pixels); the silhouette stays a CSS-px raster by the documented #19/#20 contract.
- **Profile/bevel observations** (CPU reference): bevel 0 → pure step (plateau everywhere except the boundary texel); bevel 1.1 → the band covers 2-px strokes entirely; larger bevels spread the shading area but the ±x response already exists without them.

## Adopted solution

**Production compositing policy (ukibori-dom only; zero renderer/React API changes):**

- A registered MASK surface additionally receives the managed, refcounted
  `data-ukibori-physical-ink` attribute; the injected stylesheet rule suppresses
  the DOM text ink (`color`, `-webkit-text-fill-color`,
  `-webkit-text-stroke-color` → `transparent`, `text-shadow` → `none`, all
  `!important`) while the physical glyph relief on the overlay canvas is the
  visual representation.
- The mechanism is the SAME ownership-safe pattern as the existing
  `data-ukibori-surface` background suppression: no inline style is saved or
  restored (app/React inline updates keep working), unregistration reveals the
  app's latest styles, pre-existing application-owned attributes are never
  removed, and a failed registration leaves nothing behind.
- `register` / `unregister` / `updateSurface` (shape-kind transitions) /
  `dispose` all follow the policy.

Why this shape: the physical renderer was already light-responsive (evidence
above); the missing piece was exclusively what paints on top. State selection
is by construction — suppression can only be acquired through registration,
which only happens in physical mode:

| State | DOM text |
|---|---|
| Before mask ready (no shape) / rasterization failure | visible (never registered) |
| Physical mask ready + physical backend active (CPU or WebGPU) | node/text/selection/aria/layout intact, ink delegated to the relief |
| Rasterization failure after registration (`shape: null`) | visible |
| CSS backend / provider-less / SSR / pre-hydration / high-contrast | visible (no registration in those modes) |

## Rejected/deferred candidates

- **Glyph-specific normal generation — not implemented.** The generic
  height-derived normal already produces a direction-tracking highlight
  (evidence above); the interior plateau is *supposed* to be flat. Adding a
  glyph SDF-gradient normal would change renderer semantics (CPU/GPU parity,
  roundedRect/mask distinction) with no evidence of need.
- **Mask supersampling — deferred.** It requires a `MaskSource` contract
  change (raster-scale metadata separating "source raster resolution" from the
  "logical CSS footprint") touching CPU geometry, GPU mask SDF, scene
  encoding, DOM measurement, surface sizing, partial updates and the per-mask
  SDF cache identity. The reviewer gate allows deferring when it cannot be
  completed safely inside the issue; the response evidence shows it is not
  required for the acceptance criteria. **Follow-up candidate** (together with
  the alignment offset below).
- **DOM transparent styling in UkiboriText (inline `color: transparent`) —
  rejected**: it would fight user styles, need state-dependent re-application
  and would apply in modes where registration (physical backend) is not
  guaranteed. The stylesheet + managed attribute approach is state-safe.

## Correctness

- **Accessibility**: the DOM node, textContent, ARIA attributes, focus and
  pointer behavior are untouched; only ink-painting CSS properties are
  suppressed by a stylesheet rule. Pinned by ukibori-dom policy tests and
  ukibori React tests.
- **Selection/copy**: the text remains selectable/copyable
  (`Range`/`Selection` contract pinned in tests); the UA `::selection`
  background keeps the selection perceivable with transparent ink.
- **SSR/hydration**: suppression is registration-scoped (client, post-hydration);
  SSR output is unchanged (pinned).
- **CSS backend / provider-less / none**: no registration → no suppression
  (pinned).
- **CPU/WebGPU**: no renderer semantic change (zero diffs in
  `packages/renderer`); the real-Chrome DOM GPU harness passes
  (`UKIBORI_DOM_GPU_PASS`), and the ablation staging reads confirm the
  presented GPU frames carry the responsive relief.
- **Layout**: mask/footprint contract untouched (`UkiboriText` sizing policy
  tests still pass).

## Visual verification

Committed artifacts: `packages/ukibori-dom/test-browser/glyph-ablation-artifacts/`
(`README.md` explains labels; `before/` = pre-fix, `after/` = post-fix build).

- Light directions: left / right / top / bottom screenshots in both ink states (DPR 1), plus left at DPR 2.
- Glyph families / font sizes: structural characterization in Node (thin stroke "L", thick stroke "H", counter "P" at small/medium/large grids); the real-font browser harness uses "PLAY" (counter + mixed stroke widths).
- DPR: 1 / 1.5 / 2 in the ablation matrix (canvas response persists; silhouette stays CSS-px).
- Direction flip: highlight moves with the light direction (artifacts `*-noink.png` left vs right).

## Performance

No additional GPU/CPU cost: the policy is pure CSS (one managed attribute +
four stylesheet declarations). No extra pass, dispatch, upload, storage, or
allocation; no scheduling change (the managed attribute is already filtered
from the mutation observer by the `data-ukibori-` prefix rule). The ablation
harness's own renders are evidence-only.

## Remaining limitations

1. **Pre-existing vertical offset** between the DOM ink and the canvas relief
   (measured above). Visible once the ink is suppressed; fixing it means
   reworking `rasterizeText`'s baseline policy (DOM line-box baseline vs
   canvas `middle`) — follow-up candidate.
2. **CSS-px silhouette staircase**: glyph edges keep the mask raster's CSS-px
   quantization at every DPR (crisper DOM text vs slightly coarser relief).
   Follow-up candidate together with raster-scale metadata (supersampling).
3. **Thin strokes** respond weakly (≈1 mask px strokes leave almost no bevel
   band); improving them ties into the same resolution follow-up.
4. **Interior plateau** has no directional shading — physically correct for a
   flat plateau; a stronger relief impression can be tuned via user-supplied
   `thickness`/`bevelWidth` (e.g. the demo's PLAY glyph parameters).

## Verification summary

- `ukibori-renderer` typecheck / tests (incl. the 5 new characterization tests) / build: pass
- `ukibori-dom` typecheck / tests (121, incl. 6 new policy tests) / build: pass; real-WebGPU DOM harness: `UKIBORI_DOM_GPU_PASS`
- `ukibori` typecheck / tests (177, incl. 4 new React policy tests) / build: pass
- `demo` build: pass
- Ablation runner (`npm run ablation:glyph -w ukibori-dom`): OK, artifacts committed
