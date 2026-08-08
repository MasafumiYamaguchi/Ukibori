import type { HeightProfile, MaskSource, Vec3 } from "ukibori-renderer";

/**
 * #20 DOM integration layer — public types.
 *
 * Coordinate contract (fixed here, the single source of truth for the DOM
 * layer):
 *
 * - **Scene coordinates are DOCUMENT-relative CSS pixels.** The origin
 *   `(0, 0)` is the top-left of the document's initial containing block —
 *   i.e. where an element sits when `scrollX = scrollY = 0`. DOM geometry is
 *   read with `getBoundingClientRect()` (viewport-relative) and converted to
 *   document space by adding the current page scroll offsets
 *   (`window.scrollX / scrollY`).
 * - **Scene units are CSS pixels and are NEVER mixed with `devicePixelRatio`.**
 *   `devicePixelRatio` is a render-target concern: the renderer grid is
 *   `floor(region.width * dpr) x floor(region.height * dpr)` texels and all
 *   surface geometry is scaled by `dpr` when the scene is built. The final
 *   RGBA buffer is drawn to a canvas whose backing store equals the texel
 *   size and whose CSS size equals the region size, so the output is
 *   DPR-crisp while all scene math stays in CSS pixels (renderer #13
 *   convention).
 * - The scene origin for a render is the REGION's top-left corner
 *   (document space), so a surface at document position `(x, y)` has scene
 *   position `(x - region.x, y - region.y)` before the `dpr` scale.
 */

/**
 * Shape source for a DOM surface. `radius` is the rounded-rect corner radius
 * in CSS pixels; when omitted the DOM layer falls back to the element's own
 * computed `border-radius` (top-left corner). `mask` shapes (#19) receive a
 * `MaskSource` raster whose mapping must be isotropic with the element's
 * aspect ratio (enforced by `createScene`).
 */
export type DomShape =
  | { kind: "roundedRect"; radius?: number }
  | { kind: "mask"; mask: MaskSource };

/**
 * Options a caller registers for one DOM element. Field semantics mirror the
 * renderer `SurfaceNode` (#13) so the mapping is transparent:
 *
 * - `id`: unique scene id (surface id string, also the registry key)
 * - `elevation`: ABSOLUTE scene z of the surface base, CSS pixels
 * - `thickness`: vertical extent of the profile above the base (CSS px)
 * - `bevelWidth`: inward bevel band width (CSS px)
 * - `profile`: local height profile descriptor, defaults to `bevel`
 * - `material`: material ref (built-in preset or the layer's `materials` table)
 * - `castsShadow` / `receivesShadow`: #18 shadow flags
 *
 * The DOM layer does NOT resolve `raised`/`inset` variants or parent-relative
 * elevations; those are API-layer concepts (#21) and must be resolved to
 * absolute z before a scene reaches the renderer.
 */
export interface DomSurfaceOptions {
  id: string;
  shape: DomShape;
  elevation: number;
  thickness: number;
  bevelWidth?: number;
  profile?: HeightProfile;
  material: string;
  castsShadow?: boolean;
  receivesShadow?: boolean;
}

/** Measured, cached document-space geometry of one registered element. */
export interface MeasuredGeometry {
  /** document-relative top-left (CSS px) */
  x: number;
  y: number;
  /** CSS px, > 0 */
  w: number;
  h: number;
  /** corner radius (CSS px, finite >= 0) */
  radius: number;
}

/** A rectangle in document CSS pixels. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shared directional light state fed to the renderer scene. */
export interface DomLightState {
  /** unit vector from the receiver toward the light (#13 convention) */
  direction: Vec3;
  /** finite >= 0 */
  intensity: number;
}

/**
 * How the compositor maps the renderer output onto the DOM overlay.
 *
 * The renderer's `color` buffer is fully opaque (alpha 255 everywhere,
 * including the base plane). The DOM overlay must stay transparent where the
 * page shows through, so the compositor reinterprets the `objectId` and
 * `visibility` buffers:
 *
 * - surface pixels (owner != NO_OWNER): the renderer color, opaque
 * - lit base-plane pixels (owner == NO_OWNER, visibility == 1): fully
 *   transparent — the page IS the base plane
 * - shadowed base-plane pixels (visibility == 0): a translucent dark overlay
 *   (`shadowColor` at `shadowAlpha`) approximating the hard #17 cast shadow
 */
export interface CompositeOptions {
  /** RGB 0..255 tint for cast shadows on the base plane (default near-black) */
  shadowColor?: readonly [number, number, number];
  /** 0..1 opacity of cast shadows on the base plane (default 0.3) */
  shadowAlpha?: number;
}

/** RGBA image the overlay paints (ImageData-compatible). */
export interface SurfaceImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Renderer options forwarded to the shadow pass (#17). */
export interface DomShadowOptions {
  stepSize?: number;
  maxDistance?: number;
  bias?: number;
}

/** Snapshot of the layer's internal state for debugging / tests. */
export interface DomDebugState {
  /** number of registered (non-removed) surfaces */
  nodeCount: number;
  /** number of surfaces currently marked dirty */
  dirtyCount: number;
  /** current scene region (null when nothing renders) */
  region: Region | null;
  /** render-target pixels per CSS pixel actually used */
  dpr: number;
  /** milliseconds of the last render pass (0 before the first render) */
  lastRenderMs: number;
  /** width/height texels of the last render target */
  renderSize: { width: number; height: number } | null;
}
