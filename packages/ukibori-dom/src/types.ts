import type {
  GpuScenePipelineFrameStats,
  GpuTimestampFrameResult,
  HeightProfile,
  LinearRgb,
  MaskSource,
  Vec3,
} from "ukibori-renderer";

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
  /**
   * #45 LINEAR RGB directional-light color (dimensionless — NEVER
   * dpr-scaled; not an sRGB CSS color). Applies only to the direct/
   * directional lighting contribution; ambient/environment are never
   * tinted. Omitted -> white. Per-channel sanitization follows the
   * renderer: missing / non-finite / negative channels fall back to 1,
   * zero stays valid, values above 1 (HDR) are preserved.
   */
  color?: LinearRgb;
  /**
   * #41 apparent light size: angular radius of the light cone in RADIANS
   * (dimensionless — NEVER dpr-scaled). 0 (default) keeps the exact #17
   * hard-shadow semantics; a positive value softens cast shadows through
   * deterministic multi-direction sampling. Invalid values fall back to 0.
   */
  angularRadius?: number;
}

/**
 * Shared environment illumination state fed to the renderer scene (#22).
 *
 * A uniform environment independent of the directional light: it lifts
 * dielectrics through baseColor-scaled diffuse and keeps metals from
 * blacking out outside the direct specular lobe through an F0/roughness
 * specular term. The three controls are independent scene/shared values:
 *
 * - `intensity` 0 disables the environment entirely (the output stays close
 *   to the pre-#22 ambient + direct response)
 * - `diffuseIntensity` 0 removes only the environment diffuse
 * - `specularIntensity` 0 removes only the environment specular (the metal
 *   black-drop lift is off)
 */
export interface DomEnvironmentState {
  /** uniform environment illumination intensity, finite >= 0 (0 = off) */
  intensity: number;
  /** 0..1 share of the environment applied to diffuse (default 1) */
  diffuseIntensity: number;
  /** 0..1 share of the environment applied to specular (default 1) */
  specularIntensity: number;
}

/**
 * How the compositor maps the renderer output onto the DOM overlay.
 *
 * The renderer's `color` buffer is fully opaque (alpha 255 everywhere,
 * including the base plane), which is wrong on a DOM page: the page
 * background IS the base plane and must show through. The `objectId` and
 * `visibility` buffers disambiguate:
 *
 * - surface pixels (owner != NO_OWNER): the renderer color, opaque
 * - base-plane pixels scale the shadow tint with the #41 CONTINUOUS
 *   occlusion strength `clamp(1 - visibility, 0, 1)`: fully lit (vis 1) is
 *   transparent, partially occluded texels get a proportional translucent
 *   overlay, and fully shadowed texels (vis 0) get the full configured
 *   tint — a faithful-on-average approximation of the cast shadow drawn
 *   over whatever the page shows underneath
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

/** Renderer options forwarded to the shadow pass (#17/#41/#43). All lengths
 * are in CSS-space units: the DOM layer maps them through the dpr similarity
 * transform before they reach the renderer, so cast shadows are invariant
 * under devicePixelRatio. Invalid values fall back to the defaults
 * (step 0.5 / bias 0.5 CSS px; maxDistance derived from the scene diagonal).
 * `samples` (#41) is a COUNT — it is forwarded UNSCALED. */
export interface DomShadowOptions {
  stepSize?: number;
  maxDistance?: number;
  bias?: number;
  /**
   * #41 area-light sample count for soft cast shadows (only effective when
   * the light carries `angularRadius > 0`). Restricted to the documented
   * power-of-two candidates so visibility fractions stay exactly
   * representable; anything else falls back to the renderer default (8).
   */
  samples?: 1 | 4 | 8 | 16;
  /**
   * #43 edge-aware penumbra reconstruction of the SOFT visibility field.
   *
   * All lengths are CSS px: the layer clamps `radius` into
   * `[0, 4]` CSS px (default 2), defaults `heightGate` to 0.5 CSS px, and
   * maps both through the dpr similarity transform EXACTLY ONCE (like
   * step/bias) — so a 2-CSS-px radius is a 2-CSS-px footprint at every
   * devicePixelRatio in the SUPPORTED display-DPR range `[1, 4]` (the
   * renderer's texel cost cap is sized `round(4 * 4)` = 16 texels exactly
   * for this; beyond DPR 4 the cap reduces the effective CSS footprint),
   * and edge preservation does not change with dpr.
   * `enabled` defaults true; hard-path frames (angularRadius 0 / samples 1)
   * always bypass the filter regardless of this option.
   */
  reconstruction?: { enabled?: boolean; radius?: number; heightGate?: number };
}

/**
 * Backend policy for the ASYNC `UkiboriDom.create()` path:
 *
 * - `"auto"` (default): WebGPU adapter/device are requested first; when they
 *   succeed, the #29/#31 `GpuScenePipeline` presents DIRECTLY to the overlay's
 *   WebGPU canvas (no readback, no 2D copy). Any init/render/device-loss
 *   failure switches ONCE to the honest CPU path (never retried) and records
 *   the reason in `DomDebugState.gpuFallbackReason`.
 * - `"cpu"`: the CPU reference path only; `navigator.gpu` is never touched.
 * - `"webgpu"`: WebGPU only. `UkiboriDom.create()` throws when the GPU path
 *   cannot be initialized (an explicit request is never silently downgraded).
 *
 * The SYNCHRONOUS constructor is always CPU (existing tests/compatibility
 * contract): passing `"webgpu"` there throws, and `"auto"` there means
 * "CPU now, GPU never requested by the constructor itself" — the GPU path
 * requires the async `create()`.
 */
export type DomBackend = "cpu" | "webgpu" | "auto";

/** The ACTUAL backend of the current render path (honest, post-fallback). */
export type DomRenderBackend = "cpu" | "webgpu";

/**
 * Host-side state of the last GPU-presented frame (debug/profiling signal).
 *
 * `frame` retains the labeled host measurements and exposes an asynchronous
 * timestamp-query promise. `gpuTiming` is populated after its real GPU
 * readback finishes; unsupported/no-work/failure remain explicit states.
 * `hostRenderMs` is the whole dom-layer `render()` call that submitted the
 * frame and is not GPU completion latency.
 */
export interface DomGpuFrameState {
  /** the full structured per-frame pipeline stats of the last GPU render */
  readonly frame: GpuScenePipelineFrameStats;
  /** host wall-clock ms of the whole dom-layer render() that produced the frame */
  readonly hostRenderMs: number;
  /** resolved real GPU pass timing for this frame; null while readback is pending */
  readonly gpuTiming: GpuTimestampFrameResult | null;
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
  /** #46 debug seam: wall-clock ms of the last render's DOM measurement loop */
  lastMeasureMs: number;
  /** #46 debug seam: wall-clock ms of the last render's scene build */
  lastSceneBuildMs: number;
  /** #46 debug seam: entries measured by the last render's measurement loop */
  lastMeasuredEntries: number;
  /**
   * #46 frame-local provenance serials: a consumer compares these before/
   * after a render attempt to learn whether THIS frame ran the measurement
   * loop (`measureSerial`), the scene build (`sceneBuildSerial`) or any
   * render attempt at all (`renderSerial`). Stale previous-frame timings
   * must never be attributed to a frame that did not run the work.
   */
  renderSerial: number;
  measureSerial: number;
  sceneBuildSerial: number;
  /** width/height texels of the last render target */
  renderSize: { width: number; height: number } | null;
  /**
   * ACTUAL backend of the current render path — "cpu" after any GPU
   * init/render/device-loss fallback (a fallback is never silently retried).
   * Browser tests use this to prove gpu vs cpu.
   */
  backend: DomRenderBackend;
  /** honest reason WebGPU is not in use; null when `backend === "webgpu"` */
  gpuFallbackReason: string | null;
  /**
   * Last GPU frame's structured pipeline stats + host timing; null on the
   * CPU path. Never contains host copies of GPU pixels.
   */
  gpuFrame: DomGpuFrameState | null;
  /**
   * Bounded history of device `uncapturederror` messages from the WebGPU
   * path (oldest first). These errors would otherwise fail silently (no-ops
   * with healthy stats), so they are captured verbatim for diagnosis.
   */
  gpuDiagnostics: readonly string[];
}
