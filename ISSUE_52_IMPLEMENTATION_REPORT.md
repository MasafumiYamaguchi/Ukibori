# Issue #52 implementation report

Issue: [#52 — Make physical glyph relief respond visibly to directional light](https://github.com/MasafumiYamaguchi/Ukibori/issues/52)
Branch: `feat/issue-52-glyph-lighting` (base: master `52fa1bd`)

## Root cause

| Candidate | Contribution | Evidence |
|---|---|---|
| **DOM text compositing (PRIMARY)** | The visible DOM glyph paints 100% of the physical glyph silhouette (the mask raster IS the ink silhouette), so the physical relief on the overlay canvas — the only thing that responds to light — was completely covered. | Real-Chrome ablation (`packages/ukibori-dom/test-browser/glyph-lighting.mjs`): canvas pixels are IDENTICAL with the DOM ink visible vs suppressed (`before/` vs `after/` report groups); with ink suppressed the relief's highlight flips with the light direction. Pre-fix screenshots show flat dark text; the canvas's `|Δ|` between opposite lights reaches ~75/255 u8 at glyph bevels. |
| **Mask resolution (SECONDARY, pre-existing)** | `UkiboriText.rasterizeText` rasterizes at the rounded CSS-pixel box (no DPR multiplication) and the #19/#20 scene contract keeps that mask raster at every DPR, so the silhouette is a CSS-px staircase; thin strokes (≈1 mask px) have almost no bevel band left to shade. | Node characterization (`packages/renderer/src/glyph-lighting.test.ts`): thin-stroke mean directional response ≈ 7% of the thick-stroke one; the bevel band's mask-px width is DPR-invariant by contract (pinned test). Browser ablation: the response max (~75 u8) persists at DPR 1/1.5/2 (mean dilutes with panel pixels in the measured box). |
| **Height profile / normal (NOT significant for this issue)** | The glyph height is the GENERIC SDF + smoothstep bevel: the interior is a flat plateau (zero gradient, `(0,0,1)` normals — physically no directional response) and the response lives on the bevel band. The generic central-difference normal + Cook-Torrance respond correctly there. | Characterization: interior flat-normal ≈ 95% on large glyphs; final-color response mean 34.5 u8 / max 75 u8 (panel + glyph scene, ±x light); response flips sign with the direction. No renderer change is needed to satisfy the issue. |
| Vertical alignment (was PRE-EXISTING — **fixed in the review round**) | The DOM ink and the canvas relief were vertically offset (measured: +5/+9/+14 px at font 32/64/96 — line-height half-leading + baseline-vs-middle anchoring — plus ~1–1.5 px horizontal from center-vs-left anchoring). Once the ink was suppressed the offset became user-visible. Fixed by anchoring the rasterization baseline to the live DOM line box (`alignment/` artifacts). | Ablation report JSON `alignment` field + before/after screenshots. |

## Ablation results

- **DOM visible vs DOM ink suppressed** (real Chrome, real WebGPU, demo-equivalent panel + PLAY glyph at `elevation 3 / thickness 0.8 / bevelWidth 1.1`, material metal):
  - Canvas-side glyph-region `|Δ|` between opposite lights: left↔right mean 2.65 / max 75.3 u8, top↔bottom mean 1.24 / max 75.3 u8 (DPR 1) — identical in both ink states.
  - Screenshots: ink visible = flat text (physical relief fully covered; only the pre-existing offset "ghost" sliver shows); ink suppressed = relief with a directional highlight that flips left↔right and top↔bottom.
- **DPR 1 / 1.5 / 2**: response max stays ~75 u8 at every DPR (mean over the measured box dilutes because the box holds more panel pixels); the silhouette stays a CSS-px raster by the documented #19/#20 contract.
- **Profile/bevel observations** (CPU reference): bevel 0 → pure step (plateau everywhere except the boundary texel); bevel 1.1 → the band covers 2-px strokes entirely; larger bevels spread the shading area but the ±x response already exists without them.

## Adopted solution

**Production compositing policy (ukibori-dom + the UkiboriText intent; zero
renderer changes):**

- The delegation is **explicit, not shape-inferred**: `UkiboriText` registers
  its glyph with the compositing-only `delegateTextInk` intent (never
  forwarded to the scene builder or renderer) plus its mask shape. Only that
  combination acquires the managed, refcounted
  `data-ukibori-physical-ink` attribute; the injected stylesheet rule
  suppresses the DOM text ink (`color`, `-webkit-text-fill-color`,
  `-webkit-text-stroke-color` → `transparent`, `text-shadow` → `none`, all
  `!important`) while the physical glyph relief on the overlay canvas is the
  visual representation.
- **Generic mask surfaces keep their DOM text DOM-owned**: a public
  `<Surface shape={{ kind: "mask" }}>` (icon silhouette, arbitrary alpha
  geometry) never sets the intent, so its text/content stays visible above
  the physical relief. The shape kind alone delegates nothing.
- The mechanism is the SAME ownership-safe pattern as the existing
  `data-ukibori-surface` background suppression: no inline style is saved or
  restored (app/React inline updates keep working), unregistration reveals
  the app's latest styles, pre-existing application-owned attributes are
  never removed, and a failed registration leaves nothing behind.
- The ownership is **EDGE-TRIGGERED**: acquired exactly once on the
  delegation false→true transition, released exactly once on the true→false
  transition (unregister / dispose / intent or shape transitions). Retained
  property updates (text/material/elevation/thickness/bevel/mask-object
  swaps — including the React mount sequence, where the updateSurface effect
  follows registration) never re-acquire, so the refcount tracks "who owns
  the attribute now", not the number of option updates.
- `register` / `unregister` / `updateSurface` / `dispose` all follow the
  policy through the single `delegatesInk()` decision point.

**Alignment policy (ukibori rasterization):** `UkiboriText.rasterizeText` no
longer centers the text at the box middle. The DOM ink position is measured
from the LIVE layout (a `Range` over the text gives the line box) and the
rasterization places an **alphabetic baseline** at
`lineBoxTop + (lineBoxHeight − (ascent + descent)) / 2 + fontBoundingBoxAscent`,
left-anchored at the line box origin, with the computed letter-spacing
replicated through the canvas property. No magic pixel offsets, no
font-specific constants, no DPR-dependent correction; environments without
live layout metrics (jsdom-style tests) fall back to the legacy centered
placement.

Why this shape: the physical renderer was already light-responsive (evidence
above); the missing piece was exclusively what paints on top — plus the
alignment that makes the ink→relief transition visually seamless. State
selection is by construction — suppression can only be acquired through
registration, which only happens in physical mode:

| State | DOM text |
|---|---|
| Before mask ready (no shape) / rasterization failure | visible (never registered; a failure for the current value drops the raster entirely — no stale previous glyph) |
| Physical mask ready + physical backend active (CPU or WebGPU) + faithful raster (`canDelegateInk`) | node/text/selection/aria/layout intact, ink delegated to the relief |
| Fidelity-degraded raster (multiline / metrics unavailable / typography mismatch) | visible — the mask may stay registered as geometry, but the DOM ink is never suppressed |
| Props changed since the last raster (identity mismatch) | visible (render-time identity gate — the stale raster is not the visual representation) |
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
  required for the acceptance criteria. **Follow-up candidate**.
- **DOM transparent styling in UkiboriText (inline `color: transparent`) —
  rejected**: it would fight user styles, need state-dependent re-application
  and would apply in modes where registration (physical backend) is not
  guaranteed. The stylesheet + managed attribute approach is state-safe.
- **Full multiline rasterizer — non-goal (review round 2)**: wrapping /
  multi-line text is not faithfully rasterized by the single-line mask;
  instead the fidelity gate keeps the DOM ink visible there (see below), so
  the fallback is DOM-visible rather than an incorrect physical
  representation.

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
- **Physical → CSS fallback**: the structural backend switch disposes the
  layer, which releases the ink suppression exactly once — pinned by a React
  test that also exercises repeated delegated updates first (a refcount leak
  would leave the attribute behind).
- **Repeated update ownership lifecycle**: pinned at the dom-layer level
  (register + 10 delegated updates → unregister/dispose releases exactly
  once; non-mask → delegated → delegated → non-mask transitions; cross-layer
  shared-attribute refcount preserved).
- **Generic mask preservation**: a generic `Surface` with `shape={{kind:"mask"}}`
  — including nested child text — keeps its DOM text DOM-owned (React tests).
- **Stale raster invalidation (review round 2)**: the raster state is bound
  to its `text`/`font` identity — a success → failure on a text/font change
  removes the physical-ink attribute, empties the registration and leaves
  the CURRENT text visible/selectable/labelled (pinned); success → failure
  → success re-acquires the delegation exactly once (pinned, including the
  structural css release afterwards).
- **Delegation fidelity (review round 2)**: `canDelegateInk` gating pinned —
  metrics-unavailable fallback (mask registered, attr absent, text visible)
  and the explicit-font typography gate (geometry-only) in jsdom; the
  3-line wrap fixture in the real-browser alignment matrix.
- **Alignment**: real-browser measurement (screenshot round-trip ink
  segmentation vs mask alpha bounds) — the pre-fix DOM ink sat +5/+9/+14 px
  (font 32/64/96) below the mask ink and ~1–1.5 px left; after the
  live-layout baseline anchoring, all seven measured cases (PLAY 32/64/96,
  thin "illii", thick "OM", DPR 1/1.5/2) match with dCenter 0.00 / ≤ 0.5 px
  (the measurement's own AA quantization floor). The mask-ready transition
  no longer moves the visual glyph.
- **CPU/WebGPU**: no renderer semantic change (zero diffs in
  `packages/renderer`); the real-Chrome DOM GPU harness passes
  (`UKIBORI_DOM_GPU_PASS`), and the ablation staging reads confirm the
  presented GPU frames carry the responsive relief.
- **Layout**: mask/footprint contract untouched (`UkiboriText` sizing policy
  tests still pass; the alignment change only affects WHERE the text is
  drawn INTO the same-size mask raster, never the box).

## Visual verification

Committed artifacts: `packages/ukibori-dom/test-browser/glyph-ablation-artifacts/`
(`README.md` explains labels; `before/` = pre-fix, `after/` = post-fix build).

- Light directions: left / right / top / bottom screenshots in both ink states (DPR 1), plus left at DPR 2.
- Glyph families / font sizes: structural characterization in Node (thin stroke "L", thick stroke "H", counter "P" at small/medium/large grids); the real-font browser harness uses "PLAY" (counter + mixed stroke widths) plus the alignment matrix's thin "illii" and thick "OM" at 32/64/96 px.
- DPR: 1 / 1.5 / 2 in the ablation matrix (canvas response persists; silhouette stays CSS-px) and in the alignment matrix (CSS-space alignment is DPR-invariant, verified).
- Direction flip: highlight moves with the light direction (artifacts `*-noink.png` left vs right).
- Alignment: mask-ready transition visual position (DOM ink vs relief) — `alignment/` artifacts.

## Performance

- No added GPU pass / dispatch / upload / storage and no additional
  per-frame renderer cost: the policy is pure CSS (one managed attribute +
  four stylesheet declarations) and the renderer is untouched.
- Rasterization-time CPU work added (one-off per text/font change, not per
  frame): a `Range` line-box measurement, `TextMetrics`
  (fontBoundingBox/actual) queries, computed-style reads for
  letter-spacing/typography and the normalized font comparison for the
  fidelity gate. All are client-side DOM reads; none enter the renderer
  path.

## Remaining limitations

1. **CSS-px silhouette staircase**: glyph edges keep the mask raster's CSS-px
   quantization at every DPR (crisper DOM text vs slightly coarser relief).
   Follow-up candidate together with raster-scale metadata (supersampling).
2. **Thin strokes** respond weakly (≈1 mask px strokes leave almost no bevel
   band); improving them ties into the same resolution follow-up.
3. **Interior plateau** has no directional shading — physically correct for a
   flat plateau; a stronger relief impression can be tuned via user-supplied
   `thickness`/`bevelWidth` (e.g. the demo's PLAY glyph parameters).
4. **Multi-line DOM text** (wrapping spans): no full multiline rasterizer —
   the fidelity gate keeps the DOM ink VISIBLE there (DOM-visible fallback,
   the physical mask stays geometry only and is never the visual source of
   truth). A real-browser fixture pins this (3-line wrap →
   `canDelegateInk=false`, `data-ukibori-physical-ink` absent).
5. **Explicit `font` prop with typography that differs from the DOM computed
   font**: the fidelity gate keeps the ink delegated-off (geometry only);
   delegation requires normalized raster/computed typography equality.

## Review round (PR #54)

- **BLOCKER 1 (ownership refcount)** — fixed edge-triggered ownership with
  per-entry state; repeated delegated updates can no longer leak the
  attribute after one release (6 new lifecycle tests).
- **BLOCKER 2 (over-broad mask policy)** — delegation now requires the
  explicit `delegateTextInk` intent + mask shape; generic mask surfaces
  (including nested child text) keep their DOM text (ukibori-dom decision
  point + React tests A–D, G–I from the review list).
- **BLOCKER 3 (visible alignment offset)** — measured in a real browser
  (screenshot pixel analysis vs mask alpha bounds), then fixed by anchoring
  the rasterization baseline to the live DOM line box; all measured cases
  align at the quantization floor (artifacts `alignment/before|after`).
- **Review round 2** — the raster state is identity-bound (success →
  failure on a text/font change drops the stale raster and releases the
  delegation; recovery re-acquires exactly once), and delegation is
  fidelity-gated (`canDelegateInk`: single live line box + usable font
  metrics + typography match; multiline/metrics-unavailable/typography-
  mismatched rasters keep the DOM ink visible). Renderer: still zero
  changes (no glyph-specific normal, no supersampling).

## Verification summary

- `ukibori-renderer` typecheck / tests (incl. the 5 characterization tests) / build: pass
- `ukibori-dom` typecheck / tests (126, incl. the transition-safe ownership policy tests) / build: pass; real-WebGPU DOM harness: `UKIBORI_DOM_GPU_PASS`
- `ukibori` typecheck / tests (185, incl. the intent + alignment + generic-mask React tests and the review-round-2 identity/fidelity tests) / build: pass
- `demo` build: pass
- Ablation runner (light + alignment modes): OK, artifacts committed
- Real-Chrome alignment matrix: dCenter 0.00 / ≤ 0.5 px across all cases (see `alignment/after`)
