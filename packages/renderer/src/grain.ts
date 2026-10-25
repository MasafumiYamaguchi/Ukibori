/** A surface-local roughness variation. Scale is a cell width in scene units. */
export interface GrainMaterial {
  scale?: number;
  strength?: number;
  seed?: number;
}
export interface EffectiveGrain { scale: number; strength: number; seed: number }
const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.fround(typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
export function sanitizeGrain(value: GrainMaterial | undefined): EffectiveGrain | undefined {
  if (!value) return undefined;
  const strength = bounded(value.strength, 0.3, 0, 1);
  if (strength === 0) return undefined;
  return { scale: bounded(value.scale, 3, 0.0001, 10000), strength,
    seed: typeof value.seed === "number" && Number.isFinite(value.seed) ? value.seed >>> 0 : 0 };
}
const f = Math.fround;
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return f((h & 65535) / 65535);
}
const lerp = (a: number, b: number, t: number) => f(a + f(f(b - a) * t));
const smooth = (t: number) => f(f(t * t) * f(3 - f(2 * t)));
/** f32 arithmetic and u32 hash mirror grain-wgsl.ts. No time input. */
export function grainRoughness(roughness: number, x: number, y: number, grain: EffectiveGrain, dpr = 1): number {
  // Periodic wrapping bounds integer conversion identically in JS and WGSL.
  const wrap = (v: number) => { const q = f(f(v) / grain.scale); return f(q - f(Math.floor(f(q / 4096)) * 4096)); };
  const u = wrap(x), v = wrap(y), ix = Math.floor(u), iy = Math.floor(v);
  const tx = smooth(f(u - ix)), ty = smooth(f(v - iy));
  const n = lerp(lerp(hash(ix, iy, grain.seed), hash((ix + 1) % 4096, iy, grain.seed), tx),
    lerp(hash(ix, (iy + 1) % 4096, grain.seed), hash((ix + 1) % 4096, (iy + 1) % 4096, grain.seed), tx), ty);
  // Fade unresolved cells to the original material; no temporal jitter.
  const filter = Math.min(1, Math.max(0, f(f(f(grain.scale * dpr) - 1) / 3)));
  return Math.min(1, Math.max(0, f(f(roughness) + f(f(f(n - 0.5) * grain.strength) * filter))));
}
