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

- **DOM visible vs DOM ink suppressed** (real Chrome, real WebGPU, demo-equivalent panel + PLAY glyph at `elevation 3 / thickness 0.8 / bevelWidth 1.1`, material metal — the pre-follow-up fixture; the current Playground fixture is thickness 2, see the follow-up section):
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
| Fidelity-degraded raster (multiline / metrics unavailable / typography mismatch or unsupported DOM typography) | visible — the mask may stay registered as geometry, but the DOM ink is never suppressed |
| Props changed since the last raster (identity mismatch: text/font/typography style/className) | visible (render-time identity gate — the stale raster is not the visual representation) |
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
- **Typography engine — non-goal (review round 3)**: `text-transform` and
  other DOM-only typography are NOT re-implemented on the canvas; unsupported
  typography takes the DOM-visible fallback (see the fidelity gate below).

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
- **DOM typography fidelity (review round 3)**: the gate reads the element's
  COMPUTED typography and classifies every relevant property:
  - *fallback (never mirrored)* — `text-transform` (no home-grown
    upper/lower/capitalize: the DOM paints "PLAY" while fillText draws the
    raw "play"), vertical writing, text-decoration ink, text-emphasis
    marks, -webkit-text-stroke ink, sub/super variant position, custom
    OpenType features/variation axes → `canDelegateInk=false`, DOM ink
    stays visible (pinned by the React text-transform test and the
    real-browser fixture);
  - *mirrored when supported* — letter-spacing, word-spacing, font-kerning,
    font-stretch, font-variant-caps, text-rendering, direction: applied to
    the canvas only when the implementation accepts the computed value AND
    reads it back (set + verified); an unsupported implementation falls
    back (pinned: letter-spacing supported/unsupported and word-spacing
    both ways in jsdom; the real-browser letter-spacing fixture delegates
    with mask ink coinciding with the DOM ink exactly);
  - the real-browser probe additionally documents which mirrors THIS
    Chrome's canvas supports (alignment report `typography.canvasSupport`).
- **Raster identity follows DOM typography (review round 3)**: the raster
  state is bound to (a) the typography-relevant prop identity — `className`
  + the typography style fields (font*, fontSize/Weight/Style/Stretch,
  lineHeight, letterSpacing, wordSpacing, textTransform, direction,
  writing-mode, features, textRendering, text-decoration/emphasis,
  -webkit-text-stroke-width) — checked at RENDER time with no DOM access,
  and (b) the computed typography fingerprint read from the live element at
  rasterization time, which dedupes effect re-runs that do not change the
  resolved typography. Pinned: fontSize 32→96, fontWeight 400→900,
  letter-spacing change and a className change (stylesheet-driven
  font-size/weight) each re-rasterize while the delegation stands; a
  typography change whose rasterization FAILS drops the stale raster and
  reveals the DOM text; recovery re-acquires the delegation exactly once
  and the structural css release still works (no refcount regression).
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
- DPR: 1 / 1.5 / 2 in the ablation matrix (canvas response persists; the
  render target scales, the source mask stays exactly 2x — see the follow-up
  section) and in the alignment matrix (CSS-space alignment is DPR-invariant,
  verified).
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
   **Addressed by the fixed-2x source-mask follow-up below: the mask is now
   exactly 2x the logical CSS box on every display, so the silhouette
   samples at half a CSS pixel (DPR-independent).**
2. **Thin strokes** respond weakly (≈1 mask px strokes leave almost no bevel
   band); improving them ties into the same resolution follow-up.
   **Reduced by the same fixed-2x mask (a ~1-CSS-px stroke keeps several mask
   pixels of bevel band).**
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
6. **Unsupported complex typography** (text-transform, vertical writing,
   text-decoration/emphasis/stroke ink, custom OpenType
   features/variation axes): DOM-visible fallback — the mask stays geometry
   only; no home-grown typography engine.
7. **Typography changes that React cannot see** (e.g. a CSS variable or
   media-query change outside the component's props/className): the raster
   identity tracks the component's typography props and the computed
   fingerprint at effect time; an externally mutated stylesheet value with
   no prop change is not observed (documented boundary).

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
- **Review round 3** — the fidelity gate became DOM-typography-faithful:
  computed typography is classified into mirrorable (letter/word-spacing,
  font-kerning/stretch/variant-caps, text-rendering, direction — applied
  and verified by readback) vs fallback (text-transform, vertical writing,
  decoration/emphasis/stroke ink, sub/super, custom features — DOM ink
  stays visible); the raster identity additionally binds to the
  typography-relevant style/className props (render-time gate) plus a
  computed typography fingerprint (effect-level dedupe). Real-browser
  fixtures: text-transform fallback and letter-spacing mirror (ink
  coincides exactly). Renderer: still zero changes.

## Verification summary

- `ukibori-renderer` typecheck / tests / build: pass — 1017 tests across 54
  suites (incl. the mapping-contract characterization and the legacy
  thin-relief rail). The 4 pre-existing `.mjs` collection-SyntaxError suites
  (`wasm-browser-contract`, `gpu/issue30-contract`,
  `gpu/test-browser-contract`, `wasm/determinism`) remain; no new
  deterministic failures.
- `ukibori-dom` typecheck / tests / build: pass — 187 tests (incl. the
  transition-safe ownership policy tests and the demo-bias (0.15) CPU glyph
  shadow references).
- `ukibori` typecheck / tests / build: pass — 215 tests (fixed-2x
  supersampling, identity/fidelity, alignment and typography tests).
- `demo` typecheck / build: pass.
- Real-browser harness (real Chrome 152 / Windows, real WebGPU backend):
  light-response mode + numeric shadow verification + alignment mode all
  `GLYPH_ABLATION_RUN_OK`; artifacts refreshed under
  `glyph-ablation-artifacts/after` and `alignment/after`.
- Real-Chrome alignment matrix: dCenter <= 0.5 px across every faithful case
  at DPR 1/1.5/2 with the production fixed-2x masks (320x170 for PLAY 64);
  the text-transform fixture pins the DOM-visible fallback and the
  letter-spacing fixture pins the mirror.
- Real-Chrome shadow verification (presented-frame readback, executed twice
  with fail-fast assertions; nonzero exit and no `GLYPH_ABLATION_RUN_OK`
  otherwise): shadow exists at default / reversed / grazing lights; the LOCAL
  caster-to-shadow displacement reverses (default (0.40, 0.53) vs reversed
  (-0.53, -0.70) CSS px; normalized cosine -0.998); the PRIMARY horizontal
  receiver-plane projection is 1.7 px at z=1 and 3.8 -> 4.4 px at z=0.35
  (naive projection `thickness * |Lxy| / Lz` = 2.0 / 5.7 px; grazing strictly
  larger at both biases), with the 3D ray length (2.4 / 4.03 -> 4.66 px)
  retained as secondary. Bias 0.15 adds receiver shadow pixels over 0.5
  (287 -> 322 at the default light, 725 -> 972 at grazing) and changes only
  6/3269 glyph-surface pixels at the default light, so the demo overrides are
  RETAINED (renderer default 0.5 unchanged).
- Real-Chrome light matrix: the captured render target is asserted to scale
  with the requested DPR (508x348 / 762x522 / 1016x696 at DPR 1 / 1.5 / 2,
  checked against `debugState().dpr` and `floor(region * dpr)`), so mislabeled
  DPR evidence cannot pass.

## Follow-up: fixed-2x glyph source-mask supersampling

Branch `codex/glyph-supersampling-shadow`, base master `adc0d5f`. Reduces
remaining limitations 1 (CSS-px silhouette staircase) and 2 (weak thin-stroke
response), inside `UkiboriText`, with **zero renderer production changes**.
An earlier draft keyed the raster scale off `window.devicePixelRatio`; the
final policy is DEVICE-INDEPENDENT: the source mask is rasterized at FIXED
exactly 2x the logical CSS box on every browser/device, capped at 2x, with no
DPR state, resize listener, resolution media query, raster-identity device
scale or DPR rerasterization lifecycle.

- `rasterizeText` rasterizes at exactly `2 ×` the LOGICAL integer CSS box
  (`GLYPH_RASTER_SCALE = 2`, never read from `window.devicePixelRatio`) with a
  common integer multiplier (gcd) for the dimensions. The physical footprint
  is unchanged: `SurfaceNode.size` maps the raster onto the same logical box
  (the renderer's 1e-6 isotropic mapping validation holds), so raster
  resolution is never scene scale.
- Exact isotropy: `mask.width / mask.height` equals the logical aspect by
  construction (integer box × the same multiplier); a 160x85 box rasterizes
  to 320x170 at DPR 1, 1.5 and 2. `ctx.setTransform(scale, ...)` maps the
  logical drawing space onto the denser raster once, so textAlign/baseline
  anchoring and DOM-ink alignment are unchanged.
- DPR independence: a mounted glyph never needs a re-raster when the display
  ratio changes; the raster identity no longer carries any device scale and
  the resize / `matchMedia("(resolution: Ndppx)")` lifecycle is removed. The
  DOM box and the scene `SurfaceNode.size/position`, absolute
  elevation/thickness, typography/fallback behavior and the canvas draw
  mapping are all preserved.
- Current demo fixture: the Playground/FeatureLab PLAY glyph is ABSOLUTE
  elevation 3 / thickness 2 / bevelWidth 1.1 on a panel elevation 0 /
  thickness 3, with the provider shadow pipeline `{ angularRadius: 0,
  samples: 8, reconstruction: { enabled: true, radius: 2 }, bias: 0.15 }`.
  The reduced 0.15 demo bias is RETAINED on corrected real-browser evidence:
  vs the 0.5 default it adds cast-shadow receiver pixels at the demo lights
  (287 -> 322 shadow pixels at the default light with 53 receiver pixels
  darker; 725 -> 972 at z=0.35 grazing) and changes only 6 of 3269
  glyph-surface pixels at the default light. The second roundedRect surface
  is bit-identical at both biases (mean 188.11, 0 changed pixels) — no
  provider-global side effect. (An earlier draft conclusion that 0.5 was
  "sufficient" came from a bounding-box metric that excluded shadows inside
  the ink box and counted silhouette-halo pixels as receivers; it was
  superseded by the per-pixel production-mask segmentation below.)

Coverage: renderer mapping-contract characterization (`glyph.test.ts`: a 2x
raster on the same footprint yields identical scene-unit heights and passes
`createScene`; the thickness-0.8 reduced-bias rail is kept as LEGACY
thin-relief characterization, not the current fixture); React tests for
fixed-2x at DPR 1 (logical 120x40 → mask 240x80, DOM 120x40), DPR 2 (same
240x80, never 4x), fractional/invalid/missing DPR (still 240x80), no
re-raster on a DPR change, logical DOM box / scene footprint preservation,
and all alignment/fallback/typography tests. The real-browser harness
(`glyph-lighting.mjs`) was REWRITTEN to render the actual production React
components (`<Ukibori>` / `<Surface>` / `<UkiboriText>` from the built
`ukibori` package) and only reads the retained registry — no copied
`rasterizeText`, no mirror. Its numeric shadow verification uses the
production mask per pixel: glyph-surface pixels (`alpha >= 0.5`) are never
receivers, the antialiased silhouette halo (`0 < alpha < 0.5`) is excluded,
and each remaining shadow candidate is attributed to the nearest production
caster boundary along the light ray — the LOCAL horizontal receiver-plane
projection is the PRIMARY metric (3D ray distance secondary) — with direction
taken from the local caster-to-shadow displacement. The verification runs
twice consecutively with fail-fast assertions (empty case, wrong direction,
non-increasing grazing horizontal projection, implausible length, unstable
passes) and the runner exits nonzero without `RUN_OK` on any failure; the
light matrix separately asserts that the render target scales with the
requested DPR (508x348 / 762x522 / 1016x696). `Browser.getVersion`,
`layer.debugState()` and the WebGPU adapter details are written into the
reports. The alignment matrix measures DOM ink with the overlay canvas hidden
(pure DOM ink): all faithful cases dCenter
≤ 0.5 px at DPR 1/1.5/2 with all fixed-2x masks (e.g. 320x170 for PLAY 64).
Evidence:
`packages/ukibori-dom/test-browser/glyph-ablation-artifacts/after/`
(`glyph-ablation-report.json`, `light-response-report.json`,
`shadow-verification-report.json`) and
`alignment/after/alignment-report.json`.
