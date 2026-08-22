import { HostBuffer } from "./buffer";
import { clamp } from "./math";
import { NO_OWNER } from "./compose";
import { VISIBILITY_SPEC } from "./types";
import type { Scene } from "./scene";
import {
  computeSoftSampleDirections,
  sanitizeAngularRadius,
  sanitizeShadowSamples,
} from "./shadow-sampling";

/**
 * #17 shadow: height-field ray-traced cast shadows.
 *
 * Visibility is decided by marching a ray from the receiver point `P =
 * (px, py, H(px, py))` toward the light along `DirectionalLight.direction`
 * (the #13 convention: direction points TOWARD the light), sampling the
 * height field along the way:
 *
 *     for k = 1 .. floor(maxDistance / stepSize):
 *         t        = f32(k * stepSize)        (explicit f32-multiple series)
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
 * - MARCH SERIES (explicit f32 convention, fixed with the #27 shadow pass):
 *   the series is `t_k = f32(k * stepSize)` for `k = 1 .. floor(maxDistance /
 *   stepSize)` — the f32-rounded integer multiple, exactly the series the
 *   GPU shadow shader marches (`f32(stepIndex) * params.stepSize`, identical
 *   for every k <= 2^24). This keeps a NON-DYADIC step like 0.1 on the SAME
 *   series in both implementations; a naive f64 accumulation
 *   (`t += stepSize`) would drift by up to 1 ulp per step and is NOT used.
 * - termination: marching stops when the sample leaves the scene rectangle,
 *   when the ray rises above `maxHeight + bias` (nothing can occlude it
 *   anymore), or after `floor(maxDistance / stepSize)` steps; option
 *   sanitization applies the same 2^24 iteration cap as the GPU pass
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
  /**
   * #41 area-light sample count for SOFT cast shadows: one of {1, 4, 8, 16}
   * (deterministic golden-angle disk pattern). Only effective when the scene
   * light carries `angularRadius > 0`; otherwise the historical single-ray
   * hard-shadow path runs regardless. Invalid values fall back to 8. Powers
   * of two keep `visible/samples` exactly representable, so CPU and GPU
   * visibility values are identical without tolerance.
   */
  samples?: number;
}

/** Shadow-pass options including the ownership/caster buffers (#18 castsShadow/receivesShadow). */
export interface VisibilityOptions extends ShadowOptions {
  /**
   * Ownership buffer (u32, NO_OWNER = base plane) from the FULL composed
   * scene. When provided, a pixel owned by a surface with
   * `receivesShadow = false` keeps visibility 1.
   */
  objectId?: HostBuffer;
  /**
   * Caster-only height field (#18): composed from surfaces with
   * `castsShadow = true` only (see `composeCasterHeightField`). Shadow
   * occlusion samples this field bilinearly, so non-casting top surfaces
   * never hide lower casting surfaces and boundaries follow bilinear height
   * semantics. Defaults to `height` when omitted (all surfaces cast).
   */
  casterHeight?: HostBuffer;
  /**
   * DPR-aware render extent sampling (#27): render texel (tx, ty) samples
   * logical scene position `((tx + 0.5) / dpr, (ty + 0.5) / dpr)` while
   * `stepSize`/`bias`/`maxDistance` stay in scene units, so the shadow
   * result is resolution-independent (only the sampling density changes).
   * Default `1` preserves the historical DPR-1 behavior exactly; the
   * default `maxDistance` scene diagonal is then derived from the LOGICAL
   * scene extent (`hypot(width / dpr, height / dpr)` over the render
   * buffer), which equals the historical `hypot(width, height)` at DPR 1.
   */
  dpr?: number;
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
  /** render extent sampling DPR (default 1; texel centers divide by dpr) */
  dpr: number;
  /** field used for occlusion sampling (caster-only field, or the full height) */
  sampleHeight: HostBuffer;
  /** ownership buffer for receivesShadow (null = everything receives) */
  objectId: HostBuffer | null;
  /**
   * #41 sanitized area-light sample count ({1,4,8,16}); `1` (or an
   * `angularRadius` of 0) selects the historical hard-shadow path.
   */
  samples: number;
  /** #41 f32 light angular radius in radians (0 = hard path) */
  angularRadius: number;
  /**
   * #41 packed f32 cone sample directions `[x0,y0,z0, ...]` shared with the
   * GPU uniform; null when the hard path is active.
   */
  sampleDirs: Float32Array | null;
}

const DEFAULT_STEP_SIZE = 0.5;
const DEFAULT_BIAS = 0.5;
const DEFAULT_DPR = 1;
/** Must stay equal to the #27 GPU host/shader f32-index termination cap. */
const MAX_CPU_SHADOW_STEP_COUNT = 1 << 24;

export function prepareShadowContext(
  scene: Scene,
  height: HostBuffer,
  options: VisibilityOptions = {},
): ShadowContext {
  const { width, height: h } = height.spec;
  // Every option is f32-packed (Math.fround) BEFORE use — exactly like the
  // #27 shadow pass sanitizer — so the CPU reference marches the SAME
  // effective values (stepSize/maxDistance/bias/dpr) as the GPU for any
  // raw input, and the explicit f32-multiple series t = fround(k *
  // stepSize) is identical on both sides.
  let stepSize = sanitizeF32StrictPositive(options.stepSize, DEFAULT_STEP_SIZE);
  const bias = sanitizeF32NonNegative(options.bias, DEFAULT_BIAS);
  // DPR-aware render extent sampling (#27); default 1 keeps the historical
  // behavior. The scene diagonal used for the default maxDistance stays in
  // SCENE units: at DPR d the render buffer covers width/d x height/d scene
  // units, and at dpr 1 this reduces to the historical hypot(width, height).
  const dpr = sanitizeF32StrictPositive(options.dpr, DEFAULT_DPR);
  const lx = scene.light.direction.x;
  const ly = scene.light.direction.y;
  const lz = scene.light.direction.z;
  const xyLength = Math.hypot(lx, ly);
  const diagonal = Math.hypot(width / dpr, h / dpr);
  const defaultMaxDistance = Math.fround(
    xyLength > 1e-6 ? diagonal / xyLength : diagonal,
  );
  let maxDistance = sanitizeF32StrictPositive(options.maxDistance, defaultMaxDistance);
  let stepCount = shadowStepCount(maxDistance, stepSize);
  if (stepCount > MAX_CPU_SHADOW_STEP_COUNT) {
    stepSize = DEFAULT_STEP_SIZE;
    stepCount = shadowStepCount(maxDistance, stepSize);
  }
  if (stepCount > MAX_CPU_SHADOW_STEP_COUNT) {
    maxDistance = defaultMaxDistance;
    stepCount = shadowStepCount(maxDistance, stepSize);
  }
  if (stepCount > MAX_CPU_SHADOW_STEP_COUNT) {
    throw new Error(
      `shadow step count ${stepCount} exceeds the termination cap ` +
        `${MAX_CPU_SHADOW_STEP_COUNT}: the scene diagonal/options are too large`,
    );
  }
  const sampleHeight = options.casterHeight ?? height;
  // #41 soft-shadow sampling state: the light's angular radius (radians,
  // f32-packed, 0 = hard) and the sanitized sample count. The cone
  // directions are computed ONCE here in f64/f32 exactly like the array the
  // GPU uniform packs, so both backends march identical f32 directions.
  const angularRadius = sanitizeAngularRadius(
    typeof scene.light.angularRadius === "number" ? scene.light.angularRadius : undefined,
  );
  const samples = sanitizeShadowSamples(options.samples);
  const sampleDirs =
    angularRadius > 0 && samples > 1
      ? computeSoftSampleDirections({ x: lx, y: ly, z: lz }, angularRadius, samples)
      : null;
  return {
    stepSize,
    bias,
    maxDistance,
    lx,
    ly,
    lz,
    maxHeight: sceneMaxHeight(sampleHeight),
    dpr,
    sampleHeight,
    objectId: options.objectId ?? null,
    samples: sampleDirs !== null ? samples : 1,
    angularRadius,
    sampleDirs,
  };
}

/**
 * Bilinear sample of the height field at a CONTINUOUS scene position.
 * Sample positions are clamped to the pixel-center range so rays never read
 * outside the buffer (texture-boundary policy: replicate the edge).
 *
 * `x`/`y` are DPR-1 scene positions (texel-center units); the DPR-aware
 * conversion to render-field interpolation coordinates is
 * `sampleHeightAtDpr` (`x * dpr - 0.5`).
 */
export function sampleHeightAt(height: HostBuffer, x: number, y: number): number {
  return bilinearHeightAt(height, x - 0.5, y - 0.5);
}

/**
 * DPR-aware bilinear sample (#27): takes a LOGICAL scene position and maps
 * it to render-field interpolation coordinates with the same center
 * convention — `fx = x * dpr - 0.5` (render texel `(tx, ty)` sits at
 * logical `((tx + 0.5) / dpr, (ty + 0.5) / dpr)`, so the receiver's own
 * texel maps back to `fx = tx` exactly). At `dpr = 1` this is identical to
 * `sampleHeightAt`. `dpr` must be finite and > 0 (the public options
 * sanitize it; internal callers pass the prepared context value).
 */
function sampleHeightAtDpr(height: HostBuffer, x: number, y: number, dpr: number): number {
  return bilinearHeightAt(height, x * dpr - 0.5, y * dpr - 0.5);
}

/** Row-major bilinear core over interpolation coordinates (clamped edges). */
function bilinearHeightAt(height: HostBuffer, fx: number, fy: number): number {
  const { width, height: h } = height.spec;
  const cx = clamp(fx, 0, width - 1);
  const cy = clamp(fy, 0, h - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const v00 = height.get(x0, y0, 0);
  const v10 = height.get(x1, y0, 0);
  const v01 = height.get(x0, y1, 0);
  const v11 = height.get(x1, y1, 0);
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Boolean-only, ZERO-ALLOCATION occlusion test for the production hot path.
 * Used by `computeVisibility` for every pixel. Occlusion samples the caster
 * height field (`ctx.sampleHeight`); the receiver z comes from the full
 * visible height field.
 *
 * NOTE: this function and `visibilityWithContext` implement the same
 * traversal; keep the occlusion math in sync.
 */
export function isOccludedWithContext(
  ctx: ShadowContext,
  height: HostBuffer,
  px: number,
  py: number,
): boolean {
  return marchOccludedAlong(ctx, height, px, py, ctx.lx, ctx.ly, ctx.lz);
}

/**
 * The #17 march along ONE explicit light direction (the shared hot path for
 * the hard ray and every #41 area-light cone sample). Bounds checks, the
 * f32-multiple march series, the maxHeight early exit and the strict f32
 * comparison mirror shadow-pass-wgsl line by line; passing the CENTER light
 * reproduces the historical hard-shadow result exactly.
 */
function marchOccludedAlong(
  ctx: ShadowContext,
  height: HostBuffer,
  px: number,
  py: number,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  const { width, height: h } = height.spec;
  // The receiver z is the full visible field at the LOGICAL receiver
  // position; at the render-texel center this is exactly the composed texel
  // value (fx = px * dpr - 0.5 = tx).
  const rz0 = Math.fround(sampleHeightAtDpr(height, px, py, ctx.dpr));
  // Inclusive pixel-center rectangle in LOGICAL scene units: render texel
  // (tx, ty) spans logical [(tx + 0.5) / dpr, (tx + 1.5) / dpr), so the
  // rectangle runs from the first texel center `0.5 / dpr` to the LAST
  // texel center `(extent - 0.5) / dpr` (mirrors the WGSL bound exactly).
  // At dpr 1 this is the historical [0.5, width - 0.5] texel-center range.
  const left = 0.5 / ctx.dpr;
  const right = (width - 0.5) / ctx.dpr;
  const top = 0.5 / ctx.dpr;
  const bottom = (h - 0.5) / ctx.dpr;
  // Explicit f32-multiple march series (see the module doc): t = fround(k *
  // stepSize), the exact series the GPU shadow shader marches; the count is
  // floor(maxDistance / stepSize), matching the shadow pass stepCount.
  const stepCount = Math.floor(ctx.maxDistance / ctx.stepSize);
  for (let k = 1; k <= stepCount; k++) {
    const t = Math.fround(k * ctx.stepSize);
    const sx = px + dx * t;
    const sy = py + dy * t;
    if (sx < left || sx > right || sy < top || sy > bottom) {
      break;
    }
    const rayZ = Math.fround(rz0 + dz * t);
    if (rayZ > ctx.maxHeight + ctx.bias) {
      break;
    }
    const sample = Math.fround(sampleHeightAtDpr(ctx.sampleHeight, sx, sy, ctx.dpr));
    if (sample > Math.fround(rayZ + ctx.bias)) {
      return true;
    }
  }
  return false;
}

/**
 * #41 visibility at one receiver position: `0/1` on the hard path (center
 * direction only) or the deterministic fraction of unoccluded cone samples.
 * The fraction is an exactly representable dyadic rational because the
 * sanitized sample counts are powers of two, so CPU and GPU agree bit-for-bit.
 */
function visibilityWithContext(
  ctx: ShadowContext,
  height: HostBuffer,
  px: number,
  py: number,
): number {
  const dirs = ctx.sampleDirs;
  if (dirs === null) {
    return marchOccludedAlong(ctx, height, px, py, ctx.lx, ctx.ly, ctx.lz) ? 0 : 1;
  }
  let visible = 0;
  for (let i = 0; i < ctx.samples; i++) {
    if (
      !marchOccludedAlong(
        ctx,
        height,
        px,
        py,
        dirs[i * 3],
        dirs[i * 3 + 1],
        dirs[i * 3 + 2],
      )
    ) {
      visible += 1;
    }
  }
  return visible / ctx.samples;
}

/**
 * Summary trace with scalar per-step state: the result object is allocated
 * exactly once on return. Used by `traceShadowRay`.
 */
function traceWithContext(
  ctx: ShadowContext,
  height: HostBuffer,
  px: number,
  py: number,
): ShadowRayResult {
  const { width, height: h } = height.spec;
  const rz0 = Math.fround(sampleHeightAtDpr(height, px, py, ctx.dpr));
  const left = 0.5 / ctx.dpr;
  const right = (width - 0.5) / ctx.dpr;
  const top = 0.5 / ctx.dpr;
  const bottom = (h - 0.5) / ctx.dpr;
  let lastT = 0;
  let lastX = px;
  let lastY = py;
  let lastSample = rz0;
  let lastRayZ = rz0;
  let occluded = false;
  const stepCount = Math.floor(ctx.maxDistance / ctx.stepSize);
  for (let k = 1; k <= stepCount; k++) {
    const t = Math.fround(k * ctx.stepSize);
    const sx = px + ctx.lx * t;
    const sy = py + ctx.ly * t;
    if (sx < left || sx > right || sy < top || sy > bottom) {
      break;
    }
    const rayZ = Math.fround(rz0 + ctx.lz * t);
    if (rayZ > ctx.maxHeight + ctx.bias) {
      break;
    }
    const sample = Math.fround(sampleHeightAtDpr(ctx.sampleHeight, sx, sy, ctx.dpr));
    lastT = t;
    lastX = sx;
    lastY = sy;
    lastSample = sample;
    lastRayZ = rayZ;
    if (sample > Math.fround(rayZ + ctx.bias)) {
      occluded = true;
      break;
    }
  }
  return {
    occluded,
    t: lastT,
    sampleX: lastX,
    sampleY: lastY,
    blockingHeight: lastSample,
    rayZ: lastRayZ,
  };
}

/**
 * Sample-collecting march (debug visualization only): returns every marched
 * sample, including the blocking one. NOT used by `computeVisibility`.
 */
function marchWithContext(
  ctx: ShadowContext,
  height: HostBuffer,
  px: number,
  py: number,
): ShadowMarchSample[] {
  const { width, height: h } = height.spec;
  const rz0 = Math.fround(sampleHeightAtDpr(height, px, py, ctx.dpr));
  const left = 0.5 / ctx.dpr;
  const right = (width - 0.5) / ctx.dpr;
  const top = 0.5 / ctx.dpr;
  const bottom = (h - 0.5) / ctx.dpr;
  const samples: ShadowMarchSample[] = [];
  const stepCount = Math.floor(ctx.maxDistance / ctx.stepSize);
  for (let k = 1; k <= stepCount; k++) {
    const t = Math.fround(k * ctx.stepSize);
    const sx = px + ctx.lx * t;
    const sy = py + ctx.ly * t;
    if (sx < left || sx > right || sy < top || sy > bottom) {
      break;
    }
    const rayZ = Math.fround(rz0 + ctx.lz * t);
    if (rayZ > ctx.maxHeight + ctx.bias) {
      break;
    }
    const sample = Math.fround(sampleHeightAtDpr(ctx.sampleHeight, sx, sy, ctx.dpr));
    const occluded = sample > Math.fround(rayZ + ctx.bias);
    samples.push({ t, sampleX: sx, sampleY: sy, height: sample, rayZ, occluded });
    if (occluded) {
      break;
    }
  }
  return samples;
}

/** Trace one shadow ray from a continuous receiver position (zero-history). */
export function traceShadowRay(
  scene: Scene,
  height: HostBuffer,
  px: number,
  py: number,
  options: VisibilityOptions = {},
): ShadowRayResult {
  return traceWithContext(prepareShadowContext(scene, height, options), height, px, py);
}

/** All marched samples of one ray (including the blocking sample, if any). */
export function marchShadowRay(
  scene: Scene,
  height: HostBuffer,
  px: number,
  py: number,
  options: VisibilityOptions = {},
): ShadowMarchSample[] {
  return marchWithContext(prepareShadowContext(scene, height, options), height, px, py);
}

/**
 * Cast-shadow visibility for every pixel in `[0, 1]`: `1` = fully lit, `0` =
 * fully occluded, and (with #41 area-light sampling) every intermediate
 * fraction of unoccluded cone samples. Pixels are sampled at pixel centers
 * `(x + 0.5, y + 0.5)` with the pixel's own height from the full visible
 * field as the receiver z (f32 semantics). Occlusion samples the caster-only
 * height field (`options.casterHeight`, see #18). Pass-wide state is
 * prepared once and shared by all pixel traces; the boolean-only march hot
 * path keeps the loop allocation-free.
 *
 * With an `objectId` buffer (#18): a pixel owned by a surface with
 * `receivesShadow = false` always keeps visibility 1.
 *
 * Hard/soft selection (#41): when the scene light carries
 * `angularRadius > 0` and `samples > 1`, each texel evaluates the deterministic
 * golden-angle disk cone around the center direction and writes the lit
 * fraction; otherwise the historical single-ray hard path runs with
 * byte-identical results.
 */
export function computeVisibility(
  scene: Scene,
  height: HostBuffer,
  options: VisibilityOptions = {},
): HostBuffer {
  const ctx = prepareShadowContext(scene, height, options);
  const { width, height: h } = height.spec;
  const out = new HostBuffer(VISIBILITY_SPEC(width, h));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      // DPR-aware sampling (#27): texel (x, y) samples the logical scene
      // position ((x + 0.5) / dpr, (y + 0.5) / dpr); at dpr 1 this is the
      // historical pixel-center convention.
      const px = (x + 0.5) / ctx.dpr;
      const py = (y + 0.5) / ctx.dpr;
      let vis = 1;
      if (ctx.objectId !== null) {
        const ownOwner = ctx.objectId.get(x, y, 0);
        const receives = ownOwner === NO_OWNER
          ? true
          : (scene.surfaces[ownOwner]?.receivesShadow ?? true);
        if (receives) {
          vis = visibilityWithContext(ctx, height, px, py);
        }
      } else {
        vis = visibilityWithContext(ctx, height, px, py);
      }
      out.set(x, y, 0, vis);
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

/**
 * f32-packed strict-positive sanitizer: accepts only values whose f32
 * rounding is finite and strictly positive (mirrors the #27 shadow pass
 * sanitizer, so the CPU reference uses the exact values the GPU packs).
 */
function sanitizeF32StrictPositive(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  const rounded = Math.fround(v);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : fallback;
}

function shadowStepCount(maxDistance: number, stepSize: number): number {
  const quotient = maxDistance / stepSize;
  if (!Number.isFinite(quotient) || quotient <= 0) {
    return MAX_CPU_SHADOW_STEP_COUNT + 1;
  }
  const count = Math.floor(quotient);
  return Number.isSafeInteger(count) ? count : MAX_CPU_SHADOW_STEP_COUNT + 1;
}

/** f32-packed non-negative sanitizer (bias/dpr-like options). */
function sanitizeF32NonNegative(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  const rounded = Math.fround(v);
  return Number.isFinite(rounded) && rounded >= 0 ? rounded : fallback;
}
