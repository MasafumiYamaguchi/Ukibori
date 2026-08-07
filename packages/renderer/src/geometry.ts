import { HostBuffer } from "./buffer";
import { composeHeightField } from "./compose";
import { evaluateProfile } from "./profile";
import type { Scene, SurfaceNode } from "./scene";
import type { Vec2 } from "./types";

/**
 * #14 geometry: analytic SDF -> height field.
 *
 * Sign convention (fixed here, shared by every later issue):
 *
 *     distance < 0  inside the shape
 *     distance == 0 on the boundary
 *     distance > 0  outside the shape
 *
 * The height pipeline per surface is:
 *
 *     distance = sdf(shape, p)
 *     localHeight = profile(distance, bevelWidth, thickness)
 *     H = elevation + localHeight
 *
 * Profiles are standalone descriptors evaluated by `evaluateProfile`; the
 * SDF implementation never contains profile math.
 */

/**
 * Analytic signed distance of the standard rounded box (Inigo Quilez
 * sdRoundBox), at a continuous scene position:
 *
 *     r = min(radius, halfW, halfH)
 *     q = abs(p - center) - halfExtent + r
 *     d = length(max(q, 0)) + min(max(q.x, q.y), 0) - r
 *
 * `radius` is clamped to `min(radius, width/2, height/2)`, matching CSS
 * rounded-rect / border-radius behavior and the `flatRoundedRectHeight`
 * fixture. The `min(max(q), 0)` term is required so interior points near flat
 * edges get the correct distance to the edge (the naive `length(max(q,0)) -
 * r` underestimates interior distances). The result is finite for all finite
 * inputs.
 */
export function roundedRectSdf(
  position: Vec2,
  size: Vec2,
  radius: number,
  x: number,
  y: number,
): number {
  const halfW = size.x / 2;
  const halfH = size.y / 2;
  const r = Math.min(radius, halfW, halfH);
  const px = x - (position.x + halfW);
  const py = y - (position.y + halfH);
  const qx = Math.abs(px) - halfW + r;
  const qy = Math.abs(py) - halfH + r;
  const outer = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inner = Math.min(Math.max(qx, qy), 0);
  return outer + inner - r;
}

/**
 * Surface height at a continuous scene position (CPU reference geometry for
 * `composeHeightField`).
 *
 * Coverage is the SHAPE INTERIOR `distance < 0` and is independent of local
 * height: a surface with `thickness = 0` still exists at `H = elevation`
 * inside its footprint. The footprint equals `SurfaceNode.position/size`
 * (the bevel rises inward, it never extends outside the shape).
 *
 * Returns `elevation + localHeight` inside the coverage and `-Infinity`
 * outside (the scene composition contract from #13).
 *
 * Only `roundedRect` shapes are supported; `mask` shapes return `-Infinity`
 * (they arrive in the glyph issue #19).
 */
export function roundedRectSurfaceHeight(surface: SurfaceNode, x: number, y: number): number {
  if (surface.shape.kind !== "roundedRect") {
    return -Infinity;
  }
  const distance = roundedRectSdf(
    surface.position,
    surface.size,
    surface.shape.radius,
    x,
    y,
  );
  if (distance >= 0) {
    return -Infinity;
  }
  const local = evaluateProfile(
    surface.profile,
    distance,
    surface.bevelWidth ?? 0,
    surface.thickness ?? 0,
  );
  return surface.elevation + local;
}

/** Compose the full scene height field through the SDF geometry. */
export function composeSdfHeightField(scene: Scene) {
  return composeHeightField(scene, roundedRectSurfaceHeight);
}

export interface SdfDebugBuffers {
  /**
   * f32: signed distance at pixel centers for `scene.surfaces[0]`
   * (single-surface debug; multi-surface comes in the scene issue #18)
   */
  sdf: HostBuffer;
  /** f32: 1.0 inside the shape, 0.0 outside */
  mask: HostBuffer;
  /** f32: composed scene height (elevation + profile) */
  height: HostBuffer;
}

/**
 * Human-checkable intermediate buffers for the SDF -> height pipeline.
 * `sdf` and `mask` cover only the first surface; `height` is the composed
 * scene field.
 */
export function generateSdfDebug(scene: Scene): SdfDebugBuffers {
  const { width, height } = scene;
  const sdf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  const mask = new HostBuffer({ width, height, channels: 1, format: "f32" });
  const primary = scene.surfaces[0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (primary !== undefined && primary.shape.kind === "roundedRect") {
        const d = roundedRectSdf(
          primary.position,
          primary.size,
          primary.shape.radius,
          x + 0.5,
          y + 0.5,
        );
        sdf.set(x, y, 0, d);
        mask.set(x, y, 0, d < 0 ? 1 : 0);
      } else {
        sdf.set(x, y, 0, 0);
        mask.set(x, y, 0, 0);
      }
    }
  }
  return { sdf, mask, height: composeSdfHeightField(scene).height };
}
