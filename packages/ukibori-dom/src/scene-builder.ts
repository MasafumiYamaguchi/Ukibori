import { createScene, DEFAULT_LIGHT_DIRECTION, normalizeVec3 } from "ukibori-renderer";
import type { Material, Scene, SurfaceNode } from "ukibori-renderer";
import { renderTargetSize } from "./coords";
import type { SurfaceRegistry } from "./registry";
import type { DomEnvironmentState, DomLightState, Region } from "./types";
import { rasterizeSvgPath, SvgPathRasterCache, svgPathRasterKey } from "./svg-path";
import type { DomShape } from "./types";

interface SvgPathMaskCache {
  get(key: string): ReturnType<typeof rasterizeSvgPath> | undefined;
  set(key: string, value: ReturnType<typeof rasterizeSvgPath>): void;
}

// Cache by the quality policy, path descriptor, and effective integer device
// footprint. CSS/DPR values are intentionally represented only by that
// footprint: retained light/material updates reuse the exact same immutable
// MaskSource, and subpixel layout changes that do not change the footprint do
// not retain redundant rasters.
const defaultSvgMaskCache = new SvgPathRasterCache();

/**
 * DOM -> renderer scene construction (#20).
 *
 * Preserves every renderer semantic fixed by #13–#19:
 *
 * - scene `width`/`height` are positive integers (render-target texels)
 * - `devicePixelRatio` is applied ONLY here: the grid is
 *   `floor(region.w * dpr)` texels and every surface coordinate is scaled by
 *   `dpr` (positions/sizes/radius/bevel/thickness/elevation). The light
 *   direction is dimensionless and is NOT scaled. Length-valued shadow
 *   parameters are mapped through the same transform by `scaleShadowOptions`.
 * - surface `elevation` stays ABSOLUTE scene z (no parent-relative
 *   resolution, no z-index); the DOM layer does not reinterpret it
 * - mask shapes keep their `MaskSource` identity so the renderer's per-mask
 *   SDF cache (#19) still hits; SVG path authoring shapes are rasterized here
 *   (and cached by quality/path/viewBox/fillRule/effective device footprint)
 *   before reaching the
 *   renderer
 * - shadow flags are passed through unchanged (#18)
 *
 * Non-renderable nodes: a registered element whose measured footprint has
 * zero / non-positive width or height (e.g. `display: none`, detached, or
 * still laying out) is a TEMPORARILY NON-RENDERABLE scene node — it is
 * skipped here (and by `computeRegion`), it never reaches the renderer, and
 * it rejoins the scene as soon as it becomes measurable again. It does not
 * abort the render of the visible surfaces.
 *
 * `createScene` re-validates structural invariants (duplicate ids, isotropic
 * masks, unknown materials, finite non-negative values) and throws on
 * programmer errors.
 */

export interface BuildSceneInput {
  registry: SurfaceRegistry;
  region: Region;
  dpr: number;
  light: DomLightState;
  /** shared environment illumination state (#22); absent fields -> renderer
   * defaults (intensity 0.5, shares 1) */
  environment?: Partial<DomEnvironmentState>;
  /** exposure multiplier (dimensionless). `undefined` -> renderer default 1. */
  exposure?: number;
  materials?: Record<string, Material>;
  /** Internal layer-owned cache; omitted callers use a bounded fallback. */
  svgPathCache?: SvgPathMaskCache;
}

export function buildScene(input: BuildSceneInput): Scene {
  const { registry, region, dpr, light, materials } = input;
  const { width, height } = renderTargetSize(region, dpr);
  const surfaces: SurfaceNode[] = [];
  for (const entry of registry.entries()) {
    if (entry.geometry === null) {
      continue;
    }
    const geo = entry.geometry;
    // Zero / non-positive footprint: temporarily non-renderable (hidden or
    // detached element), not a fatal surface — skip until it measures again.
    if (!(geo.w > 0) || !(geo.h > 0)) {
      continue;
    }
    const options = entry.options;
    // SVG masks have an integer device footprint. The renderer intentionally
    // requires mask mapping to be isotropic, so use that same footprint as
    // the physical surface size. This quantizes only SVG's device-space
    // footprint (at most half a device pixel per axis); positions, region,
    // and all non-SVG geometry retain the CSS-geometry × DPR contract. It
    // also makes a subpixel layout change that keeps the effective footprint
    // unchanged a true retained update: both mask and surface size stay put.
    const svgMask = options.shape.kind === "svgPath"
      ? svgMaskFor(options.shape, geo.w, geo.h, dpr, input.svgPathCache ?? defaultSvgMaskCache)
      : null;
    surfaces.push({
      id: options.id,
      position: {
        x: (geo.x - region.x) * dpr,
        y: (geo.y - region.y) * dpr,
      },
      size: {
        x: svgMask?.width ?? geo.w * dpr,
        y: svgMask?.height ?? geo.h * dpr,
      },
      elevation: sanitizeNonNegative(options.elevation) * dpr,
      thickness: sanitizeNonNegative(options.thickness) * dpr,
      bevelWidth: sanitizeNonNegative(options.bevelWidth ?? 0) * dpr,
      shape:
        options.shape.kind === "mask"
          ? { kind: "mask", mask: options.shape.mask }
          : options.shape.kind === "svgPath"
            ? {
                kind: "mask",
                mask: svgMask!,
              }
            : { kind: "roundedRect", radius: geo.radius * dpr },
      profile: options.profile ?? { kind: "bevel" },
      material: options.material,
      castsShadow: options.castsShadow ?? true,
      receivesShadow: options.receivesShadow ?? true,
    });
  }
  const direction = normalizeVec3(light.direction, DEFAULT_LIGHT_DIRECTION);
  // #41: the angular radius is DIMENSIONLESS (radians) and is forwarded
  // unscaled — the dpr similarity transform applies to lengths only. The
  // renderer's createScene sanitizes it (finite >= 0 after f32 packing,
  // else 0 = hard shadow).
  const rawAngularRadius = input.light.angularRadius;
  const angularRadius =
    typeof rawAngularRadius === "number" && Number.isFinite(rawAngularRadius)
      ? rawAngularRadius
      : undefined;
  // #45: the directional-light color is DIMENSIONLESS (linear RGB, not a
  // length) — forwarded unscaled like direction/angularRadius; the renderer
  // sanitizes it (missing/non-finite/negative channels -> 1, HDR preserved).
  const rawColor = input.light.color;
  const color =
    rawColor === undefined
      ? undefined
      : {
          r: rawColor.r,
          g: rawColor.g,
          b: rawColor.b,
        };
  return createScene({
    width,
    height,
    surfaces,
    materials,
    light: {
      direction,
      intensity: sanitizeNonNegative(light.intensity),
      ...(angularRadius !== undefined ? { angularRadius } : {}),
      ...(color !== undefined ? { color } : {}),
    },
    environment: input.environment,
    exposure: input.exposure,
  });
}

function svgMaskFor(
  shape: Extract<DomShape, { kind: "svgPath" }>,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  cache: SvgPathMaskCache,
): ReturnType<typeof rasterizeSvgPath> {
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  const key = svgPathRasterKey(shape, width, height);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const mask = rasterizeSvgPath(shape, width, height);
  cache.set(key, mask);
  return mask;
}

function sanitizeNonNegative(v: number): number {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}
