# ukibori-dom

Framework-agnostic DOM integration layer for Ukibori (#20). It keeps the
browser DOM authoritative — layout, semantics, accessibility, text selection,
forms, focus, pointer and keyboard interaction — and adds only the physical
rendering layer: the DOM geometry is extracted into the `ukibori-renderer`
scene, the renderer output is composited onto a non-interactive overlay
canvas, and the two stay in sync through a retained registry and observer
driven invalidation.

This package is **not** the React API (#21). It is plain TypeScript over the
DOM and the renderer; the React provider/component layer builds on top of it.

```ts
import { UkiboriDom } from "ukibori-dom";

const ukibori = new UkiboriDom({
  light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
});

const button = document.querySelector<HTMLButtonElement>("#play")!;
ukibori.register(button, {
  id: "play",
  shape: { kind: "roundedRect", radius: 10 },
  elevation: 4,
  thickness: 2,
  bevelWidth: 3,
  material: "silicone",
});

// button stays a real DOM button: focusable, clickable, ARIA intact.
```

## Coordinate contract

**Scene coordinates are DOCUMENT-relative CSS pixels.** The origin `(0, 0)`
is the top-left of the document (where an element sits at `scrollX =
scrollY = 0`). Element geometry is read with `getBoundingClientRect()`
(viewport-relative) and moved into document space by adding the current page
scroll offsets. Consequences:

- ordinary page scroll does **not** change the retained scene — the overlay
  is positioned at the document origin and moves with the page, so scroll
  normally skips re-rendering entirely. A capture scroll listener re-measures
  anyway, so `position: sticky`, transforms and nested scroll containers
  still track correctly (the render is skipped when geometry is unchanged);
- `devicePixelRatio` is a render-target concern, never a scene-unit concern.
  The renderer grid is `floor(region.w * dpr)` texels and every surface
  length (position/size/radius/bevel/thickness/elevation) is scaled by `dpr`
  when the scene is built; the light direction is dimensionless and is not
  scaled. The color buffer is drawn into a canvas whose backing store equals
  the texel size and whose CSS size equals the region size (DPR-crisp);
- **DPR invariance of the shadow pass**: the scene is the dpr-scaled
  similarity image of the CSS-space scene, so every length-valued shadow
  parameter (#17 `stepSize` / `bias` / `maxDistance`) is mapped through the
  same transform (`scaleShadowOptions`). The renderer's step/bias defaults
  are materialized at 0.5 CSS px so they cannot silently shrink with dpr;
  `maxDistance` is forwarded only when configured (the renderer default is
  derived from the already-scaled scene diagonal). A dpr 1 vs dpr 2
  regression proves the same CSS-space shadow geometry;
- the scene region is the union of all registered rects inflated by `margin`
  (default 64 CSS px), reserving room for cast shadows. Shadowed base-plane
  pixels are clipped at the region boundary.

Renderer semantics from #13–#19 are preserved unchanged: `elevation` stays
absolute scene z (no parent-relative resolution), the bevel rises inward so
`size` is the physical footprint, masks keep their object identity so the
per-mask SDF cache hits, and `createScene` re-validates everything.

## Retained registry + dirty updates

`SurfaceRegistry` holds references only to registered elements (never a
document scan). Nodes are invalidated push-style and only dirty nodes are
re-measured:

| change | invalidation |
| --- | --- |
| `register` / `unregister` (mount/unmount) | node added/removed -> scene rebuild |
| resize (`ResizeObserver`) | node dirty |
| ANY external DOM mutation (`document.documentElement` observer) | all nodes dirty; the render re-measures and skips when geometry is unchanged |
| scroll (capture) | all nodes dirty (re-measure; skipped when unchanged) |
| viewport resize / dpr change | nodes + scene dirty |
| `document.fonts` `loadingdone` | nodes + scene dirty |
| `setLight` / `setIntensity` / `setMaterials` / `updateSurface` | scene dirty |

The single **document-level MutationObserver** closes the retained-layout
hole: an ancestor/sibling mutation (inserted node above the surface, changed
margins, ...) can move a registered element without touching it directly, so
invalidation is conservative (`markAllDirty`). The rAF-coalesced render
re-measures and **skips the renderer entirely when nothing changed** — no
per-frame rescans. **Ukibori-owned DOM mutations are filtered** (the overlay
canvas, the injected stylesheet, and managed `data-ukibori-*` attributes), so
the layer's own render output cannot feed back into another render and the
page settles after an initial render. All invalidation coalesces through one
rAF-throttled `render()`. This is the dirty-update seam: a future backend
(#21) can replace the single full-scene pass with region-scoped target
updates without changing the registry/observer API.

## Compositing

The overlay is one `<canvas>` inserted as the **first child of the stage**
element (`overlay.stage`, default `document.body`) — the container that wraps
the registered surfaces:

- **Stage-root stacking**: painting inside the stage's subtree guarantees the
  canvas paints above every in-flow ancestor background — an ordinary opaque
  card/panel can never hide the physical layer. The stage receives the
  managed `data-ukibori-stage` attribute and the injected stylesheet applies
  `isolation: isolate` (a stacking context with NO layout, positioning or
  containing-block effect), so the canvas's `z-index: -1` stays below the
  stage's in-flow content — the surfaces' DOM text — while being above the
  stage's own background;
- **Positioning**: `left`/`top` are expressed in the canvas's containing
  block (measured via `offsetParent`, with a computed-style fallback walk),
  so a positioned stage or a positioned ancestor wrapper both work; a
  SCROLLED containing block (`overflow: auto` / `scroll`) is compensated via
  its `scrollLeft`/`scrollTop` so the canvas stays glued to the region even
  when the block's content is scrolled; no registered element or ancestor is
  ever given a `position`;
- `pointer-events: none` → hit-testing, focus, keyboard and pointer events
  are never captured (verified by test);
- `aria-hidden="true"`, `role="presentation"`, `tabindex="-1"` → inert to the
  accessibility tree and to focus.

The renderer's `color` buffer is opaque everywhere (including the base
plane). The compositor (`compositeSurfaceImage`) reinterprets it for the DOM
overlay using the `objectId` and `visibility` buffers, which are still
generated unchanged by the #13–#19 pipeline and exposed via
`debugBuffers()`:

- surface pixels (owner != NO_OWNER): renderer color, opaque
- lit base-plane pixels: fully transparent — the page IS the base plane
- shadowed base-plane pixels: a translucent dark overlay (`shadowColor` at
  `shadowAlpha`, configurable — `shadowAlpha: 0` disables it) approximating
  the #17/#41 visibility mask (hard `{0,1}` or the #41 continuous
  occlusion strength, scaled by the #43 reconstructed field when the soft
  path is active).

## Double-rendering policy

Suppression is **ownership-safe**: an injected stylesheet keys on the managed
`data-ukibori-surface` attribute (`background: transparent !important;
box-shadow: none !important;`). `register` adds the attribute, `unregister`
removes it — no inline styles are saved or restored. Consequently:

- while registered, app/React inline style updates cannot double-render (the
  rule overrides plain inline values; an explicit inline `!important` is the
  documented override point);
- unregister reveals the element's LATEST app-owned style, never a stale
  mount-time snapshot.

Managed attributes are **lifecycle-safe and reference-counted**: the stage
attribute and each surface attribute are shared across UkiboriDom instances
(an attribute is removed only when the last owner releases it), and a
pre-existing application-owned attribute is never removed. `dispose()`
releases the stage attribute along with the canvas, so `isolation: isolate`
does not linger on the DOM.

Registration is **atomic**: duplicate ids / already-registered elements are
rejected BEFORE any attribute is touched, so a failed registration never
leaves suppression behind. Surface ids are **immutable** in `updateSurface`
(a rename would re-key the registry and silently change the scene's
insertion/paint order); replace a surface via `unregister` + `register`.

Everything else stays DOM-owned: text color and content, borders, the
`:focus-visible` ring, `cursor`, `aria-*`, `data-*`, form behavior, events.
DOM text is **not** moved to the canvas; a glyph relief participates in the
physical scene as a separate `mask` surface (#19) whose rasterization stays
on the application side.

A registered element that measures to zero / non-positive size (e.g.
`display: none`, detached, still laying out) is a **temporarily
non-renderable scene node**: it is excluded from the scene and region while
the visible surfaces keep rendering, and it rejoins automatically when it
becomes measurable again.

## Limits

- The scene is a single height field: overhangs, stacked surfaces at the same
  pixel and carving (inset) are out of scope (#18 height-field constraints).
- The overlay's stacking guarantee holds inside the stage's subtree: surfaces
  should be registered inside the stage element (`overlay.stage`); surfaces
  outside it still render geometrically, but opaque ancestors between the
  stage and such a surface can hide its physical layer.
- The synchronous constructor renders on the CPU reference path. The ASYNC
  `UkiboriDom.create()` path (`backend: "auto"`) additionally wires the
  #29/#31 `GpuScenePipeline`: WebGPU adapter/device are requested first and
  the pipeline presents DIRECTLY to the overlay's WebGPU canvas (no readback,
  no 2D copy). Any GPU init/render/device-loss failure switches ONCE to the
  retained CPU canvas (`debugState().backend` / `gpuFallbackReason` /
  `gpuFrame` expose the honest state; fallbacks are never retried).

## Verification

```sh
npm run typecheck -w ukibori-dom
npm run test -w ukibori-dom
npm run build -w ukibori-dom
```

Browser demo: `npm run dev`, then `/dom-debug.html`.
