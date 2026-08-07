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
 *         if H(sampleXY) > f32(rayZ + bias):  occluded
 *
 * This is NOT a CSS offset/blur or a translated silhouette: occlusion is a
 * real visibility test on the height field. `box-shadow` / `drop-shadow` are
 * never used.
 *
 * Resolution / devicePixelRatio contract:
 *
 * This CPU reference assumes **1 texel = 1 CSS scene unit**: texel (x, y)
 * samples the height field at scene position `(x + 0.5, y + 0.5)`. A
 * DPR-scaled backend renders into a buffer of `width = floor(sceneWidth *
 * dpr)` texels and maps texel centers to scene coordinates via
 *
 *     sceneX = (texelX + 0.5) / dpr
 *     sceneY = (texelY + 0.5) / dpr
 *     receiverZ = heightAt(texel)          (unchanged scene units)
 *
 * `stepSize`, `bias` and `maxDistance` stay in SCENE units (CSS pixels), so
 * the shadow result is resolution-independent — only the sampling density
 * changes with dpr.
 *
 * Design decisions (fixed here):
 *
 * - sampling: the height field is bilinearly interpolated at the continuous
 *   sample position (pixel-center semantics from #13)
 * - step size: default 0.5 scene units; smaller = more accurate, slower
 * - bias: self-shadow acne bias, default 0.5 scene units; larger suppresses
 *   self-shadowing on shallow slopes
 * - the occlusion comparison is f32-consistent: the height sample is stored
 *   f32 and the threshold `f32(rayZ + bias)` is rounded to f32 before the
 *   comparison, matching the WebGPU pipeline
 * - termination: marching stops when the sample leaves the scene rectangle,
 *   when the ray rises above `maxHeight + bias` (nothing can occlude it
 *   anymore), or at `maxDistance`
 * - default `maxDistance = sceneDiagonal / |L.xy|`: t advances along the
 *   NORMALIZED 3D light vector while XY advances by only `|L.xy| * t`, so a
 *   scene-diagonal XY traversal needs `sceneDiagonal / |L.xy|`. For a
 *   (near-)vertical light (`|L.xy| ~ 0`) there is no horizontal travel —
 *   the maxHeight early exit terminates upward rays and the scene diagonal
 *   is a harmless cap for downward ones
 * - grazing stability: the early exit on `maxHeight + bias` and the bounds
 *   check keep near-horizontal rays from marching forever
 *
 * The result is a hard 0/1 visibility mask; soft shadows are a future
 * extension on top of this mask.
 *
 * Pass-wide state (maxHeight, sanitized options, light data) is prepared
 * ONCE in `prepareShadowContext` and shared by every pixel trace.
 */

export interface ShadowOptions {
  /** ray march step in scene units (default 0.5, must be > 0) */
  stepSize?: number;
  /** maximum march distance in scene units (default: sceneDiagonal / |L.xy|) */
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

export interface ShadowMarchSample {
  t: number;
  sampleX: number;
  sampleY: number;
  /** f32 height at the sample */
  height: number;
  /** f32 ray z at the sample */
  rayZ: number;
  /** true for the blocking sample (the march stops there) */
  occluded: boolean;
}

/** Pass-wide shadow state, prepared once per `computeVisibility` call. */
export interface ShadowContext {
  stepSize: number;
  bias: number;
  maxDistance: number;
  lx: number;
  ly: number;
  lz: number;
  maxHeight: number;
}

const DEFAULT_STEP_SIZE = 0.5;
const DEFAULT_BIAS = 0.5;

export function prepareShadowContext(
  scene: Scene,
  height: HostBuffer,
  options: ShadowOptions = {},
): ShadowContext {
  const { width, height: h } = height.spec;
  const stepSize = sanitizeStrictPositive(options.stepSize, DEFAULT_STEP_SIZE);
  const bias = sanitizeNonNegative(options.bias, DEFAULT_BIAS);
  const lx = scene.light.direction.x;
  const ly = scene.light.direction.y;
  const lz = scene.light.direction.z;
  const xyLength = Math.hypot(lx, ly);
  const diagonal = Math.hypot(width, h);
  const maxDistance = sanitizeStrictPositive(
    options.maxDistance,
    xyLength > 1e-6 ? diagonal / xyLength : diagonal,
  );
  return { stepSize, bias, maxDistance, lx, ly, lz, maxHeight: sceneMaxHeight(height) };
}

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

interface MarchResult {
  samples: ShadowMarchSample[];
  blocked: ShadowRayResult;
}

function marchWithContext(
  ctx: ShadowContext,
  height: HostBuffer,
  px: number,
  py: number,
): MarchResult {
  const { width, height: h } = height.spec;
  const rz0 = Math.fround(sampleHeightAt(height, px, py));
  const samples: ShadowMarchSample[] = [];
  for (let t = ctx.stepSize; t <= ctx.maxDistance; t += ctx.stepSize) {
    const sx = px + ctx.lx * t;
    const sy = py + ctx.ly * t;
    if (sx < 0.5 || sx > width - 0.5 || sy < 0.5 || sy > h - 0.5) {
      break;
    }
    const rayZ = Math.fround(rz0 + ctx.lz * t);
    if (rayZ > ctx.maxHeight + ctx.bias) {
      break;
    }
    const sample = Math.fround(sampleHeightAt(height, sx, sy));
    const threshold = Math.fround(rayZ + ctx.bias);
    const occluded = sample > threshold;
    samples.push({ t, sampleX: sx, sampleY: sy, height: sample, rayZ, occluded });
    if (occluded) {
      return {
        samples,
        blocked: { occluded: true, t, sampleX: sx, sampleY: sy, blockingHeight: sample, rayZ },
      };
    }
  }
  const last = samples[samples.length - 1];
  return {
    samples,
    blocked: last
      ? {
          occluded: false,
          t: last.t,
          sampleX: last.sampleX,
          sampleY: last.sampleY,
          blockingHeight: last.height,
          rayZ: last.rayZ,
        }
      : { occluded: false, t: 0, sampleX: px, sampleY: py, blockingHeight: rz0, rayZ: rz0 },
  };
}

/** Trace one shadow ray from a continuous receiver position. */
export function traceShadowRay(
  scene: Scene,
  height: HostBuffer,
  px: number,
  py: number,
  options: ShadowOptions = {},
): ShadowRayResult {
  return marchWithContext(prepareShadowContext(scene, height, options), height, px, py).blocked;
}

/** All marched samples of one ray (including the blocking sample, if any). */
export function marchShadowRay(
  scene: Scene,
  height: HostBuffer,
  px: number,
  py: number,
  options: ShadowOptions = {},
): ShadowMarchSample[] {
  return marchWithContext(prepareShadowContext(scene, height, options), height, px, py).samples;
}

/**
 * Hard cast-shadow visibility mask for every pixel: 1 = lit, 0 = occluded.
 * Pixels are sampled at pixel centers `(x + 0.5, y + 0.5)` with the pixel's
 * own height as the receiver z (f32 semantics). Pass-wide state is prepared
 * once and shared by all pixel traces.
 */
export function computeVisibility(
  scene: Scene,
  height: HostBuffer,
  options: ShadowOptions = {},
): HostBuffer {
  const ctx = prepareShadowContext(scene, height, options);
  const { width, height: h } = height.spec;
  const out = new HostBuffer(VISIBILITY_SPEC(width, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const blocked = marchWithContext(ctx, height, x + 0.5, y + 0.5).blocked;
      out.set(x, y, 0, blocked.occluded ? 0 : 1);
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
