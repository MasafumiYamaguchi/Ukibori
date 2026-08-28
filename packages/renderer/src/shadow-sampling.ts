/**
 * #41 area-light soft-shadow sampling core.
 *
 * Soft cast shadows sample a finite apparent light size around the shared
 * directional light: every receiver texel evaluates the EXISTING #17/#27
 * height-field occlusion march along several deterministic light directions
 * inside a cone of half-angle `angularRadius` around the center direction
 * `L`, and writes the fraction of unoccluded samples as a continuous
 * `[0, 1]` visibility scalar:
 *
 *     visibleCount = Σ_i traceOcclusion(receiver, dir_i) == false ? 1 : 0
 *     visibility   = visibleCount / samples
 *
 * ## Determinism contract (fixed here)
 *
 * - Sample DIRECTIONS are computed on the HOST in f64 and rounded to f32 ONCE
 *   per dispatch; both the CPU oracle (`shadow.ts`) and the GPU shadow pass
 *   consume the exact same f32 direction components, so soft visibility is
 *   bit-comparable between backends.
 * - The disk pattern is the deterministic golden-angle (Vogel) sunflower:
 *   `r_i = sqrt((i + 0.5) / n)`, `θ_i = i * GOLDEN_ANGLE` — evenly spread,
 *   no per-frame randomness, no temporal noise, identical for identical
 *   inputs on every device.
 * - The tangent-frame basis `U`, `V` orthogonal to `L` is built from the
 *   smallest-component helper axis, so the frame is stable under f32 noise
 *   and depends ONLY on the light direction.
 * - Sample counts are restricted to { 1, 4, 8, 16 }: powers of two keep
 *   `visibleCount / samples` an exactly representable dyadic rational, so
 *   CPU and GPU visibility values are IDENTICAL without any rounding
 *   tolerance.
 *
 * ## Hard-shadow compatibility
 *
 * `angularRadius <= 0` or `samples <= 1` selects the historical single-ray
 * hard path (`visibility ∈ {0, 1}`) — callers must branch BEFORE consulting
 * these helpers, so existing hard-shadow semantics and fixtures stay
 * byte-identical.
 */

/** Hard upper bound of the sanitized sample count (uniform array capacity). */
export const SHADOW_MAX_SAMPLES = 16;

/** The documented candidate counts (powers of two; see the determinism note). */
export const ALLOWED_SHADOW_SAMPLES: readonly number[] = [1, 4, 8, 16];

/** Default sample count when `ShadowOptions.samples` is absent/invalid. */
export const DEFAULT_SHADOW_SAMPLES = 8;

/**
 * #43 deterministic kernel-variant count. Neighboring texels must not share
 * one orientation of the #41 Vogel disk, or the individual sampled shadow
 * silhouettes stay spatially coherent and read as several offset hard
 * shadows. The host precomputes EXACTLY this many f32 rotations of the disk
 * pattern; every texel selects one variant through `softKernelVariant` — a
 * stateless integer hash of its RENDER TEXEL coordinates — and both backends
 * consume byte-identical variant arrays, so raw visibility keeps its exact
 * CPU/GPU parity while sampling error becomes spatially decorrelated.
 */
export const SHADOW_KERNEL_VARIANTS = 8;

/** Golden angle (radians) driving the deterministic Vogel sunflower disk. */
const GOLDEN_ANGLE = 2.399963229728653;

/**
 * Angular step between two consecutive kernel variants: the full-circle
 * rotation of the Vogel pattern split into SHADOW_KERNEL_VARIANTS even
 * slices (f64 on the host; each variant's directions are f32-rounded ONCE,
 * exactly like the unrotated #41 pattern).
 */
export const KERNEL_VARIANT_ROTATION = (Math.PI * 2) / SHADOW_KERNEL_VARIANTS;

interface XYZ {
  x: number;
  y: number;
  z: number;
}

/**
 * Sanitize the requested sample count: only the documented candidate values
 * ({1, 4, 8, 16}) are accepted verbatim; every other input (non-finite,
 * non-integer, out of range) falls back to the default. The returned value
 * is always one of `ALLOWED_SHADOW_SAMPLES`.
 */
export function sanitizeShadowSamples(samples: number | undefined): number {
  if (
    typeof samples === "number" &&
    Number.isFinite(samples) &&
    (ALLOWED_SHADOW_SAMPLES as readonly number[]).includes(samples)
  ) {
    return samples;
  }
  return DEFAULT_SHADOW_SAMPLES;
}

/**
 * Sanitize the light angular radius (radians): finite >= 0 after f32 packing,
 * else 0 (the hard-shadow default). Mirrors the f32-packing policy of the
 * other shadow options so host and shader see identical values.
 */
export function sanitizeAngularRadius(angularRadius: number | undefined): number {
  if (typeof angularRadius !== "number" || !Number.isFinite(angularRadius)) {
    return 0;
  }
  const rounded = Math.fround(angularRadius);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
}

/** Deterministic Vogel/golden-angle point `i` of `n` inside the unit disk. */
function diskSample(i: number, n: number): { x: number; y: number } {
  const r = Math.sqrt((i + 0.5) / n);
  const theta = i * GOLDEN_ANGLE;
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

/**
 * #43 deterministic per-texel kernel-variant selection — the EXACT integer
 * hash mirrored by the WGSL shadow pass (`kernelVariant` in
 * `shadow-pass-wgsl.ts`). Stateless, frame-independent, no mutable RNG
 * state: the variant of render texel `(x, y)` is
 *
 *     h = (x + 1) * 0x9E3779B1 xor (y + 1) * 0x85EBCA77   (wrapping u32)
 *     h ^= h >> 15; h = h * 0x2545F491 (wrapping u32); h ^= h >> 13
 *     variant = h mod SHADOW_KERNEL_VARIANTS
 *
 * The +1 offsets keep the two lanes independent at (0, y)/(x, 0); both
 * multipliers are odd u32 constants so the wrapping multiplies are
 * invertible mixers (large low-bit avalanches after the shifts). JS uses
 * `Math.imul` + `>>> 0`, WGSL uses `u32` arithmetic — identical semantics,
 * and only INTEGER operations are involved, so no transcendental drift is
 * possible between backends.
 */
export function softKernelVariant(x: number, y: number): number {
  let h = (Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca77)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h % SHADOW_KERNEL_VARIANTS;
}

/** Stable orthonormal tangent basis `(u, v)` orthogonal to the unit light direction. */
export function orthoBasis(l: XYZ): { u: XYZ; v: XYZ } {
  // Helper axis = the axis of the SMALLEST |component| of L, so cross(H, L)
  // never degenerates for any unit L (including straight-down lights).
  const ax = Math.abs(l.x);
  const ay = Math.abs(l.y);
  const az = Math.abs(l.z);
  let hx = 0;
  let hy = 0;
  let hz = 0;
  if (ax <= ay && ax <= az) {
    hx = 1;
  } else if (ay <= az) {
    hy = 1;
  } else {
    hz = 1;
  }
  // u = normalize(H x L); v = L x u (already unit because L ⊥ u, |L| = 1).
  let ux = hy * l.z - hz * l.y;
  let uy = hz * l.x - hx * l.z;
  let uz = hx * l.y - hy * l.x;
  const ulen = Math.hypot(ux, uy, uz);
  ux /= ulen;
  uy /= ulen;
  uz /= ulen;
  return {
    u: { x: ux, y: uy, z: uz },
    v: {
      x: l.y * uz - l.z * uy,
      y: l.z * ux - l.x * uz,
      z: l.x * uy - l.y * ux,
    },
  };
}

/**
 * Compute the `samples` cone sample directions around the unit light
 * direction (f64 math, f32-rounded components) for ONE kernel variant:
 *
 *     dir_i = normalize(L + U * px_i * angularRadius + V * py_i * angularRadius)
 *
 * where `(px_i, py_i)` is the i-th unit-disk Vogel point of the variant —
 * the base pattern rotated by `variant * KERNEL_VARIANT_ROTATION` (variant 0
 * reproduces the unrotated #41 pattern) — and `angularRadius` is the light's
 * angular radius in radians (small-cone approximation). The result is
 * tightly packed `[x0, y0, z0, x1, ...]` — the EXACT array the GPU uniform
 * packs per variant, so both backends march identical directions.
 */
export function computeSoftSampleDirections(
  lightDirection: XYZ,
  angularRadius: number,
  samples: number,
  variant = 0,
): Float32Array {
  const n = Math.max(1, Math.min(SHADOW_MAX_SAMPLES, Math.floor(samples)));
  const radius = sanitizeAngularRadius(angularRadius);
  const out = new Float32Array(n * 3);
  if (radius <= 0) {
    // Degenerate cone: every direction collapses to L itself (the caller
    // normally selects the hard path before reaching here).
    for (let i = 0; i < n; i++) {
      out[i * 3] = Math.fround(lightDirection.x);
      out[i * 3 + 1] = Math.fround(lightDirection.y);
      out[i * 3 + 2] = Math.fround(lightDirection.z);
    }
    return out;
  }
  const { u, v } = orthoBasis(lightDirection);
  const rotation = variant * KERNEL_VARIANT_ROTATION;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  for (let i = 0; i < n; i++) {
    const d = diskSample(i, n);
    // Rotate the disk point BEFORE scaling: same radii, rotated pattern.
    const px = d.x * cosR - d.y * sinR;
    const py = d.x * sinR + d.y * cosR;
    const kx = px * radius;
    const ky = py * radius;
    let dx = lightDirection.x + u.x * kx + v.x * ky;
    let dy = lightDirection.y + u.y * kx + v.y * ky;
    let dz = lightDirection.z + u.z * kx + v.z * ky;
    const len = Math.hypot(dx, dy, dz);
    dx /= len;
    dy /= len;
    dz /= len;
    out[i * 3] = Math.fround(dx);
    out[i * 3 + 1] = Math.fround(dy);
    out[i * 3 + 2] = Math.fround(dz);
  }
  return out;
}

/**
 * #43 precompute ALL kernel variants' direction arrays for one soft-light
 * configuration. Entry `v` is `computeSoftSampleDirections(light, radius,
 * samples, v)` — computed on the HOST in f64 and f32-rounded once, so the
 * CPU oracle and the GPU uniform consume byte-identical directions and raw
 * visibility keeps its exact cross-backend parity while each texel hashes to
 * its own deterministic variant.
 */
export function computeSoftSampleDirectionVariants(
  lightDirection: XYZ,
  angularRadius: number,
  samples: number,
): Float32Array[] {
  const variants: Float32Array[] = new Array(SHADOW_KERNEL_VARIANTS);
  for (let v = 0; v < SHADOW_KERNEL_VARIANTS; v++) {
    variants[v] = computeSoftSampleDirections(lightDirection, angularRadius, samples, v);
  }
  return variants;
}
