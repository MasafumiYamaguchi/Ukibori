import { createScene, DEFAULT_LIGHT_DIRECTION, normalizeVec3 } from "ukibori-renderer";
import type { Material, Scene, SurfaceNode } from "ukibori-renderer";
import { renderTargetSize } from "./coords";
import type { SurfaceRegistry } from "./registry";
import type { DomEnvironmentState, DomLightState, Region } from "./types";

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
 *   SDF cache (#19) still hits
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
    surfaces.push({
      id: options.id,
      position: {
        x: (geo.x - region.x) * dpr,
        y: (geo.y - region.y) * dpr,
      },
      size: {
        x: geo.w * dpr,
        y: geo.h * dpr,
      },
      elevation: sanitizeNonNegative(options.elevation) * dpr,
      thickness: sanitizeNonNegative(options.thickness) * dpr,
      bevelWidth: sanitizeNonNegative(options.bevelWidth ?? 0) * dpr,
      shape:
        options.shape.kind === "mask"
          ? { kind: "mask", mask: options.shape.mask }
          : { kind: "roundedRect", radius: geo.radius * dpr },
      profile: options.profile ?? { kind: "bevel" },
      material: options.material,
      castsShadow: options.castsShadow ?? true,
      receivesShadow: options.receivesShadow ?? true,
    });
  }
  const direction = normalizeVec3(light.direction, DEFAULT_LIGHT_DIRECTION);
  return createScene({
    width,
    height,
    surfaces,
    materials,
    light: { direction, intensity: sanitizeNonNegative(light.intensity) },
    environment: input.environment,
    exposure: input.exposure,
  });
}

function sanitizeNonNegative(v: number): number {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}
