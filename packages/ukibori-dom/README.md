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
| attribute / subtree / text change (`MutationObserver`) | node dirty |
| scroll (capture) | all nodes dirty (re-measure; skipped when unchanged) |
| viewport resize / dpr change | nodes + scene dirty |
| `document.fonts` `loadingdone` | nodes + scene dirty |
| `setLight` / `setIntensity` / `setMaterials` / `updateSurface` | scene dirty |

All invalidation coalesces through one rAF-throttled `render()`. `render()`
re-measures dirty nodes, compares against the cached geometry and **skips the
renderer entirely when nothing changed**. This is the dirty-update seam: a
future backend (#21) can replace the single full-scene pass with
region-scoped target updates without changing the registry/observer API.

## Compositing

The overlay is one `<canvas>` inserted as the **first child of
`document.body`** — the public host contract is a **true document-origin
overlay** (the containing block must be the initial containing block; a
positioned/transformed host is out of contract, use the `factory` seam for a
custom overlay):

- `position: absolute` at the region's DOCUMENT coordinates, sized to the
  scene region → it scrolls with the page and clips cast shadows at the
  region boundary;
- `pointer-events: none` → hit-testing, focus, keyboard and pointer events
  are never captured (verified by test);
- **`z-index: -1`** → it paints above the page background (so cast shadows on
  the base plane are visible) and below every in-flow element, including the
  registered surfaces. Their DOM text is therefore visible WITHOUT any
  `position` change: registered elements keep their positioning semantics, so
  absolutely positioned descendants keep their containing block (regression:
  an absolute child's layout is untouched by register/unregister);
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
  the hard #17 visibility mask.

## Double-rendering policy

To prevent the original DOM background/shadow from painting a second, unlit
copy under the physical layer, `register` saves and overrides the element's
inline `background` and `box-shadow` (`transparent` / `none`, with
`!important`) and `unregister` restores them. Registration is **atomic**: a
duplicate-id / already-registered element is rejected BEFORE any inline style
is touched, so a failed registration never leaves suppression behind.
`updateSurface` can only change `id` through an atomic rename that moves both
registry maps and the scene identity together.

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
- The overlay is a document-origin element: a positioned/transformed
  `body`/`html` (or iframes) is out of contract — use the `overlay.factory`
  seam for a custom overlay.
- The initial implementation renders the full scene on the CPU backend;
  WebGPU / region-scoped updates are backend work (#21).

## Verification

```sh
npm run typecheck -w ukibori-dom
npm run test -w ukibori-dom
npm run build -w ukibori-dom
```

Browser demo: `npm run dev`, then `/dom-debug.html`.
