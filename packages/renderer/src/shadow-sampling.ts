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

/** Golden angle (radians) driving the deterministic Vogel sunflower disk. */
const GOLDEN_ANGLE = 2.399963229728653;

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
 * direction (f64 math, f32-rounded components):
 *
 *     dir_i = normalize(L + U * px_i * angularRadius + V * py_i * angularRadius)
 *
 * where `(px_i, py_i)` is the i-th unit-disk Vogel point and `angularRadius`
 * is the light's angular radius in radians (small-cone approximation). The
 * result is tightly packed `[x0, y0, z0, x1, ...]` — the EXACT array the GPU
 * uniform packs, so both backends march identical directions.
 */
export function computeSoftSampleDirections(
  lightDirection: XYZ,
  angularRadius: number,
  samples: number,
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
  for (let i = 0; i < n; i++) {
    const d = diskSample(i, n);
    const kx = d.x * radius;
    const ky = d.y * radius;
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
