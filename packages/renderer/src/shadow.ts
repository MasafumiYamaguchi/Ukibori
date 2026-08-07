import { HostBuffer } from "./buffer";
import { clamp } from "./math";
import { VISIBILITY_SPEC } from "./types";
import type { Scene } from "./scene";

/**
 * #17 shadow: height-field ray-traced cast shadows.
 *
 * Visibility is decided by marching a ray from the receiver point `P =
 * (px, py, H(px, py))` toward the light along `DirectionalLight.direction`
 * (the #13 convention: direction points TOWARD the light), sampling the
 * height field along the way:
 *
 *     for t = step .. maxDistance:
 *         sampleXY = P.xy + L.xy * t
 *         rayZ     = P.z  + L.z  * t
 *         if H(sampleXY) > rayZ + bias:  occluded
 *
 * This is NOT a CSS offset/blur or a translated silhouette: occlusion is a
 * real visibility test on the height field. `box-shadow` / `drop-shadow` are
 * never used.
 *
 * Design decisions (fixed here):
 *
 * - sampling: the height field is bilinearly interpolated at the continuous
 *   sample position (pixel-center semantics from #13)
 * - step size: default 0.5 scene units; smaller = more accurate, slower
 * - bias: self-shadow acne bias, default 0.5 scene units; larger suppresses
 *   self-shadowing on shallow slopes
 * - termination: marching stops when the sample leaves the scene rectangle,
 *   or when the ray rises above the scene's maximum height + bias (nothing
 *   can occlude it anymore), or at `maxDistance` (default: the scene
 *   diagonal) as a safety cap
 * - grazing stability: the early exit on `maxHeight + bias` and the
 *   bounds check keep near-horizontal rays from marching forever
 * - values are rounded to f32 at the comparison point, matching the WebGPU
 *   pipeline semantics
 *
 * The result is a hard 0/1 visibility mask; soft shadows are a future
 * extension on top of this mask.
 */

export interface ShadowOptions {
  /** ray march step in scene units (default 0.5, must be > 0) */
  stepSize?: number;
  /** maximum march distance in scene units (default: scene diagonal) */
  maxDistance?: number;
  /** self-shadow acne bias in scene units (default 0.5, must be >= 0) */
  bias?: number;
}

export interface ShadowRayResult {
  occluded: boolean;
  /** march distance of the last evaluated sample */
  t: number;
  sampleX: number;
  sampleY: number;
  /** height at the blocking sample (or the last evaluated sample) */
  blockingHeight: number;
  /** ray z at that sample */
  rayZ: number;
}

const DEFAULT_STEP_SIZE = 0.5;
const DEFAULT_BIAS = 0.5;

/**
 * Bilinear sample of the height field at a CONTINUOUS scene position.
 * Sample positions are clamped to the pixel-center range so rays never read
 * outside the buffer (texture-boundary policy: replicate the edge).
 */
export function sampleHeightAt(height: HostBuffer, x: number, y: number): number {
  const { width, height: h } = height.spec;
  const fx = clamp(x - 0.5, 0, width - 1);
  const fy = clamp(y - 0.5, 0, h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = height.get(x0, y0, 0);
  const v10 = height.get(x1, y0, 0);
  const v01 = height.get(x0, y1, 0);
  const v11 = height.get(x1, y1, 0);
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

/** Trace one shadow ray from a continuous receiver position. */
export function traceShadowRay(
  scene: Scene,
  height: HostBuffer,
  px: number,
  py: number,
  options: ShadowOptions = {},
): ShadowRayResult {
  const { width, height: h } = height.spec;
  const stepSize = sanitizeStrictPositive(options.stepSize, DEFAULT_STEP_SIZE);
  const bias = sanitizeNonNegative(options.bias, DEFAULT_BIAS);
  const maxDistance = sanitizeStrictPositive(
    options.maxDistance,
    Math.hypot(width, h),
  );
  const maxHeight = sceneMaxHeight(height);
  const lx = scene.light.direction.x;
  const ly = scene.light.direction.y;
  const lz = scene.light.direction.z;
  const rz0 = Math.fround(sampleHeightAt(height, px, py));

  let last: ShadowRayResult = {
    occluded: false,
    t: 0,
    sampleX: px,
    sampleY: py,
    blockingHeight: rz0,
    rayZ: rz0,
  };
  for (let t = stepSize; t <= maxDistance; t += stepSize) {
    const sx = px + lx * t;
    const sy = py + ly * t;
    if (sx < 0.5 || sx > width - 0.5 || sy < 0.5 || sy > h - 0.5) {
      break;
    }
    const rayZ = Math.fround(rz0 + lz * t);
    if (rayZ > maxHeight + bias) {
      break;
    }
    const sample = Math.fround(sampleHeightAt(height, sx, sy));
    last = { occluded: false, t, sampleX: sx, sampleY: sy, blockingHeight: sample, rayZ };
    if (sample > rayZ + bias) {
      return { ...last, occluded: true };
    }
  }
  return last;
}

/**
 * Hard cast-shadow visibility mask for every pixel: 1 = lit, 0 = occluded.
 * Pixels are sampled at pixel centers `(x + 0.5, y + 0.5)` with the pixel's
 * own height as the receiver z (f32 semantics).
 */
export function computeVisibility(
  scene: Scene,
  height: HostBuffer,
  options: ShadowOptions = {},
): HostBuffer {
  const { width, height: h } = height.spec;
  const out = new HostBuffer(VISIBILITY_SPEC(width, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const ray = traceShadowRay(scene, height, x + 0.5, y + 0.5, options);
      out.set(x, y, 0, ray.occluded ? 0 : 1);
    }
  }
  return out;
}

function sceneMaxHeight(height: HostBuffer): number {
  let max = 0;
  for (let y = 0; y < height.spec.height; y++) {
    for (let x = 0; x < height.spec.width; x++) {
      const v = height.get(x, y, 0);
      if (Number.isFinite(v) && v > max) {
        max = v;
      }
    }
  }
  return max;
}

function sanitizeStrictPositive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

function sanitizeNonNegative(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}
